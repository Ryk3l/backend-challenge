import { describe, test, expect } from "bun:test";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
  FailureCode,
} from "../../src/domain/wager-transaction";
import { Money } from "../../src/domain/money";

const brl = (v: string) => Money.from({ amount: v, currency: "BRL" });

function novaTx(
  kind: WagerTransactionKind,
  extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {},
) {
  return WagerTransaction.create({
    id: crypto.randomUUID(),
    providerId: "provider-a",
    externalTransactionId: `ext-${crypto.randomUUID()}`,
    idempotencyKey: `provider-a:${crypto.randomUUID()}`,
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

// transação alvo já aplicada (único estado reversível — §7)
function betProcessada(extra: Partial<Parameters<typeof WagerTransaction.create>[0]> = {}) {
  const bet = novaTx(WagerTransactionKind.Bet, extra);
  bet.markProcessed(undefined, new Date());
  return bet;
}

describe("WagerTransaction.referenceViolation (regras da seção 7)", () => {
  test("REFUND de BET PROCESSADA válida → sem violação", () => {
    const bet = betProcessada();
    const refund = novaTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: bet.externalTransactionId,
      roundId: bet.roundId,
      money: bet.money,
    });
    expect(refund.referenceViolation(bet)).toBeUndefined();
  });

  test("ROLLBACK aceita BET, WIN e REFUND — rejeita LOSS e ROLLBACK", () => {
    const rollbackDe = (kind: WagerTransactionKind) => {
      const alvo = novaTx(kind,
        (kind === WagerTransactionKind.Rollback || kind === WagerTransactionKind.Refund)
          ? { referenceExternalTransactionId: "ext-x" }  // kinds que nascem exigindo referência
          : {});
      alvo.markProcessed(undefined, new Date());
      const rollback = novaTx(WagerTransactionKind.Rollback, {
        referenceExternalTransactionId: alvo.externalTransactionId,
        roundId: alvo.roundId,
        money: alvo.money,
      });
      return rollback.referenceViolation(alvo);
    };

    expect(rollbackDe(WagerTransactionKind.Bet)).toBeUndefined();
    expect(rollbackDe(WagerTransactionKind.Win)).toBeUndefined();
    expect(rollbackDe(WagerTransactionKind.Refund)).toBeUndefined();
    expect(rollbackDe(WagerTransactionKind.Loss)).toBe(FailureCode.INVALID_KIND_FOR_REFERENCE);
    expect(rollbackDe(WagerTransactionKind.Rollback)).toBe(FailureCode.INVALID_KIND_FOR_REFERENCE);
  });

  test("REFUND de WIN é invalid_kind (REFUND só reverte BET)", () => {
    const win = novaTx(WagerTransactionKind.Win);
    win.markProcessed(undefined, new Date());
    const refund = novaTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: win.externalTransactionId,
    });
    expect(refund.referenceViolation(win)).toBe(FailureCode.INVALID_KIND_FOR_REFERENCE);
  });

  test("referência não processada → REFERENCE_NOT_PROCESSED", () => {
    const bet = novaTx(WagerTransactionKind.Bet); // ainda PENDING
    const refund = novaTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: bet.externalTransactionId,
      roundId: bet.roundId,
      money: bet.money,
    });
    expect(refund.referenceViolation(bet)).toBe(FailureCode.REFERENCE_NOT_PROCESSED);
  });

  test("player, wallet ou round diferentes → REFERENCE_SCOPE_MISMATCH", () => {
    const base = { referenceExternalTransactionId: "ext-ref", money: brl("25.00") };
    const bet = betProcessada({ playerId: "player-1", walletId: "wallet-1", roundId: "round-1" });

    const outroPlayer = novaTx(WagerTransactionKind.Refund, { ...base, playerId: "player-2", walletId: "wallet-1", roundId: "round-1" });
    const outraWallet = novaTx(WagerTransactionKind.Refund, { ...base, playerId: "player-1", walletId: "wallet-2", roundId: "round-1" });
    const outraRodada = novaTx(WagerTransactionKind.Refund, { ...base, playerId: "player-1", walletId: "wallet-1", roundId: "round-2" });

    expect(outroPlayer.referenceViolation(bet)).toBe(FailureCode.REFERENCE_SCOPE_MISMATCH);
    expect(outraWallet.referenceViolation(bet)).toBe(FailureCode.REFERENCE_SCOPE_MISMATCH);
    expect(outraRodada.referenceViolation(bet)).toBe(FailureCode.REFERENCE_SCOPE_MISMATCH);
  });

  test("moeda diferente → CURRENCY_MISMATCH; valor diferente → AMOUNT_DIFFERS", () => {
    const bet = betProcessada();
    const usd = novaTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: bet.externalTransactionId,
      roundId: bet.roundId,
      money: Money.from({ amount: "25.00", currency: "USD" }),
    });
    const outroValor = novaTx(WagerTransactionKind.Refund, {
      referenceExternalTransactionId: bet.externalTransactionId,
      roundId: bet.roundId,
      money: brl("10.00"),
    });

    expect(usd.referenceViolation(bet)).toBe(FailureCode.CURRENCY_MISMATCH);
    expect(outroValor.referenceViolation(bet)).toBe(FailureCode.AMOUNT_DIFFERS_FROM_REFERENCE);
  });
});

describe("WagerTransaction.observedBalance (resposta idempotente, §9)", () => {
  test("rehydrate preserva o saldo observado", () => {
    const bet = betProcessada();
    bet.recordObservedBalance(brl("75.00"));

    const back = WagerTransaction.rehydrate({
      id: bet.id,
      providerId: bet.providerId,
      externalTransactionId: bet.externalTransactionId,
      idempotencyKey: bet.idempotencyKey,
      payloadHash: bet.payloadHash,
      walletId: bet.walletId,
      playerId: bet.playerId,
      roundId: bet.roundId,
      gameId: bet.gameId,
      kind: bet.kind,
      money: bet.money,
      referenceExternalTransactionId: bet.referenceExternalTransactionId,
      createdAt: bet.createdAt,
      status: bet.status,
      processedAt: bet.processedAt,
      observedBalance: bet.observedBalance!.toJSON(),
    });

    expect(back.observedBalance!.toString()).toBe("75.00");
    expect(back.observedBalance).toBeInstanceOf(Money);
  });

  test("sem registro, observedBalance fica indefinido", () => {
    expect(novaTx(WagerTransactionKind.Bet).observedBalance).toBeUndefined();
  });
});

describe("transição a partir de estado terminal continua bloqueada", () => {
  test("markProcessed em transação REJECTED lança InvalidTransactionStateError", () => {
    const bet = novaTx(WagerTransactionKind.Bet);
    bet.reject(FailureCode.INSUFFICIENT_BALANCE);
    expect(() => bet.markProcessed(undefined, new Date())).toThrow();
    expect(bet.status).toBe(WagerTransactionStatus.Rejected);
  });
});
