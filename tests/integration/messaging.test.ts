import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  type SQSClient,
} from "@aws-sdk/client-sqs";
import ormConfig from "../../mikro-orm.config";
import { CreateWallet } from "../../src/application/use-cases/create-wallet";
import {
  SubmitTransaction,
  type SubmitTransactionCommand,
} from "../../src/application/use-cases/submit-transaction";
import { ReprocessPendingReferences } from "../../src/application/use-cases/reprocess-pending-references";
import { WagerTransactionConsumer, CONSUMER_NAME } from "../../src/infrastructure/messaging/sqs-consumer";
import { OutboxPublisher } from "../../src/infrastructure/messaging/outbox-publisher";
import { ensureQueues } from "../../src/infrastructure/messaging/queues";
import { createSqsClient, QUEUE_URLS } from "../../src/infrastructure/messaging/sqs-client";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/unit-of-work";
import { StdoutLogger } from "../../src/infrastructure/observability/stdout-logger";
import { InMemoryMetrics } from "../../src/infrastructure/observability/in-memory-metrics";
import { WagerTransactionKind, WagerTransactionStatus, FailureCode } from "../../src/domain/wager-transaction";
import { WagerTransactionEntity } from "../../src/infrastructure/persistence/entities/wager-transaction.entity";
import { InboxMessageEntity } from "../../src/infrastructure/persistence/entities/inbox-message.entity";
import { OutboxMessageEntity } from "../../src/infrastructure/persistence/entities/outbox-message.entity";

// Integração SQS real (LocalStack) + PostgreSQL real (§10/§11/§13):
// inbox e redelivery, publishers concorrentes, DLQ, recuperação após crash
// e worker de referências — sem mocks (§14).

let orm: MikroORM;
let sqs: SQSClient;
let createWallet: CreateWallet;
let submit: SubmitTransaction;
let consumer: WagerTransactionConsumer;
let publisher: OutboxPublisher;
let reprocessor: ReprocessPendingReferences;

const fresh = () => orm.em.fork();
const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f101";
const PROVIDER = "provider-a";

beforeAll(async () => {
  orm = await MikroORM.init(ormConfig);
  sqs = createSqsClient();
  await ensureQueues(sqs); // mesmas filas do runtime — setup idempotente
  const uow = new MikroOrmUnitOfWork(orm);
  createWallet = new CreateWallet(uow);
  submit = new SubmitTransaction(uow);
  const metrics = new InMemoryMetrics();
  const logger = new StdoutLogger();
  consumer = new WagerTransactionConsumer(sqs, submit, logger, metrics);
  publisher = new OutboxPublisher(sqs, uow, logger, metrics);
  reprocessor = new ReprocessPendingReferences(uow, submit);
});

beforeEach(async () => {
  await orm.em.getConnection().execute(
    `truncate table wallet_ledger_entries, wager_transactions, outbox_messages, inbox_messages, wallets cascade`,
  );
  // filas zeradas: nada do teste anterior contamina o próximo
  for (const QueueUrl of [QUEUE_URLS.inbound, QUEUE_URLS.dlq, QUEUE_URLS.events])
    await sqs.send(new PurgeQueueCommand({ QueueUrl }));
});

afterAll(async () => {
  await orm.close(true);
});

/** wallet criada pelo use case real; limpa outbox por padrão (isolamento) */
async function novaWallet(initial: string, keepOutbox = false): Promise<string> {
  const created = await createWallet.execute({
    playerId: PLAYER,
    initialBalance: { amount: initial, currency: "BRL" },
  });
  if (!keepOutbox) await orm.em.getConnection().execute(`delete from outbox_messages`);
  return created.id;
}

type QueueCommand = Omit<SubmitTransactionCommand, "delivery">;

function betCommand(walletId: string, external: string, amount = "20.00"): QueueCommand {
  return {
    idempotencyKey: `${PROVIDER}:${external}`,
    providerId: PROVIDER,
    externalTransactionId: external,
    playerId: PLAYER,
    walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: "BRL" },
  };
}

/** envelope da §10: { messageId, type, occurredAt, data } */
function envelope(data: Record<string, unknown>): string {
  return JSON.stringify({
    messageId: crypto.randomUUID(),
    type: "WagerTransactionSubmitted",
    occurredAt: new Date().toISOString(),
    data,
  });
}

async function sendInbound(body: string, dedupId = crypto.randomUUID()): Promise<void> {
  await sqs.send(new SendMessageCommand({
    QueueUrl: QUEUE_URLS.inbound,
    MessageBody: body,
    MessageGroupId: "g1",
    MessageDeduplicationId: dedupId,
  }));
}

async function receiveAll(QueueUrl: string, max = 10): Promise<{ Body?: string }[]> {
  const result = await sqs.send(new ReceiveMessageCommand({
    QueueUrl, MaxNumberOfMessages: max, WaitTimeSeconds: 0, VisibilityTimeout: 0,
  }));
  return result.Messages ?? [];
}

