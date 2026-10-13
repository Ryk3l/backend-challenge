import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import ormConfig from "../../mikro-orm.config";
import { CreateWallet } from "../../src/application/use-cases/create-wallet";
import {
  SubmitTransaction,
  type SubmitTransactionCommand,
} from "../../src/application/use-cases/submit-transaction";
import { ConflictError, NotFoundError } from "../../src/application/errors";
import {
  InvalidTransactionError,
  WagerTransactionKind,
  WagerTransactionStatus,
  FailureCode,
} from "../../src/domain/wager-transaction";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/unit-of-work";
import { WalletEntity } from "../../src/infrastructure/persistence/entities/wallet.entity";
import { WagerTransactionEntity } from "../../src/infrastructure/persistence/entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { OutboxMessageEntity } from "../../src/infrastructure/persistence/entities/outbox-message.entity";

// Integração com o PostgreSQL real (5433): idempotência, regras da §7 e
// concorrência da §8 contra banco de verdade, sem mocks (§14).

let orm: MikroORM;
let createWallet: CreateWallet;
let submitTransaction: SubmitTransaction;

const fresh = () => orm.em.fork();
const PLAYER = "0192f28f-5dc0-7d58-bdb2-814ad6a0f001";

beforeAll(async () => {
  orm = await MikroORM.init(ormConfig);
  const uow = new MikroOrmUnitOfWork(orm);
  createWallet = new CreateWallet(uow);
  submitTransaction = new SubmitTransaction(uow);
});

beforeEach(async () => {
  await orm.em.getConnection().execute(
    `truncate table wallet_ledger_entries, wager_transactions, outbox_messages, inbox_messages, wallets cascade`,
  );
});

afterAll(async () => {
  await orm.close(true);
});

async function novaWallet(initial: string, playerId = PLAYER): Promise<string> {
  const created = await createWallet.execute({
    playerId,
    initialBalance: { amount: initial, currency: "BRL" },
  });
  // isola os eventos do teste: os da OPENING não interessam aqui
  await orm.em.getConnection().execute(`delete from outbox_messages`);
  return created.id;
}

function comando(walletId: string, extra: Partial<SubmitTransactionCommand> = {}): SubmitTransactionCommand {
  return {
    idempotencyKey: "provider-a:bet-1",
    providerId: "provider-a",
    externalTransactionId: "bet-1",
    playerId: PLAYER,
    walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: WagerTransactionKind.Bet,
    money: { amount: "25.00", currency: "BRL" },
    ...extra,
  };
}

