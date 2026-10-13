import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { MikroORM } from "@mikro-orm/postgresql";
import ormConfig from "../../mikro-orm.config";
import { CreateWallet } from "../../src/application/use-cases/create-wallet";
import { ConflictError } from "../../src/application/errors";
import { Wallet } from "../../src/domain/wallet";
import { Money } from "../../src/domain/money";
import { WagerTransactionStatus, WagerTransactionKind } from "../../src/domain/wager-transaction";
import { MikroOrmUnitOfWork } from "../../src/infrastructure/persistence/unit-of-work";
import { WagerTransactionMapper } from "../../src/infrastructure/persistence/mappers";
import { WalletEntity } from "../../src/infrastructure/persistence/entities/wallet.entity";
import { WagerTransactionEntity } from "../../src/infrastructure/persistence/entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "../../src/infrastructure/persistence/entities/wallet-ledger-entry.entity";
import { OutboxMessageEntity } from "../../src/infrastructure/persistence/entities/outbox-message.entity";

// Integração com o PostgreSQL real do Docker (porta 5433) — migrations já aplicadas.
// Este arquivo falha se o container estiver fora do ar: não substituímos o banco
// por mocks (eliminatória da seção 14).

let orm: MikroORM;
let createWallet: CreateWallet;
let uow: MikroOrmUnitOfWork;

// identity map isolada por asserção — nunca serve dado envelhecido
const fresh = () => orm.em.fork();

beforeAll(async () => {
  orm = await MikroORM.init(ormConfig); // config explícita: mesmo arquivo do CLI
  uow = new MikroOrmUnitOfWork(orm);
  createWallet = new CreateWallet(uow);
});

beforeEach(async () => {
  // TRUNCATE é o único caminho de limpeza: DELETE no ledger é barrado pelo
  // trigger append-only (limitação conhecida e documentada no ARCHITECTURE)
  await orm.em.getConnection().execute(
    `truncate table wallet_ledger_entries, wager_transactions, outbox_messages, inbox_messages, wallets cascade`,
  );
});

afterAll(async () => {
  await orm.close(true);
});

