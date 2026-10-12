import { describe, test, expect } from "bun:test";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  FailureCode,
  InvalidTransactionStateError,
  InvalidTransactionError,
} from "../../src/domain/wager-transaction";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";
import { Money } from "../../src/domain/money";

const brl = (v: string) => Money.from({ amount: v, currency: "BRL" });

// helper: cria uma transação com valores padrão
function novaTx(
  kind: WagerTransactionKind,
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

describe("WagerTransaction", () => {
  test("create nasce em PENDING", () => {
    expect(novaTx(WagerTransactionKind.Bet).status)
      .toBe(WagerTransactionStatus.Pending);
  });

  test("REFUND sem referência é rejeitado na criação", () => {
    expect(() => novaTx(WagerTransactionKind.Refund))
      .toThrow(InvalidTransactionError);
  });

  test("ROLLBACK sem referência é rejeitado na criação", () => {
    expect(() => novaTx(WagerTransactionKind.Rollback))
      .toThrow(InvalidTransactionError);
  });

  test("REFUND com referência é criada em PENDING", () => {
    const tx = novaTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: "ext-bet-1",
    });
    expect(tx.status).toBe(WagerTransactionStatus.Pending);
    expect(tx.requiresReference()).toBe(true);
  });

  test("markProcessed muda para PROCESSED com referência e data", () => {
    const tx = novaTx(WagerTransactionKind.Bet);
    const agora = new Date();
    tx.markProcessed("tx-interna-ref", agora);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
    expect(tx.referenceTransactionId).toBe("tx-interna-ref");
    expect(tx.processedAt).toEqual(agora);
    expect(tx.isTerminal()).toBe(true);
  });

  test("estado terminal é trancado: não muda mais de estado", () => {
    const tx = novaTx(WagerTransactionKind.Bet);
    tx.markProcessed(undefined, new Date());
    // tentar rejeitar depois de PROCESSED = erro de PROGRAMAÇÃO
    expect(() => tx.reject(FailureCode.INSUFFICIENT_BALANCE))
      .toThrow(InvalidTransactionStateError);
    expect(tx.status).toBe(WagerTransactionStatus.Processed);
  });

  test("reject guarda o failureCode e vira terminal", () => {
    const tx = novaTx(WagerTransactionKind.Bet);
    tx.reject(FailureCode.INSUFFICIENT_BALANCE);
    expect(tx.status).toBe(WagerTransactionStatus.Rejected);
    expect(tx.failureCode).toBe(FailureCode.INSUFFICIENT_BALANCE);
    expect(tx.isTerminal()).toBe(true);
    expect(() => tx.fail(FailureCode.REFERENCE_NOT_FOUND))
      .toThrow(InvalidTransactionStateError);
  });

  test("fail marca erro permanente de infra como terminal", () => {
    const tx = novaTx(WagerTransactionKind.Bet);
    tx.fail(FailureCode.REFERENCE_NOT_FOUND);
    expect(tx.status).toBe(WagerTransactionStatus.Failed);
    expect(tx.failureCode).toBe(FailureCode.REFERENCE_NOT_FOUND);
  });

  test("markPendingReference aguarda a transação referenciada", () => {
    const tx = novaTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: "ext-bet-9",
    });
    tx.markPendingReference();
    expect(tx.status).toBe(WagerTransactionStatus.PendingReference);
    expect(tx.isTerminal()).toBe(false);   // pode ser reprocessada
  });

  test("affectsBalance: LOSS não move saldo, BET move", () => {
    expect(novaTx(WagerTransactionKind.Loss).affectsBalance()).toBe(false);
    expect(novaTx(WagerTransactionKind.Bet).affectsBalance()).toBe(true);
    expect(novaTx(WagerTransactionKind.Win).affectsBalance()).toBe(true);
  });

  test("requiresReference: só REFUND e ROLLBACK", () => {
    expect(novaTx(WagerTransactionKind.Bet).requiresReference()).toBe(false);
    expect(novaTx(WagerTransactionKind.Loss).requiresReference()).toBe(false);
    expect(novaTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: "x" }).requiresReference()).toBe(true);
    expect(novaTx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: "x" }).requiresReference()).toBe(true);
  });

  test("matchesPayload detecta payload divergente na mesma key", () => {
    const tx = novaTx(WagerTransactionKind.Bet);
    expect(tx.matchesPayload("hash-1")).toBe(true);
    expect(tx.matchesPayload("hash-OUTRO")).toBe(false);  // → conflito, não replay
  });

  test("ledgerDirectionFor: BET=DEBIT, WIN/OPENING=CREDIT", () => {
    expect(novaTx(WagerTransactionKind.Bet).ledgerDirectionFor())
      .toBe(LedgerDirection.Debit);
    expect(novaTx(WagerTransactionKind.Win).ledgerDirectionFor())
      .toBe(LedgerDirection.Credit);
    expect(novaTx(WagerTransactionKind.Opening).ledgerDirectionFor())
      .toBe(LedgerDirection.Credit);
  });

  test("ROLLBACK inverte a direção da referência", () => {
    const bet = novaTx(WagerTransactionKind.Bet);          // DEBIT
    const rollback = novaTx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: "ext-bet-1",
    });
    expect(rollback.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);

    const win = novaTx(WagerTransactionKind.Win);          // CREDIT
    const rollback2 = novaTx(WagerTransactionKind.Rollback, {
      referenceExternalTransactionId: "ext-win-1",
    });
    expect(rollback2.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
  });

  test("LOSS não tem lançamento: directionFor lança erro", () => {
    expect(() => novaTx(WagerTransactionKind.Loss).ledgerDirectionFor())
      .toThrow(InvalidTransactionError);
  });
});