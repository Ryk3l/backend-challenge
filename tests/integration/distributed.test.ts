import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import {
  DeleteMessageCommand,
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
import { ReconcileWallet } from "../../src/application/use-cases/reconcile-wallet";
import { WagerTransactionConsumer, CONSUMER_NAME } from "../../src/infrastructure/messaging/sqs-consumer";
import { OutboxPublisher } from "../../src/infrastructure/messaging/outbox-publisher";
import { ensureQueues } from "../../src/infrastructure/messaging/queues";
import { createSqsClient, QUEUE_URLS } from "../../src/infrastructure/messaging/sqs-client";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/unit-of-work";
import { InMemoryMetrics } from "../../src/infrastructure/observability/in-memory-metrics";
import { SilentLogger } from "../../src/infrastructure/observability/stdout-logger";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wager-transaction";
import { WagerTransactionEntity } from "../../src/infrastructure/persistence/entities/wager-transaction.entity";
import { InboxMessageEntity } from "../../src/infrastructure/persistence/entities/inbox-message.entity";
import { OutboxMessageEntity } from "../../src/infrastructure/persistence/entities/outbox-message.entity";

// Suíte da §13 dedicada aos cenários de DISTRIBUIÇÃO e RESILIÊNCIA:
//
//   3. wallets distintas processadas em paralelo
//   4. >= 3 instâncias simultâneas (pool de conexões e workers próprios)
//   5. worker morto DEPOIS do commit e ANTES do ack
//   8. reinício do serviço com comprovação da consistência final
//
// e o invariante final exigido: wallet.balance == saldo reconstruído pelo ledger.
//
// NOTA DE HONESTIDADE: "instância" aqui é um MikroORM + UnitOfWork + workers
// independentes (pool de conexões e identity map próprios), compartilhando o
// MESMO PostgreSQL e o MESMO LocalStack. É o que garante lost updates, SKIP
// LOCKED e corrida de inbox de verdade. Um teste com processos OS separados
// (docker compose up --scale) é o complemento manual descrito no README.

let orm: MikroORM;
let sqs: SQSClient;
let createWallet: CreateWallet;
let reconcile: ReconcileWallet;

const PROVIDER = "provider-a";

beforeAll(async () => {
  orm = await MikroORM.init(ormConfig);
  sqs = createSqsClient();
  await ensureQueues(sqs);
  const uow = new MikroOrmUnitOfWork(orm);
  createWallet = new CreateWallet(uow);
  reconcile = new ReconcileWallet(uow, new SilentLogger(), new InMemoryMetrics());
});

beforeEach(async () => {
  await orm.em.getConnection().execute(
    `truncate table wallet_ledger_entries, wager_transactions, outbox_messages, inbox_messages, wallets cascade`,
  );
  for (const QueueUrl of [QUEUE_URLS.inbound, QUEUE_URLS.dlq, QUEUE_URLS.events])
    await sqs.send(new PurgeQueueCommand({ QueueUrl }));
});

afterAll(async () => {
  await orm.close(true);
});

/** invariante final da §13: saldo materializado == saldo reconstruído pelo ledger */
async function expectConsistent(walletId: string): Promise<void> {
  const result = await reconcile.execute(walletId);
  expect(result.consistent).toBe(true);
  expect(result.difference).toEqual({ amount: "0.00", currency: "BRL" });
}

async function novaWallet(initial: string): Promise<{ walletId: string; playerId: string }> {
  const playerId = crypto.randomUUID();
  const created = await createWallet.execute({
    playerId,
    initialBalance: { amount: initial, currency: "BRL" },
  });
  await orm.em.getConnection().execute(`delete from outbox_messages`); // isolamento
  return { walletId: created.id, playerId };
}

type QueueCommand = Omit<SubmitTransactionCommand, "delivery">;

function betCommand(
  walletId: string,
  playerId: string,
  external: string,
  amount = "20.00",
): QueueCommand {
  return {
    idempotencyKey: `${PROVIDER}:${external}`,
    providerId: PROVIDER,
    externalTransactionId: external,
    playerId,
    walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: { amount, currency: "BRL" },
  };
}

function envelope(data: Record<string, unknown>): string {
  return JSON.stringify({
    messageId: crypto.randomUUID(),
    type: "WagerTransactionSubmitted",
    occurredAt: new Date().toISOString(),
    data,
  });
}

/**
 * FIFO ordena DENTRO de um grupo; paralelismo real entre consumidores exige
 * grupos distintos. Cada mensagem ganha o seu MessageGroupId.
 */
async function sendInbound(body: string, groupId = crypto.randomUUID()): Promise<void> {
  await sqs.send(new SendMessageCommand({
    QueueUrl: QUEUE_URLS.inbound,
    MessageBody: body,
    MessageGroupId: groupId,
    MessageDeduplicationId: crypto.randomUUID(),
  }));
}

/**
 * Recebe e apaga (ack) — o que a produção faz após o commit. VisibilityTimeout
 * alto, não 0: com 0 a mensagem fica visível na hora, o ReceiptHandle expira e o
 * Delete falha; e um loop de drenagem releria as mesmas mensagens para sempre.
 */
async function receiveAndDelete(QueueUrl: string, max = 10): Promise<{ Body?: string }[]> {
  const result = await sqs.send(new ReceiveMessageCommand({
    QueueUrl, MaxNumberOfMessages: max, WaitTimeSeconds: 0, VisibilityTimeout: 30,
  }));
  const messages = result.Messages ?? [];
  await Promise.all(messages.map(async (message) => {
    try {
      await sqs.send(new DeleteMessageCommand({ QueueUrl, ReceiptHandle: message.ReceiptHandle! }));
    } catch {
      // best-effort: o teste asserta o CONTEÚDO recebido, não o ack em si
    }
  }));
  return messages;
}

/**
 * Uma "instância" independente: EntityManager próprio (identity map separado,
 * que é o que impede duas transações concorrentes de enxergarem o estado uma
 * da outra) sobre o MESMO banco. O pool de conexões é compartilhado pelo
 * MikroORM — as conexões são adquiridas por transação, então o banco enxerga
 * transações genuinamente concorrentes de todos os EMs.
 */
function makeInstance() {
  const em = orm.em.fork();
  const uow = new MikroOrmUnitOfWork(orm);
  const submit = new SubmitTransaction(uow, new SilentLogger(), new InMemoryMetrics());
  const client = createSqsClient();
  const logger = new SilentLogger();
  const metrics = new InMemoryMetrics();
  return {
    em,
    submit,
    consumer: new WagerTransactionConsumer(client, submit, logger, metrics),
    publisher: new OutboxPublisher(client, uow, logger, metrics),
  };
}

describe("§13 — distribuição e resiliência", () => {
  test("3. wallets distintas processadas em paralelo — sem interferência entre elas", async () => {
    const wallets = await Promise.all(Array.from({ length: 8 }, () => novaWallet("100.00")));

    // 4 apostas por wallet, todas as 32 em voo ao mesmo tempo
    const sends = wallets.flatMap(({ walletId, playerId }, w) =>
      Array.from({ length: 4 }, (_, i) =>
        sendInbound(envelope(betCommand(walletId, playerId, `bet-${w}-${i}`)))),
    );
    await Promise.all(sends);

    const a = makeInstance();
    const b = makeInstance();
    const c = makeInstance();
    try {
      // 3 instâncias sobre a MESMA fila, um teto único partilhado: as 32
      // mensagens somem da fila no total, não 32 cada
      const remaining = { value: wallets.length * 4 };
      await Promise.all([
        drain(a.consumer, remaining),
        drain(b.consumer, remaining),
        drain(c.consumer, remaining),
      ]);

      // nenhuma wallet interferiu na outra: todas com o mesmo saldo final
      for (const { walletId } of wallets) {
        const result = await reconcile.execute(walletId);
        expect(result.storedBalance).toEqual({ amount: "20.00", currency: "BRL" });
        await expectConsistent(walletId);
      }

      // 32 apostas no total, uma por mensagem — nada duplicado nem perdido.
      // Filtro por kind: cada wallet nasce com uma transação OPENING própria,
      // que não é aposta e não deve entrar nesta contagem.
      expect(await freshCount(WagerTransactionEntity, { kind: WagerTransactionKind.Bet })).toBe(32);
    } finally {
      // nada a fechar: os EMs de fork() não retêm recursos fora do pool
      a.em.clear(); b.em.clear(); c.em.clear();
    }
  });

  test("4. três instâncias simultâneas: consumidores e publishers disputam as mesmas filas", async () => {
    const wallets = await Promise.all(Array.from({ length: 6 }, () => novaWallet("100.00")));

    // comandos pela fila + eventos já gravados na outbox (via CreateWallet acima
    // e os submits abaixo)
    await Promise.all(wallets.flatMap(({ walletId, playerId }, w) =>
      Array.from({ length: 3 }, (_, i) =>
        sendInbound(envelope(betCommand(walletId, playerId, `m-${w}-${i}`)))),
    ));

    const instances = [makeInstance(), makeInstance(), makeInstance()];
    try {
      const total = wallets.length * 3;

      // 3 consumidores drenam a mesma fila, um teto único partilhado: as 18
      // mensagens somem da fila no total, não 18 cada
      const remaining = { value: total };
      await Promise.all(instances.map((it) => drain(it.consumer, remaining)));

      // nenhuma transação de aposta aplicada duas vezes (inbox + idempotency
      // key); OPENINGs de criação de wallet ficam fora desta contagem
      expect(await freshCount(WagerTransactionEntity, { kind: WagerTransactionKind.Bet })).toBe(total);

      // 3 publishers sobre a MESMA outbox: o FOR UPDATE SKIP LOCKED da §11 é o
      // que se exercita aqui — cada claim pega um lote DIFERENTE. Rodam depois
      // do consumo porque a outbox só existe quando os consumers gravam os
      // efeitos; publicar em paralelo seria corrida com a própria escrita.
      await Promise.all(instances.map((it) => drainPublishers(it.publisher)));

      // nenhuma wallet divergente
      for (const { walletId } of wallets) await expectConsistent(walletId);

      // todos os eventos foram publicados exatamente 1x (sem perda, sem duplicata)
      const keys = await drainEvents();
      expect(keys.length).toBe(wallets.length * 3 * 2); // 2 eventos por BET
      expect(new Set(keys).size).toBe(keys.length);     // sem duplicata
      expect(await pendingOutbox()).toBe(0);             // sem perda
    } finally {
      for (const it of instances) it.em.clear();
    }
  });

  test("5. worker morto DEPOIS do commit e ANTES do ack: redelivery não aplica o efeito de novo", async () => {
    const { walletId, playerId } = await novaWallet("100.00");
    const command = betCommand(walletId, playerId, "bet-crash");

    // envia e devolve o MessageId REAL do SQS — é a chave da inbox
    const sent = await sqs.send(new SendMessageCommand({
      QueueUrl: QUEUE_URLS.inbound,
      MessageBody: envelope(command),
      MessageGroupId: "crash",
      MessageDeduplicationId: crypto.randomUUID(),
    }));
    const messageId = sent.MessageId!;

    // "instância A" processa: transação dos efeitos (wallet + ledger + inbox +
    // outbox) CONFIRMA, mas o processo morre antes do DeleteMessage → ack
    const a = makeInstance();
    const result = await a.submit.execute({
      ...command,
      delivery: { messageId, consumerName: CONSUMER_NAME },
    });
    expect(result.status).toBe(WagerTransactionStatus.Processed);
    a.em.clear(); // morte pós-commit, pré-ack: a mensagem SEGUE na fila

    // a "instância B" reentrega a MESMA mensagem — ela nunca foi deletada, então
    // segue visível na fila (na produção, a visibility timeout expiraria)
    const b = makeInstance();
    try {
      await drain(b.consumer, { value: 1 });

      // o efeito não se repetiu: um único débito, uma única transação
      const txs = await b.em.find(WagerTransactionEntity, { externalTransactionId: "bet-crash" });
      expect(txs).toHaveLength(1);
      expect(await b.em.count(InboxMessageEntity, { consumerName: CONSUMER_NAME })).toBe(1);

      const rec = await reconcile.execute(walletId);
      expect(rec.storedBalance).toEqual({ amount: "80.00", currency: "BRL" });
      await expectConsistent(walletId);

      // e desta vez o ack aconteceu: fila vazia
      expect(await receiveAndDelete(QUEUE_URLS.inbound)).toHaveLength(0);
    } finally {
      b.em.clear();
    }
  });

  test("8. reinício do serviço: estado durável sobrevive e a consistência final se sustenta", async () => {
    const wallets = await Promise.all(Array.from({ length: 4 }, () => novaWallet("100.00")));

    // tráfego processado ANTES do reinício; a outbox fica com eventos por
    // publicar porque o publisher de antes morre sem concluí-los
    await Promise.all(wallets.flatMap(({ walletId, playerId }, w) =>
      Array.from({ length: 2 }, (_, i) =>
        sendInbound(envelope(betCommand(walletId, playerId, `pre-${w}-${i}`)))),
    ));
    const before = makeInstance();
    await drain(before.consumer, { value: wallets.length * 2 });
    before.em.clear(); // "reinício": descarta o estado em memória; o estado real é do banco

    // "depois do reinício": instâncias novas, sem nenhum estado em memória
    const after = makeInstance();
    try {
      // o que ficou pendente sobrevive: a outbox tem eventos por publicar
      expect(await pendingOutbox()).toBeGreaterThan(0);

      // os workers de após-reinício concluem o que faltou
      await drainPublishers(after.publisher);

      // nada mais pendente e nenhuma wallet divergente
      expect(await pendingOutbox()).toBe(0);
      for (const { walletId } of wallets) {
        const rec = await reconcile.execute(walletId);
        expect(rec.storedBalance).toEqual({ amount: "60.00", currency: "BRL" });
        await expectConsistent(walletId);
      }

      // eventos publicados cobrem exatamente o que foi aplicado (sem duplicata
      // por causa do publishedAt; sem perda por causa do claim)
      const keys = await drainEvents();
      expect(keys.length).toBe(wallets.length * 2 * 2); // 2 eventos por BET
      expect(new Set(keys).size).toBe(keys.length);
    } finally {
      after.em.clear();
    }
  });
});

function freshCount(entity: typeof WagerTransactionEntity, where?: object): Promise<number>;
function freshCount(entity: typeof InboxMessageEntity, where?: object): Promise<number>;
function freshCount(entity: typeof OutboxMessageEntity, where?: object): Promise<number>;
function freshCount(entity: unknown, where: object = {}): Promise<number> {
  return orm.em.fork().count(entity as never, where);
}

async function pendingOutbox(): Promise<number> {
  return orm.em.fork().count(OutboxMessageEntity, { publishedAt: null });
}

/**
 * Consome até o teto global ser atingido ou o deadline expirar.
 *
 * O teto é PARTILHADO entre as instâncias (via `remaining`): com 3 consumidores
 * em paralelo sobre uma FIFO, um deles drena tudo e os outros não podem ficar
 * esperando `idleRounds` polls de 1s cada — isso estourava o timeout do teste.
 * O `deadline` é a rede de segurança final: fila realmente vazia, mas ainda
 * há teto sobrando, o teste para em vez de esperar para sempre.
 */
async function drain(
  consumer: WagerTransactionConsumer,
  remaining: { value: number },
  deadline = Date.now() + 2_500,
): Promise<void> {
  while (remaining.value > 0 && Date.now() < deadline) {
    const n = await consumer.processAvailable(Math.min(10, remaining.value));
    if (n === 0) {
      // fila vazia neste instante: nada a processar agora, mas pode chegar —
      // cedo um poll sem wait para não pagar 1s por rodada ociosa
      await new Promise((resolve) => setTimeout(resolve, 25));
      continue;
    }
    remaining.value -= n;
  }
}

/**
 * Drena a outbox até não sobrar nada publicável.
 *
 * A claim agenda `nextAttemptAt` 1s à frente (backoff da §11), então rodar
 * `publishOnce` em loop sem esperar enxerga "nada devido" logo na segunda
 * iteração e desiste com a fila ainda cheia. Entre as tentativas dormimos o
 * backoff base — o mesmo que o publisher de produção esperaria.
 */
async function drainPublishers(publisher: OutboxPublisher): Promise<void> {
  for (let i = 0; i < 20; i++) {
    if ((await publisher.publishOnce(10)) === 0) return;
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
}

/** consome a fila de eventos até vaziar, devolvendo os eventId únicos vistos */
async function drainEvents(): Promise<string[]> {
  const keys: string[] = [];
  for (let round = 0; round < 20; round++) {
    const batch = await receiveAndDelete(QUEUE_URLS.events, 10);
    if (batch.length === 0) break;
    for (const message of batch)
      keys.push((JSON.parse(message!.Body!) as { eventId: string }).eventId);
  }
  return keys;
}