describe("POST /wallets — CreateWallet (seções 9 e 11)", () => {
  test("cria wallet + OPENING + ledger + outbox numa única transação", async () => {
    const result = await createWallet.execute({
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
      initialBalance: { amount: "1000.00", currency: "BRL" },
      correlationId: "corr-1",
    });

    expect(result.balance).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(result.version).toBe(1);

    const em = fresh();

    // wallet materializada com escala exata
    const wallet = await em.findOneOrFail(WalletEntity, { id: result.id });
    expect(wallet.balance).toBe("1000.00");
    expect(wallet.version).toBe(1);

    // OPENING interna, já PROCESSED (filtro pela FK — where vazio é proibido no v7)
    const tx = await em.findOneOrFail(WagerTransactionEntity, { wallet: result.id });
    expect(tx.kind).toBe("OPENING");
    expect(tx.status).toBe("PROCESSED");
    expect(tx.amount).toBe("1000.00");
    expect(tx.providerId).toBe("internal");
    expect(tx.processedAt).toBeInstanceOf(Date);

    // exatamente 1 lançamento CREDIT 0.00 → 1000.00
    const entries = await em.find(WalletLedgerEntryEntity, { wallet: result.id });
    expect(entries).toHaveLength(1);
    expect(entries[0]!.direction).toBe("CREDIT");
    expect(entries[0]!.balanceBefore).toBe("0.00");
    expect(entries[0]!.balanceAfter).toBe("1000.00");

    // outbox: 2 eventos gravados NA MESMA transação do saldo
    // (aggregate da wallet + aggregate da transação)
    const outbox = await em.find(OutboxMessageEntity, {
      $or: [{ aggregateId: result.id }, { aggregateId: tx.id }],
    });
    expect(outbox).toHaveLength(2);
    expect(outbox.map((o) => o.eventType).sort())
      .toEqual(["WagerTransactionProcessed", "WalletBalanceChanged"]); // ordem lexicográfica
    expect(outbox.every((o) => o.publishedAt === null)).toBe(true);
  });

  test("wallet de saldo zero: sem OPENING, sem ledger, sem outbox", async () => {
    const result = await createWallet.execute({
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a2",
      initialBalance: { amount: "0.00", currency: "BRL" },
    });

    expect(result.balance).toEqual({ amount: "0.00", currency: "BRL" });
    expect(result.version).toBe(1);

    const em = fresh();
    expect(await em.count(WalletEntity, {})).toBe(1);
    expect(await em.count(WagerTransactionEntity, {})).toBe(0);
    expect(await em.count(WalletLedgerEntryEntity, {})).toBe(0);
    expect(await em.count(OutboxMessageEntity, {})).toBe(0);
  });

  test("playerId + currency duplicado → conflito, nenhuma linha extra", async () => {
    const command = {
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a3",
      initialBalance: { amount: "10.00", currency: "BRL" },
    };
    await createWallet.execute(command);

    const error = await createWallet.execute(command).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ConflictError);
    expect((error as ConflictError).code).toBe("WALLET_ALREADY_EXISTS");

    const em = fresh();
    expect(await em.count(WalletEntity, {})).toBe(1);
    expect(await em.count(WalletLedgerEntryEntity, {})).toBe(1); // só a criação vencedora
  });

  test("corrida: duas criações simultâneas para o mesmo player — exatamente uma vence", async () => {
    const command = {
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a4",
      initialBalance: { amount: "100.00", currency: "BRL" },
    };

    const settled = await Promise.allSettled([
      createWallet.execute(command),
      createWallet.execute(command),
    ]);

    const wins = settled.filter((r) => r.status === "fulfilled");
    const losses = settled.filter((r) => r.status === "rejected");
    expect(wins).toHaveLength(1);
    expect(losses).toHaveLength(1);
    // o perdedor pode cair no fast-path (WALLET_ALREADY_EXISTS) ou no
    // UNIQUE do schema (DUPLICATE_ROW) — nos dois casos, conflito
    expect((losses[0] as PromiseRejectedResult).reason).toBeInstanceOf(ConflictError);

    const em = fresh();
    expect(await em.count(WalletEntity, { playerId: command.playerId })).toBe(1);
    expect(await em.count(WalletLedgerEntryEntity, {})).toBe(1);
  });

  test("falha dentro da transação não deixa nada persistido (rollback)", async () => {
    const before = await fresh().count(WalletEntity, {});

    await expect(
      uow.run(async (session) => {
        await session.wallets.insert(
          Wallet.open({ playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a5", initialBalance: Money.from({ amount: "50.00", currency: "BRL" }) }),
        );
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");

    expect(await fresh().count(WalletEntity, {})).toBe(before);
  });

  test("reidrata a transação OPENING do banco com a FK wallet resolvida", async () => {
    const result = await createWallet.execute({
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a6",
      initialBalance: { amount: "1000.00", currency: "BRL" },
    });

    const entity = await fresh().findOneOrFail(WagerTransactionEntity, { wallet: result.id });
    const tx = WagerTransactionMapper.toDomain(entity);

    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.kind).toBe(WagerTransactionKind.Opening);
    expect(tx.walletId).toBe(result.id);
    expect(tx.money.toString()).toBe("1000.00");
    expect(tx.processedAt).toBeInstanceOf(Date);
  });

  test("invariante §13: wallet.balance == saldo reconstruído pelo ledger", async () => {
    const result = await createWallet.execute({
      playerId: "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a7",
      initialBalance: { amount: "250.75", currency: "BRL" },
    });

    const fromLedger = await uow.run((session) =>
      session.ledgerEntries.calculateBalance(result.id, "BRL"),
    );

    expect(fromLedger.toString()).toBe("250.75");
    expect(fromLedger.toString()).toBe(result.balance.amount);
  });
});
