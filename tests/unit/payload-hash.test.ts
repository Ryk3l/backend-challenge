import { describe, test, expect } from "bun:test";
import { canonicalJson, payloadHash } from "../../src/application/payload-hash";

describe("canonicalJson / payloadHash (seção 9)", () => {
  test("ordem das chaves não altera o hash", () => {
    const a = { playerId: "p1", kind: "BET", money: { currency: "BRL", amount: "25.00" } };
    const b = { money: { amount: "25.00", currency: "BRL" }, kind: "BET", playerId: "p1" };
    expect(canonicalJson(a)).toBe(canonicalJson(b));
    expect(payloadHash(a)).toBe(payloadHash(b));
  });

  test("conteúdo divergente gera hash diferente — conflito, não replay", () => {
    expect(payloadHash({ kind: "BET", amount: "25.00" }))
      .not.toBe(payloadHash({ kind: "BET", amount: "26.00" }));
  });

  test("hash é sha-256 hex de 64 caracteres (cabe em payload_hash)", () => {
    expect(payloadHash({ x: 1 })).toMatch(/^[0-9a-f]{64}$/);
  });

  test("formato canônico: objetos ordenados, arrays preservam ordem", () => {
    const nested = { outer: { b: 2, a: 1 }, list: [{ y: 1, x: 2 }] };
    expect(canonicalJson(nested))
      .toBe('{"list":[{"x":2,"y":1}],"outer":{"a":1,"b":2}}');
  });
});