describe("POST /wagering/transactions — regras (seção 7)", () => {
  test("BET debita, gera ledger e eventos; saldo e version mudam juntos", async () => {
    const walletId = await novaWallet("100.00");
    const result = await submitTransaction.execute(comando(walletId));

    expect(result.status).toBe(WagerTransactionStatus.Processed);
    expect(result.balance).toEqual({ amount: "75.00", currency: "BRL" });
    expect(result.idempotentReplay).toBe(false);

    const em = fresh();
    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(wallet.balance).toBe("75.00");
    expect(wallet.version).toBe(2); // bump de version = saldo mudou (§6.2)

    const tx = await em.findOneOrFail(WagerTransactionEntity, { id: result.transactionId });
    expect(tx.status).toBe("PROCESSED");
    expect(tx.observedBalance).toBe("75.00"); // replay devolve este saldo

    // ledger: OPENING (da criação) + o débito desta BET
    const entries = await em.find(WalletLedgerEntryEntity, { wallet: walletId });
    expect(entries).toHaveLength(2);
    const debito = entries.find((e) => e.direction === "DEBIT")!;
    expect(debito.balanceBefore).toBe("100.00");
    expect(debito.balanceAfter).toBe("75.00");

    // outbox limpa na helper: sobra só o evento desta BET
    const events = await em.find(OutboxMessageEntity, { aggregateId: walletId });
    expect(events.map((o) => o.eventType)).toEqual(["WalletBalanceChanged"]);
  });

  test("WIN credita; LOSS registra sem tocar saldo, ledger ou WalletBalanceChanged", async () => {
    const walletId = await novaWallet("100.00");
    const win = await submitTransaction.execute(comando(walletId, {
      idempotencyKey: "provider-a:win-1", externalTransactionId: "win-1",
      kind: WagerTransactionKind.Win,
    }));
    expect(win.status).toBe(WagerTransactionStatus.Processed);
    expect(win.balance.amount).toBe("125.00");

    const loss = await submitTransaction.execute(comando(walletId, {
      idempotencyKey: "provider-a:loss-1", externalTransactionId: "loss-1",
      kind: WagerTransactionKind.Loss,
    }));
    expect(loss.status).toBe(WagerTransactionStatus.Processed);
    expect(loss.balance.amount).toBe("125.00"); // LOSS não move saldo

    const em = fresh();
    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(wallet.balance).toBe("125.00");
    expect(wallet.version).toBe(2); // só o WIN bumpou

    // ledger: OPENING + WIN — LOSS não lança
    const entries = await em.find(WalletLedgerEntryEntity, { wallet: walletId });
    expect(entries).toHaveLength(2);
    expect(entries.every((e) => e.direction === "CREDIT")).toBe(true);

    const events = await em.find(OutboxMessageEntity, { aggregateId: walletId });
    expect(events.map((o) => o.eventType)).toEqual(["WalletBalanceChanged"]); // só do WIN
    const lossEvents = await em.find(OutboxMessageEntity, { aggregateId: loss.transactionId });
    expect(lossEvents.map((o) => o.eventType)).toEqual(["WagerTransactionProcessed"]);
  });

  test("saldo insuficiente → REJECTED auditável, sem ledger e sem efeito", async () => {
    const walletId = await novaWallet("10.00");
    const result = await submitTransaction.execute(comando(walletId)); // BET 25 em wallet 10

    expect(result.status).toBe(WagerTransactionStatus.Rejected);
    expect(result.balance.amount).toBe("10.00"); // saldo observado na rejeição

    const em = fresh();
    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(wallet.balance).toBe("10.00");
    expect(wallet.version).toBe(1); // rejeição não bumpa
    expect(await em.count(WalletLedgerEntryEntity, { wallet: walletId })).toBe(1); // só a OPENING

    const tx = await em.findOneOrFail(WagerTransactionEntity, { id: result.transactionId });
    expect(tx.status).toBe("REJECTED");
    expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE);

    const rejected = await em.find(OutboxMessageEntity, { aggregateId: result.transactionId });
    expect(rejected.map((o) => o.eventType)).toEqual(["WagerTransactionRejected"]);
    // sem saldo alterado → nenhum WalletBalanceChanged
    expect(await em.count(OutboxMessageEntity, { aggregateId: walletId })).toBe(0);
  });

  test("moeda ou player divergente da wallet → REJECTED com failureCode próprio", async () => {
    const walletId = await novaWallet("100.00");

    const usd = await submitTransaction.execute(comando(walletId, {
      idempotencyKey: "provider-a:usd-1", externalTransactionId: "usd-1",
      money: { amount: "25.00", currency: "USD" },
    }));
    expect(usd.status).toBe(WagerTransactionStatus.Rejected);

    const outroPlayer = await submitTransaction.execute(comando(walletId, {
      idempotencyKey: "provider-a:player-1", externalTransactionId: "player-1",
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f002",
    }));
    expect(outroPlayer.status).toBe(WagerTransactionStatus.Rejected);

    const em = fresh();
    const codes = (await em.find(WagerTransactionEntity, { wallet: walletId }))
      .filter((t) => t.failureCode !== null)
      .map((t) => t.failureCode)
      .sort();
    expect(codes).toEqual([FailureCode.CURRENCY_MISMATCH, FailureCode.PLAYER_WALLET_MISMATCH].sort());
    expect((await em.findOneOrFail(WalletEntity, { id: walletId })).balance).toBe("100.00");
  });
});

describe("idempotência persistente (seção 9)", () => {
  test("replay: mesma key + mesmo payload → mesma resposta, idempotentReplay: true", async () => {
    const walletId = await novaWallet("100.00");
    const first = await submitTransaction.execute(comando(walletId));
    const replay = await submitTransaction.execute(comando(walletId));

    expect(replay.idempotentReplay).toBe(true);
    expect(replay.transactionId).toBe(first.transactionId);
    expect(replay.status).toBe(first.status);
    expect(replay.balance).toEqual(first.balance); // saldo observado original

    const em = fresh();
    // OPENING + um único débito — o replay não repete o efeito
    expect(await em.count(WalletLedgerEntryEntity, { wallet: walletId })).toBe(2);
    expect((await em.findOneOrFail(WalletEntity, { id: walletId })).balance).toBe("75.00");
  });

  test("mesma key com payload divergente → conflito, não replay", async () => {
    const walletId = await novaWallet("100.00");
    await submitTransaction.execute(comando(walletId));

    const error = await submitTransaction
      .execute(comando(walletId, { money: { amount: "26.00", currency: "BRL" } }))
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe(FailureCode.IDEMPOTENCY_CONFLICT);
  });

  test("mesma operação lógica sob outra Idempotency-Key → conflito", async () => {
    const walletId = await novaWallet("100.00");
    await submitTransaction.execute(comando(walletId)); // key provider-a:bet-1

    const error = await submitTransaction
      .execute(comando(walletId, { idempotencyKey: "provider-a:outra-key" })) // mesmo external id
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe(FailureCode.IDEMPOTENCY_CONFLICT);
  });

  test("50 envios paralelos da mesma aposta → um único débito e uma única transação", async () => {
    const walletId = await novaWallet("100.00");

    const results = await Promise.all(
      Array.from({ length: 50 }, () => submitTransaction.execute(comando(walletId))),
    );

    expect(new Set(results.map((r) => r.transactionId)).size).toBe(1);
    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(results.every((r) => r.balance.amount === "75.00")).toBe(true);
    expect(results.filter((r) => r.idempotentReplay)).toHaveLength(49);

    const em = fresh();
    expect(await em.count(WalletLedgerEntryEntity, { wallet: walletId, direction: "DEBIT" })).toBe(1);
    expect((await em.findOneOrFail(WalletEntity, { id: walletId })).balance).toBe("75.00");
  });
});

