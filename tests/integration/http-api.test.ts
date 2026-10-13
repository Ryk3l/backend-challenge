import { describe, test, expect, beforeAll, beforeEach, afterAll } from "bun:test";
import { NestFactory } from "@nestjs/core";
import type { INestApplication } from "@nestjs/common";
import type { AddressInfo } from "node:net";
import { randomUUID } from "node:crypto";
import { AppModule } from "../../src/interfaces/http/app.module";
import { MIKRO_ORM } from "../../src/interfaces/http/tokens";
import { WalletEntity } from "../../src/infrastructure/persistence/entities/wallet.entity";
import type { MikroORM } from "@mikro-orm/postgresql";

// Integração HTTP de ponta a ponta: NestJS real + Postgres real (5433).
// Valida o contrato da §9 — status, formatos de corpo e mapeamento de erros.

let app: INestApplication;
let orm: MikroORM;
let base: string;
let playerId: string;

beforeAll(async () => {
  app = await NestFactory.create(AppModule, { logger: false });
  await app.listen(0);
  const { port } = app.getHttpServer().address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  orm = app.get(MIKRO_ORM);
});

beforeEach(async () => {
  await orm.em.getConnection().execute(
    `truncate table wallet_ledger_entries, wager_transactions, outbox_messages, inbox_messages, wallets cascade`,
  );
  playerId = randomUUID();
});

afterAll(async () => {
  await app.close(); // dispara onApplicationShutdown → fecha o Postgres
});

async function api(path: string, init?: RequestInit): Promise<{ status: number; body: any }> {
  const res = await fetch(`${base}${path}`, init);
  return { status: res.status, body: await res.json() };
}

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

async function createWallet(initial = "100.00"): Promise<string> {
  const { status, body } = await api("/wallets", json({
    playerId,
    initialBalance: { amount: initial, currency: "BRL" },
  }));
  expect(status).toBe(201);
  return body.id;
}

function betBody(walletId: string, extra: Record<string, unknown> = {}) {
  return {
    providerId: "provider-a",
    externalTransactionId: "bet-1",
    playerId,
    walletId,
    roundId: "round-1",
    gameId: "fortune-chimp",
    kind: "BET",
    money: { amount: "25.00", currency: "BRL" },
    ...extra,
  };
}

const submit = (walletId: string, extra: Record<string, unknown> = {}, key = "provider-a:bet-1") =>
  api("/wagering/transactions", {
    ...json(betBody(walletId, extra)),
    headers: { "content-type": "application/json", "idempotency-key": key },
  });

