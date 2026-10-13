import { describe, test, expect } from "bun:test";
import { Wallet } from "../../src/domain/wallet";
import { Money } from "../../src/domain/money";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";
import { WalletBalanceChanged } from "../../src/domain/events/wallet-balance-changed";
import {
  WagerTransactionProcessed,
  WagerTransactionRejected,
  WagerTransactionPendingReference,
} from "../../src/domain/events/wager-transaction-events";
import {
  WagerTransaction,
  WagerTransactionKind,
  FailureCode,
  InvalidTransactionError,
} from "../../src/domain/wager-transaction";

const brl = (v: string) => Money.from({ amount: v, currency: "BRL" });
const ctx = { correlationId: "corr-1", causationId: "msg-9" };

function novaTx(
  kind: WagerTransactionKind = WagerTransactionKind.Bet,
  extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
) {
  return WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: "provider-a",
    externalTransactionId: `ext-${crypto.randomUUID()}`,
    idempotencyKey: "provider-a:tx-1",
    payloadHash: "hash-1",
    walletId: "wallet-1",
    playerId: "player-1",
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind,
    money: brl("25.00"),
    ...extra,
  });
}

describe("WalletBalanceChanged", () => {
  test("from monta o envelope com a data do lançamento", () => {
    const wallet = Wallet.open({ playerId: "p1", initialBalance: brl("100.00") });
    const entry = wallet.debit(brl("30.00"), "tx-1");
    const ev = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(ev.eventType).toBe("WalletBalanceChanged");
    expect(ev.version).toBe(1);
    expect(ev.aggregateId).toBe(wallet.id);
    expect(ev.correlationId).toBe("corr-1");
    expect(ev.causationId).toBe("msg-9");
    expect(ev.data).toEqual({
      walletId: wallet.id,
      transactionId: "tx-1",
      direction: LedgerDirection.Debit,
      money: { amount: "30.00", currency: "BRL" },
      balanceBefore: { amount: "100.00", currency: "BRL" },
      balanceAfter: { amount: "70.00", currency: "BRL" },
      walletVersion: 2,
    });
  });

  test("data carrega MoneyProps (string), nunca instância de Money", () => {
    const wallet = Wallet.open({ playerId: "p1", initialBalance: brl("100.00") });
    const entry = wallet.credit(brl("5.50"), "tx-2");
    const ev = WalletBalanceChanged.from(wallet, entry, ctx);

    expect(typeof ev.data.money.amount).toBe("string");
    expect(typeof ev.data.balanceAfter.amount).toBe("string");
    // JSON round-trip preserva as strings decimais
    const json = JSON.parse(JSON.stringify(ev.toJSON()));
    expect(json.data.money).toEqual({ amount: "5.50", currency: "BRL" });
  });

  test("data é imutável em runtime (frozen)", () => {
    const wallet = Wallet.open({ playerId: "p1", initialBalance: brl("100.00") });
    const entry = wallet.debit(brl("10.00"), "tx-3");
    const ev = WalletBalanceChanged.from(wallet, entry, ctx);
    expect(Object.isFrozen(ev.data)).toBe(true);
  });
});

describe("WagerTransactionProcessed", () => {
  test("from espelha os campos da transação", () => {
    const tx = novaTx(WagerTransactionKind.Win);
    const ev = WagerTransactionProcessed.from(tx, ctx);

    expect(ev.eventType).toBe("WagerTransactionProcessed");
    expect(ev.version).toBe(1);
    expect(ev.aggregateId).toBe(tx.id);
    expect(ev.data).toEqual({
      transactionId: tx.id,
      walletId: "wallet-1",
      providerId: "provider-a",
      externalTransactionId: tx.externalTransactionId,
      kind: WagerTransactionKind.Win,
      money: { amount: "25.00", currency: "BRL" },
      referenceExternalTransactionId: undefined,
    });
  });
});

describe("WagerTransactionRejected", () => {
  test("from carrega o failureCode da transação", () => {
    const tx = novaTx();
    tx.reject(FailureCode.INSUFFICIENT_BALANCE);
    const ev = WagerTransactionRejected.from(tx, ctx);

    expect(ev.eventType).toBe("WagerTransactionRejected");
    expect(ev.data.failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE);
    expect(ev.data.transactionId).toBe(tx.id);
  });

  test("transação rejeitada SEM failureCode é erro de programação", () => {
    const tx = novaTx();
    tx.reject(FailureCode.INSUFFICIENT_BALANCE);
    // rehydrate forja estado inconsistente que a factory não aceita
    const semCodigo = WagerTransaction.rehydrate({
      ...{
        id: tx.id, providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        idempotencyKey: tx.idempotencyKey, payloadHash: tx.payloadHash,
        walletId: tx.walletId, playerId: tx.playerId, roundId: tx.roundId,
        gameId: tx.gameId, kind: tx.kind, money: tx.money,
        referenceExternalTransactionId: tx.referenceExternalTransactionId,
        createdAt: tx.createdAt,
      },
      status: tx.status,
      processedAt: tx.processedAt,
      // failureCode omitido de propósito
    });
    expect(() => WagerTransactionRejected.from(semCodigo, ctx))
      .toThrow(InvalidTransactionError);
  });
});

describe("WagerTransactionPendingReference", () => {
  test("from carrega a referência externa", () => {
    const tx = novaTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: "provider-a:tx-0",
    });
    tx.markPendingReference();
    const ev = WagerTransactionPendingReference.from(tx, ctx);

    expect(ev.eventType).toBe("WagerTransactionPendingReference");
    expect(ev.version).toBe(1);
    expect(ev.data.referenceExternalTransactionId).toBe("provider-a:tx-0");
    expect(ev.data.kind).toBe(WagerTransactionKind.Refund);
  });

  test("PENDING_REFERENCE sem referência externa é erro de programação", () => {
    const tx = novaTx(WagerTransactionKind.Bet); // BET sem referência
    expect(() => WagerTransactionPendingReference.from(tx, ctx))
      .toThrow(InvalidTransactionError);
  });
});

describe("envelope JSON (seção 11)", () => {
  test("toJSON serializa occurredAt como ISO-8601 e mantém version", () => {
    const tx = novaTx();
    const ev = WagerTransactionProcessed.from(tx, ctx);
    const json = ev.toJSON();

    expect(json.occurredAt).toBe(ev.occurredAt.toISOString());
    expect(json.version).toBe(1);
    expect(json.eventType).toBe("WagerTransactionProcessed");
    expect(json.correlationId).toBe("corr-1");
    expect(json.causationId).toBe("msg-9");
    expect(Object.keys(json)).toEqual([
      "eventId", "eventType", "aggregateId", "correlationId",
      "causationId", "occurredAt", "version", "data",
    ]);
  });
});