function balanceOf(walletId: string): Promise<{ toJSON(): { amount: string; currency: string } }> {
  return new MikroOrmUnitOfWork(orm)
    .run((session) => session.ledgerEntries.calculateBalance(walletId, "BRL"));
}

describe("consumidor SQS (seção 10)", () => {
  test("efeitos + inbox na MESMA transação e ack somente após commit", async () => {
    const walletId = await novaWallet("100.00");
    await sendInbound(envelope(betCommand(walletId, "bet-1")));

    expect(await consumer.processAvailable()).toBe(1);

    // efeito aplicado pelo MESMO use case da borda HTTP
    const tx = await fresh().findOne(WagerTransactionEntity, { externalTransactionId: "bet-1" });
    expect(tx?.status).toBe(WagerTransactionStatus.Processed);

    // inbox persistente gravada junto com os efeitos (§6.5)
    expect(await fresh().count(InboxMessageEntity, { consumerName: CONSUMER_NAME })).toBe(1);

    // eventos atômicos com o commit (§11)
    const events = await fresh().find(OutboxMessageEntity, {});
    expect(events.map((e) => e.eventType).sort())
      .toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]);

    // ack: nada restou na fila de entrada
    expect(await receiveAll(QUEUE_URLS.inbound)).toHaveLength(0);
  });

  test("redelivery da MESMA mensagem: inbox deduplica, efeito aplica 1x", async () => {
    const walletId = await novaWallet("100.00");
    const command: SubmitTransactionCommand = {
      ...betCommand(walletId, "bet-1"),
      delivery: { messageId: "sqs-msg-1", consumerName: CONSUMER_NAME },
    };

    const first = await submit.execute(command);
    const second = await submit.execute(command); // reentrega simulada

    expect(second.idempotentReplay).toBe(true);
    expect(second.transactionId).toBe(first.transactionId);
    expect(await fresh().count(InboxMessageEntity, { consumerName: CONSUMER_NAME })).toBe(1);
    // um único débito no ledger
    expect((await balanceOf(walletId)).toJSON())
      .toEqual({ amount: "80.00", currency: "BRL" });
  });

  test("duas mensagens diferentes com a MESMA operação → replay pela idempotency key", async () => {
    const walletId = await novaWallet("100.00");
    const body = envelope(betCommand(walletId, "bet-1"));

    await sendInbound(body);
    await consumer.processAvailable();
    await sendInbound(body); // outra mensagem, mesma operação lógica
    await consumer.processAvailable();

    // duas mensagens vistas (inbox = 2), um único efeito (ledger = 1 débito)
    expect(await fresh().count(InboxMessageEntity, { consumerName: CONSUMER_NAME })).toBe(2);
    expect((await balanceOf(walletId)).toJSON())
      .toEqual({ amount: "80.00", currency: "BRL" });
  });

  test("REJECTED de negócio é terminal: ack, sem efeito e evento via outbox", async () => {
    const walletId = await novaWallet("100.00");
    await sendInbound(envelope(betCommand(walletId, "bet-rico", "999.00")));

    await consumer.processAvailable();

    const tx = await fresh().findOne(WagerTransactionEntity, { externalTransactionId: "bet-rico" });
    expect(tx?.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx?.failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE);
    expect(await receiveAll(QUEUE_URLS.inbound)).toHaveLength(0); // ack: é resposta, não falha
    const events = await fresh().find(OutboxMessageEntity, {});
    expect(events.map((e) => e.eventType)).toContain("WagerTransactionRejected");
  });

  test("payload permanente (malformado / OPENING) → DLQ e ack da original", async () => {
    const walletId = await novaWallet("100.00");
    await sendInbound(JSON.stringify({ data: { kind: "OPENING", walletId } })); // não recuperável
    await sendInbound("not-even-json");

    expect(await consumer.processAvailable()).toBe(2);

    expect(await receiveAll(QUEUE_URLS.dlq)).toHaveLength(2);
    expect(await receiveAll(QUEUE_URLS.inbound)).toHaveLength(0); // originals confirmados
  });

  test("SIGTERM: stop() conclui a mensagem em andamento antes de sair", async () => {
    const walletId = await novaWallet("100.00");
    await sendInbound(envelope(betCommand(walletId, "bet-sigterm")));

    const loop = consumer.start(60_000); // só o 1º passe roda (poll alto)
    consumer.stop();
    await loop; // aguarda o passe em andamento terminar

    const tx = await fresh().findOne(WagerTransactionEntity, { externalTransactionId: "bet-sigterm" });
    expect(tx?.status).toBe(WagerTransactionStatus.Processed);
  });
});

