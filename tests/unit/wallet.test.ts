import { describe, test, expect } from "bun:test";
import { Wallet, InsufficientBalanceError, InvalidWalletError } from "../../src/domain/wallet";
import { LedgerDirection } from "../../src/domain/wallet-ledger-entry";
import { Money } from "../../src/domain/money";

const brl = (v: string) => Money.from({ amount: v, currency: "BRL" });

function novaWallet(saldo = "100.00") {
  return Wallet.open({ playerId: "player-1", initialBalance: brl(saldo) });
}

describe("Wallet", () => {
  test("open cria saldo inicial e version 1", () => {
    const w = novaWallet("100.00");
    expect(w.balance.toString()).toBe("100.00");
    expect(w.version).toBe(1);
  });

  test("open rejeita saldo inicial negativo", () => {
    // Money válido com valor negativo (só o negate() consegue criar)
    const negativo = brl("1.00").negate();
    expect(() => Wallet.open({ playerId: "player-1", initialBalance: negativo }))
      .toThrow(InvalidWalletError);
  });

  test("debit reduz saldo, gera ledger DEBIT e incrementa version", () => {
    const w = novaWallet("100.00");
    const entry = w.debit(brl("30.00"), "tx-1");
    expect(w.balance.toString()).toBe("70.00");
    expect(w.version).toBe(2);
    expect(entry.direction).toBe(LedgerDirection.Debit);
    expect(entry.isBalanced()).toBe(true);   // 100 - 30 = 70 ✓
  });

  test("debit sem saldo NÃO altera nada", () => {
    const w = novaWallet("100.00");
    expect(() => w.debit(brl("150.00"), "tx-2")).toThrow(InsufficientBalanceError);
    expect(w.balance.toString()).toBe("100.00");  // intocado
    expect(w.version).toBe(1);                    // intocado
  });

  test("credit aumenta saldo e gera ledger CREDIT", () => {
    const w = novaWallet("100.00");
    const entry = w.credit(brl("50.00"), "tx-3");
    expect(w.balance.toString()).toBe("150.00");
    expect(entry.direction).toBe(LedgerDirection.Credit);
    expect(entry.isBalanced()).toBe(true);   // 100 + 50 = 150 ✓
  });

  test("operação com moeda diferente da wallet é rejeitada", () => {
    const w = novaWallet("100.00");
    const usd = Money.from({ amount: "10.00", currency: "USD" });
    expect(() => w.debit(usd, "tx-4")).toThrow();
  });
});