describe("reversões e referências (seção 7)", () => {
  async function betProcessada(walletId: string, ext = "bet-1") {
    return submitTransaction.execute(comando(walletId, {
      externalTransactionId: ext, idempotencyKey: `provider-a:${ext}`,
    }));
  }

  test("REFUND credita a BET uma vez; a segunda é REFERENCE_ALREADY_REVERSED", async () => {
    const walletId = await novaWallet("100.00");
    await betProcessada(walletId); // 100 → 75

    const refund = await submitTransaction.execute(comando(walletId, {
      idempotencyKey: "provider-a:refund-1", externalTransactionId: "refund-1",
      kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "bet-1",
    }));
    expect(refund.status).toBe(WagerTransactionStatus.Processed);
    expect(refund.balance.amount).toBe("100.00"); // 75 + 25

    const denovo = await submitTransaction.execute(comando(walletId, {
      idempotencyKey: "provider-a:refund-2", externalTransactionId: "refund-2",
      kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "bet-1",
    }));
    expect(denovo.status).toBe(WagerTransactionStatus.Rejected);

    const em = fresh();
    const rejeitada = await em.findOneOrFail(WagerTransactionEntity, { id: denovo.transactionId });
    expect(rejeitada.failureCode).toBe(FailureCode.REFERENCE_ALREADY_REVERSED);

    const refundRow = await em.findOneOrFail(WagerTransactionEntity, { id: refund.transactionId });
    expect(refundRow.referenceTransactionId).not.toBeNull(); // aponta para a BET
  });

  test("ROLLBACK inverte o efeito da BET (débito → crédito)", async () => {
    const walletId = await novaWallet("100.00");
    await betProcessada(walletId); // 100 → 75

    const rollback = await submitTransaction.execute(comando(walletId, {
      idempotencyKey: "provider-a:rollback-1", externalTransactionId: "rollback-1",
      kind: WagerTransactionKind.Rollback, referenceExternalTransactionId: "bet-1",
    }));

    expect(rollback.status).toBe(WagerTransactionStatus.Processed);
    expect(rollback.balance.amount).toBe("100.00");

    const em = fresh();
    // OPENING (crédito) + BET (débito) + ROLLBACK (crédito)
    const entries = await em.find(WalletLedgerEntryEntity, { wallet: walletId });
    expect(entries).toHaveLength(3);
    expect(entries.filter((e) => e.direction === "CREDIT")).toHaveLength(2);
    expect(entries.filter((e) => e.direction === "DEBIT")).toHaveLength(1);
  });

  test("reversão com valor diferente da referência → AMOUNT_DIFFERS_FROM_REFERENCE", async () => {
    const walletId = await novaWallet("100.00");
    await betProcessada(walletId);

    const refund = await submitTransaction.execute(comando(walletId, {
      idempotencyKey: "provider-a:refund-9", externalTransactionId: "refund-9",
      kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "bet-1",
      money: { amount: "10.00", currency: "BRL" },
    }));

    expect(refund.status).toBe(WagerTransactionStatus.Rejected);
    const em = fresh();
    const row = await em.findOneOrFail(WagerTransactionEntity, { id: refund.transactionId });
    expect(row.failureCode).toBe(FailureCode.AMOUNT_DIFFERS_FROM_REFERENCE);
  });

  test("REFUND antes da BET → PENDING_REFERENCE + evento; sem efeito no saldo", async () => {
    const walletId = await novaWallet("100.00");

    const refund = await submitTransaction.execute(comando(walletId, {
      idempotencyKey: "provider-a:refund-early", externalTransactionId: "refund-early",
      kind: WagerTransactionKind.Refund, referenceExternalTransactionId: "bet-chegara-depois",
    }));

    expect(refund.status).toBe(WagerTransactionStatus.PendingReference);
    expect(refund.balance.amount).toBe("100.00");

    const em = fresh();
    const row = await em.findOneOrFail(WagerTransactionEntity, { id: refund.transactionId });
    expect(row.status).toBe("PENDING_REFERENCE");
    expect(row.referenceTransactionId).toBeNull();

    const events = await em.find(OutboxMessageEntity, { aggregateId: refund.transactionId });
    expect(events.map((o) => o.eventType)).toEqual(["WagerTransactionPendingReference"]);

    expect((await em.findOneOrFail(WalletEntity, { id: walletId })).balance).toBe("100.00");
    expect(await em.count(WalletLedgerEntryEntity, { wallet: walletId })).toBe(1); // só da OPENING
  });
});