describe("outbox worker (seção 11)", () => {
  test("worker morto após commit: outra instância assume e publica os eventos", async () => {
    // PG commit → processo morre antes de publicar → nada foi às filas
    await createWallet.execute({
      playerId: PLAYER, initialBalance: { amount: "100.00", currency: "BRL" },
    });

    const published = await publisher.publishOnce();
    expect(published).toBe(2); // WagerTransactionProcessed + WalletBalanceChanged

    const events = await receiveAll(QUEUE_URLS.events);
    expect(events).toHaveLength(2);
    const parsed = events.map((m) => JSON.parse(m!.Body!)) as {
      eventType: string; version: number;
      data: { balanceAfter?: { amount: string; currency: string } };
    }[];
    const changed = parsed.find((e) => e.eventType === "WalletBalanceChanged");
    expect(changed?.version).toBe(1);
    expect(changed?.data.balanceAfter).toEqual({ amount: "100.00", currency: "BRL" });

    // publicação duplicada segura: segunda passada não republica o mesmo evento
    expect(await publisher.publishOnce()).toBe(0);
  });

  test("dois publishers concorrentes: SKIP LOCKED — sem perda e sem duplicata", async () => {
    // 4 wallets → 8 eventos pendentes (WagerTransactionProcessed + WalletBalanceChanged)
    for (let i = 0; i < 4; i++) {
      await createWallet.execute({
        playerId: crypto.randomUUID(), initialBalance: { amount: "50.00", currency: "BRL" },
      });
    }

    const [a, b] = await Promise.all([publisher.publishOnce(10), publisher.publishOnce(10)]);
    expect(a + b).toBe(8); // nenhum evento perdido

    const events = await receiveAll(QUEUE_URLS.events, 10);
    const bodies = new Set(events.map((m) => m!.Body));
    expect(bodies.size).toBe(8); // nenhuma duplicata no fluxo normal
  });

  test("claim agenda attempts e backoff — re-claim imediato acha nada vencido", async () => {
    await createWallet.execute({
      playerId: PLAYER, initialBalance: { amount: "10.00", currency: "BRL" },
    });

    const claimed = await new MikroOrmUnitOfWork(orm)
      .run((session) => session.outbox.claimDue(new Date(), 10));
    expect(claimed).toHaveLength(2);

    // attempts=1 e próximo vencimento no futuro: o backoff É a claim (§11)
    const rows = await fresh().find(OutboxMessageEntity, {});
    expect(rows.every((r) => r.attempts === 1)).toBe(true);
    expect(rows.every((r) => r.nextAttemptAt != null && r.nextAttemptAt > new Date())).toBe(true);

    // outra instância reivindicando agora não enxerga nada vencido
    const second = await new MikroOrmUnitOfWork(orm)
      .run((session) => session.outbox.claimDue(new Date(), 10));
    expect(second).toHaveLength(0);
  });
});

describe("worker de referências fora de ordem (seção 7.1)", () => {
  test("REFUND chegou antes do BET: BET entrega pela fila, worker resolve o pendente", async () => {
    const walletId = await novaWallet("100.00");
    const refund = await submit.execute({
      idempotencyKey: `${PROVIDER}:refund-1`,
      providerId: PROVIDER,
      externalTransactionId: "refund-1",
      playerId: PLAYER,
      walletId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Refund,
      money: { amount: "20.00", currency: "BRL" },
      referenceExternalTransactionId: "bet-1",
    });
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    // a BET chega pela fila (§10) e é processada normalmente
    await sendInbound(envelope(betCommand(walletId, "bet-1", "20.00")));
    await consumer.processAvailable();

    // worker resolve o pendente com as MESMAS regras do submit (§7.1)
    const counts = await reprocessor.tick();
    expect(counts.resolved).toBe(1);

    const resolved = await fresh().findOne(WagerTransactionEntity, { id: refund.transactionId });
    expect(resolved?.status).toBe(WagerTransactionStatus.Processed);

    // saldo: 100 - 20 (bet) + 20 (refund) = 100 — ledger consistente
    expect((await balanceOf(walletId)).toJSON())
      .toEqual({ amount: "100.00", currency: "BRL" });
  });

  test("TTL esgotado → REJECTED REFERENCE_NOT_FOUND + evento (§7.1)", async () => {
    const walletId = await novaWallet("100.00");
    const refund = await submit.execute({
      idempotencyKey: `${PROVIDER}:refund-orf`,
      providerId: PROVIDER,
      externalTransactionId: "refund-orf",
      playerId: PLAYER,
      walletId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Refund,
      money: { amount: "10.00", currency: "BRL" },
      referenceExternalTransactionId: "bet-nunca-chega",
    });
    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);

    const counts = await reprocessor.tick({ ttlMs: -1 }); // TTL já esgotado
    expect(counts.rejected).toBe(1);

    const rejected = await fresh().findOne(WagerTransactionEntity, { id: refund.transactionId });
    expect(rejected?.status).toBe(WagerTransactionStatus.Rejected);
    expect(rejected?.failureCode).toBe(FailureCode.REFERENCE_NOT_FOUND);
    const events = await fresh().find(OutboxMessageEntity, {});
    expect(events.map((e) => e.eventType)).toContain("WagerTransactionRejected");
  });
});