describe("POST /wallets (§9)", () => {
  test("cria wallet e responde no formato do contrato", async () => {
    const { status, body } = await api("/wallets", json({
      playerId,
      initialBalance: { amount: "1000.00", currency: "BRL" },
    }));

    expect(status).toBe(201);
    expect(body.playerId).toBe(playerId);
    expect(body.balance).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(body.version).toBe(1);
  });

  test("duplicada (mesmo playerId + moeda) → 409 conflito", async () => {
    await createWallet();
    const { status, body } = await api("/wallets", json({
      playerId,
      initialBalance: { amount: "50.00", currency: "BRL" },
    }));

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "CONFLICT", code: "WALLET_ALREADY_EXISTS" });
  });

  test("payload inválido → 400 com código legível", async () => {
    const semPlayer = await api("/wallets", json({ initialBalance: { amount: "1.00", currency: "BRL" } }));
    expect(semPlayer.status).toBe(400);
    expect(semPlayer.body).toMatchObject({ error: "INVALID_PAYLOAD", code: "MISSING_PLAYERID" });

    const moedaInvalida = await api("/wallets", json({
      playerId,
      initialBalance: { amount: "1.999", currency: "BRL" }, // 3 casas = inválido (§6.1)
    }));
    expect(moedaInvalida.status).toBe(400);
    expect(moedaInvalida.body.error).toBe("INVALID_PAYLOAD");

    const jsonQuebrado = await fetch(`${base}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{ quebrado",
    });
    expect(jsonQuebrado.status).toBe(400);
    // o Nest embrulha o erro do body parser — o filtro normaliza para o mesmo vocabulário
    expect(((await jsonQuebrado.json()) as { error: string }).error).toBe("INVALID_PAYLOAD");
  });
});

describe("GET /wallets (§9)", () => {
  test("lê a wallet; desconhecida → 404", async () => {
    const walletId = await createWallet("100.00");

    const ok = await api(`/wallets/${walletId}`);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ id: walletId, playerId, version: 1 });

    const missing = await api(`/wallets/${randomUUID()}`);
    expect(missing.status).toBe(404);
    expect(missing.body).toMatchObject({ error: "NOT_FOUND", code: "WALLET_NOT_FOUND" });
  });
});

describe("POST /wagering/transactions (§9)", () => {
  test("BET processada → 200 no formato do contrato", async () => {
    const walletId = await createWallet("100.00");
    const { status, body } = await submit(walletId);

    expect(status).toBe(200);
    expect(body).toMatchObject({
      status: "PROCESSED",
      balance: { amount: "75.00", currency: "BRL" },
      idempotentReplay: false,
    });
    expect(typeof body.transactionId).toBe("string");
  });

  test("replay → mesma resposta com idempotentReplay: true", async () => {
    const walletId = await createWallet("100.00");
    const first = await submit(walletId);
    const replay = await submit(walletId);

    expect(replay.status).toBe(200);
    expect(replay.body).toMatchObject({
      transactionId: first.body.transactionId,
      balance: { amount: "75.00", currency: "BRL" },
      idempotentReplay: true,
    });
  });

  test("mesma key com payload divergente → 409 conflito", async () => {
    const walletId = await createWallet("100.00");
    await submit(walletId);
    const { status, body } = await submit(walletId, {
      money: { amount: "26.00", currency: "BRL" },
    });

    expect(status).toBe(409);
    expect(body).toMatchObject({ error: "CONFLICT", code: "IDEMPOTENCY_CONFLICT" });
  });

  test("regra de negócio (saldo insuficiente) → 422 com failureCode", async () => {
    const walletId = await createWallet("10.00");
    const { status, body } = await submit(walletId);

    expect(status).toBe(422);
    expect(body).toMatchObject({
      status: "REJECTED",
      failureCode: "INSUFFICIENT_BALANCE",
      balance: { amount: "10.00", currency: "BRL" },
    });
  });

  test("Idempotency-Key ausente ou kind OPENING → 400", async () => {
    const walletId = await createWallet();

    const semKey = await api("/wagering/transactions", json(betBody(walletId)));
    expect(semKey.status).toBe(400);
    expect(semKey.body.code).toBe("MISSING_IDEMPOTENCY_KEY");

    const opening = await submit(walletId, { kind: "OPENING" }, "provider-a:opening");
    expect(opening.status).toBe(400);
    expect(opening.body.code).toBe("INVALID_KIND");
  });

  test("REFUND antes da BET → 202 com status PENDING_REFERENCE", async () => {
    const walletId = await createWallet("100.00");
    const { status, body } = await submit(walletId, {
      kind: "REFUND",
      referenceExternalTransactionId: "bet-chegara-depois",
      externalTransactionId: "refund-1",
    }, "provider-a:refund-1");

    expect(status).toBe(202);
    expect(body).toMatchObject({ status: "PENDING_REFERENCE", idempotentReplay: false });
  });
});

describe("consultas de transação (§9)", () => {
  test("GET por id e por (provider, external) — 404 nos dois quando inexiste", async () => {
    const walletId = await createWallet();
    const submitted = await submit(walletId);
    const txId = submitted.body.transactionId;

    const porId = await api(`/wagering/transactions/${txId}`);
    expect(porId.status).toBe(200);
    expect(porId.body).toMatchObject({
      id: txId,
      providerId: "provider-a",
      externalTransactionId: "bet-1",
      status: "PROCESSED",
      money: { amount: "25.00", currency: "BRL" },
    });

    const porExternal = await api(`/providers/provider-a/wagering/transactions/bet-1`);
    expect(porExternal.status).toBe(200);
    expect(porExternal.body.id).toBe(txId);

    expect((await api(`/wagering/transactions/${randomUUID()}`)).status).toBe(404);
    expect((await api(`/providers/p/wagering/transactions/nada`)).status).toBe(404);
  });
});

describe("ledger paginado (§9 — cursor estável e opaco)", () => {
  test("pagina sem sobreposição e termina em nextCursor null", async () => {
    const walletId = await createWallet("100.00"); // OPENING (1º lançamento)
    await submit(walletId);                                            // BET DEBIT
    await submit(walletId, { kind: "WIN", externalTransactionId: "win-1" }, "provider-a:win-1");

    const p1 = await api(`/wallets/${walletId}/ledger?limit=2`);
    expect(p1.status).toBe(200);
    expect(p1.body.entries).toHaveLength(2);
    expect(p1.body.nextCursor).toBeString();

    const p2 = await api(`/wallets/${walletId}/ledger?cursor=${encodeURIComponent(p1.body.nextCursor)}&limit=2`);
    expect(p2.body.entries).toHaveLength(1); // OPENING + BET + WIN = 3
    expect(p2.body.nextCursor).toBeNull();

    const ids = [...p1.body.entries, ...p2.body.entries].map((e: any) => e.id);
    expect(new Set(ids).size).toBe(3); // sem sobreposição
    expect(p1.body.entries[0].direction).toBe("CREDIT"); // ordem cronológica ascendente
  });

  test("cursor inválido ou limit não numérico → 400", async () => {
    const walletId = await createWallet();

    const cursor = await api(`/wallets/${walletId}/ledger?cursor=abc`);
    expect(cursor.status).toBe(400);
    expect(cursor.body.code).toBe("INVALID_CURSOR");

    const limit = await api(`/wallets/${walletId}/ledger?limit=zero`);
    expect(limit.status).toBe(400);
    expect(limit.body.code).toBe("INVALID_LIMIT");
  });
});

describe("reconciliação (§9)", () => {
  test("consistente → difference zero; divergência plantada → sinalizada, nunca corrigida", async () => {
    const walletId = await createWallet("100.00");
    await submit(walletId); // 100 → 75

    const ok = await api(`/wallets/${walletId}/reconciliation`, { method: "POST" });
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({
      consistent: true,
      checkedEntries: 2, // OPENING + BET
      difference: { amount: "0.00", currency: "BRL" },
    });

    // planta divergência: altera o saldo sem passar pelo domínio, como uma
    // corrupção real (a invariant é o ledger, e ele não acompanha)
    await orm.em.fork().nativeUpdate(WalletEntity, { id: walletId }, { balance: "999.00" });

    const divergente = await api(`/wallets/${walletId}/reconciliation`, { method: "POST" });
    expect(divergente.status).toBe(200); // resposta sinaliza, não esconde
    expect(divergente.body).toMatchObject({
      consistent: false,
      storedBalance: { amount: "999.00", currency: "BRL" },
      calculatedBalance: { amount: "75.00", currency: "BRL" },
      difference: { amount: "-924.00", currency: "BRL" },
    });
  });
});

describe("health (§9 — sem autenticação)", () => {
  test("live responde sem tocar o banco; ready faz ping no PostgreSQL", async () => {
    const live = await api("/health/live");
    expect(live.status).toBe(200);
    expect(live.body.status).toBe("ok");

    const ready = await api("/health/ready");
    expect(ready.status).toBe(200);
    expect(ready.body).toMatchObject({ status: "ok", checks: { postgres: "ok" } });
  });
});