describe("validação de entrada", () => {
  test("OPENING não pode ser submetido", async () => {
    const walletId = await novaWallet("100.00");
    await expect(submitTransaction.execute(comando(walletId, {
      kind: WagerTransactionKind.Opening,
    }))).rejects.toThrow(InvalidTransactionError);
  });

  test("wallet inexistente → not found", async () => {
    await expect(submitTransaction.execute(comando("0192f28f-5dc0-7d58-bdb2-814ad6a0f999")))
      .rejects.toThrow(NotFoundError);
  });
});

describe("concorrência real (seção 8 — cenário obrigatório)", () => {
  test("saldo 100.00 e duas apostas de 80.00 simultâneas → uma PROCESSADA, uma REJECTED, saldo 20.00", async () => {
    const walletId = await novaWallet("100.00");
    const aposta80 = (n: number) => comando(walletId, {
      idempotencyKey: `provider-a:80-${n}`, externalTransactionId: `bet-80-${n}`,
      money: { amount: "80.00", currency: "BRL" },
    });

    const results = await Promise.all([
      submitTransaction.execute(aposta80(1)),
      submitTransaction.execute(aposta80(2)),
    ]);

    const ganhou = results.filter((r) => r.status === WagerTransactionStatus.Processed);
    const perdeu = results.filter((r) => r.status === WagerTransactionStatus.Rejected);
    expect(ganhou).toHaveLength(1);
    expect(perdeu).toHaveLength(1);
    // a rejeição observou o saldo já debitado pela aposta vencedora
    expect(perdeu[0]!.balance.amount).toBe("20.00");
    expect(ganhou[0]!.balance.amount).toBe("20.00");

    const em = fresh();
    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(wallet.balance).toBe("20.00");
    expect(wallet.version).toBe(2); // exatamente um bump

    // nenhum débito duplicado (a OPENING é crédito)
    const debitos = await em.find(WalletLedgerEntryEntity, { wallet: walletId, direction: "DEBIT" });
    expect(debitos).toHaveLength(1);
  });

  test("créditos concorrentes disputam a mesma wallet → retry otimista converge (§8)", async () => {
    const walletId = await novaWallet("100.00");
    const win = (n: number) => comando(walletId, {
      idempotencyKey: `provider-a:win-${n}`, externalTransactionId: `win-${n}`,
      kind: WagerTransactionKind.Win,
      money: { amount: "5.00", currency: "BRL" },
    });

    const results = await Promise.all([
      submitTransaction.execute(win(1)),
      submitTransaction.execute(win(2)),
    ]);

    // ambas PROCESSED: o perdedor da corrida de version reexecuta e acerta.
    // cada resposta observa o saldo da SUA transição: uma vê 105.00, outra 110.00
    expect(results.every((r) => r.status === WagerTransactionStatus.Processed)).toBe(true);
    expect(results.map((r) => r.balance.amount).sort()).toEqual(["105.00", "110.00"]);

    const em = fresh();
    const wallet = await em.findOneOrFail(WalletEntity, { id: walletId });
    expect(wallet.balance).toBe("110.00");
    expect(wallet.version).toBe(3); // 1 criação + 2 bumps de version
    expect(await em.count(WalletLedgerEntryEntity, { wallet: walletId })).toBe(3); // OPENING + 2 wins

    // invariante final (§13): saldo == soma do ledger
    const fromLedger = await new MikroOrmUnitOfWork(orm).run((s) =>
      s.ledgerEntries.calculateBalance(walletId, "BRL"),
    );
    expect(fromLedger.toString()).toBe("110.00");
  });
});
