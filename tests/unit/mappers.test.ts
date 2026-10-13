import { describe, test, expect } from "bun:test";
import { Money } from "../../src/domain/money";
import { Wallet } from "../../src/domain/wallet";
import { WagerTransaction, WagerTransactionKind, WagerTransactionStatus, FailureCode } from "../../src/domain/wager-transaction";
import { WalletBalanceChanged } from "../../src/domain/events/wallet-balance-changed";
import { OutboxMessage } from "../../src/domain/outbox-message";
import {
  WalletMapper,
  WagerTransactionMapper,
  WalletLedgerEntryMapper,
  OutboxMessageMapper,
} from "../../src/infrastructure/persistence/mappers";
import { WalletEntity } from "../../src/infrastructure/persistence/entities/wallet.entity";
import { WagerTransactionEntity } from "../../src/infrastructure/persistence/entities/wager-transaction.entity";

const brl = (v: string) => Money.from({ amount: v, currency: "BRL" });

// stubs de FK: round-trip domínio → entity → domínio sem tocar no banco
function walletStub(id: string): WalletEntity {
  const entity = new WalletEntity();
  entity.id = id;
  return entity;
}

describe("WalletMapper round-trip", () => {
  test("domínio → entity → domínio preserva todos os campos", () => {
    const wallet = Wallet.open({ playerId: "player-1", initialBalance: brl("1000.00") });
    const back = WalletMapper.toDomain(WalletMapper.toEntity(wallet));

    expect(back.id).toBe(wallet.id);
    expect(back.playerId).toBe("player-1");
    expect(back.currency).toBe("BRL");
    expect(back.balance.toString()).toBe("1000.00");
    expect(back.version).toBe(1);
    expect(back.createdAt).toEqual(wallet.createdAt);
    expect(back.updatedAt).toEqual(wallet.updatedAt);
  });

  test("saldo serializa como string decimal — nunca number (eliminatória)", () => {
    const wallet = Wallet.open({ playerId: "player-1", initialBalance: brl("0.10") });
    wallet.credit(brl("0.20"), "tx-1"); // 0.10 + 0.20 = 0.30 sem erro de ponto flutuante
    const entity = WalletMapper.toEntity(wallet);

    expect(typeof entity.balance).toBe("string");
    expect(entity.balance).toBe("0.30");
    expect(WalletMapper.toDomain(entity).balance.toString()).toBe("0.30");
  });

  test("após débito, version e updatedAt da entity acompanham o domínio", () => {
    const wallet = Wallet.open({ playerId: "player-1", initialBalance: brl("100.00") });
    wallet.debit(brl("30.00"), "tx-1");
    const entity = WalletMapper.toEntity(wallet);

    expect(entity.version).toBe(2);
    expect(entity.balance).toBe("70.00");
    expect(entity.updatedAt).toEqual(wallet.updatedAt);
  });
});

describe("WagerTransactionMapper round-trip", () => {
  test("transação PROCESSED preserva FK, enums e dinheiro", () => {
    const tx = WagerTransaction.create({
      id: "tx-1",
      providerId: "provider-a",
      externalTransactionId: "ext-1",
      idempotencyKey: "provider-a:ext-1",
      payloadHash: "hash-1",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Bet,
      money: brl("25.00"),
    });
    tx.markProcessed(undefined, new Date("2026-10-13T12:00:00Z"));

    const back = WagerTransactionMapper.toDomain(
      WagerTransactionMapper.toEntity(tx, walletStub("wallet-1")),
    );

    expect(back.id).toBe("tx-1");
    expect(back.walletId).toBe("wallet-1");
    expect(back.kind).toBe(WagerTransactionKind.Bet);
    expect(back.status).toBe(WagerTransactionStatus.Processed);
    expect(back.money.toString()).toBe("25.00");
    expect(back.processedAt).toEqual(tx.processedAt);
    expect(back.failureCode).toBeUndefined();
  });

  test("REJECTED carrega failureCode e processedAt", () => {
    const tx = WagerTransaction.create({
      id: "tx-2",
      providerId: "provider-a",
      externalTransactionId: "ext-2",
      idempotencyKey: "provider-a:ext-2",
      payloadHash: "hash-2",
      walletId: "wallet-1",
      playerId: "player-1",
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Bet,
      money: brl("25.00"),
    });
    tx.reject(FailureCode.INSUFFICIENT_BALANCE);

    const entity = WagerTransactionMapper.toEntity(tx, walletStub("wallet-1"));
    expect(entity.failureCode).toBe("INSUFFICIENT_BALANCE");
    expect(entity.updatedAt).toEqual(tx.processedAt!); // reject() sempre marca processedAt

    const back = WagerTransactionMapper.toDomain(entity);
    expect(back.status).toBe(WagerTransactionStatus.Rejected);
    expect(back.failureCode).toBe(tx.failureCode);
  });
});

describe("WalletLedgerEntryMapper round-trip", () => {
  test("lançamento preserva direção, antes e depois", () => {
    const wallet = Wallet.open({ playerId: "player-1", initialBalance: brl("100.00") });
    const entry = wallet.debit(brl("30.00"), "tx-1");

    const entity = WalletLedgerEntryMapper.toEntity(
      entry, walletStub("wallet-1"), (() => { const t = new WagerTransactionEntity(); t.id = "tx-1"; return t; })(),
    );
    const back = WalletLedgerEntryMapper.toDomain(entity);

    expect(back.direction).toBe(entry.direction);
    expect(back.walletId).toBe("wallet-1");
    expect(back.transactionId).toBe("tx-1");
    expect(back.money.toString()).toBe("30.00");
    expect(back.balanceBefore.toString()).toBe("100.00");
    expect(back.balanceAfter.toString()).toBe("70.00");
    expect(back.isBalanced()).toBe(true);
  });
});

describe("OutboxMessageMapper round-trip", () => {
  test("envelope serializado sobrevive ao mapper", () => {
    const wallet = Wallet.open({ playerId: "player-1", initialBalance: brl("100.00") });
    const entry = wallet.credit(brl("5.50"), "tx-1");
    const event = WalletBalanceChanged.from(wallet, entry, { correlationId: "corr-1" });
    const message = OutboxMessage.enqueue(event);

    const back = OutboxMessageMapper.toDomain(OutboxMessageMapper.toEntity(message));

    expect(back.id).toBe(event.eventId);
    expect(back.eventType).toBe("WalletBalanceChanged");
    expect(back.attempts).toBe(0);
    expect(back.isPending()).toBe(true);
    expect(back.payload).toEqual(event.toJSON());
    expect(back.occurredAt).toEqual(event.occurredAt);
    expect(back.nextAttemptAt).toBeUndefined();
    expect(back.publishedAt).toBeUndefined();
  });
});
