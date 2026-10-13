import { describe, test, expect } from "bun:test";
import { InboxMessage, InvalidInboxError } from "../../src/domain/inbox-message";
import { OutboxMessage } from "../../src/domain/outbox-message";
import { Wallet } from "../../src/domain/wallet";
import { Money } from "../../src/domain/money";
import { WalletBalanceChanged } from "../../src/domain/events/wallet-balance-changed";

const brl = (v: string) => Money.from({ amount: v, currency: "BRL" });

// wallet com débito real → gera ledger de verdade → evento real para a outbox
function novoEvento() {
  const wallet = Wallet.open({ playerId: "player-1", initialBalance: brl("100.00") });
  const entry = wallet.debit(brl("30.00"), "tx-1");
  const event = WalletBalanceChanged.from(wallet, entry, { correlationId: "corr-1" });
  return { wallet, entry, event };
}

describe("InboxMessage", () => {
  test("receive nasce não processado", () => {
    const msg = InboxMessage.receive({
      messageId: "msg-1",
      consumerName: "wager-consumer",
      payloadHash: "hash-1",
    });
    expect(msg.isProcessed()).toBe(false);
    expect(msg.processedAt).toBeUndefined();
    expect(msg.receivedAt).toBeInstanceOf(Date);
  });

  test("markProcessed torna a mensagem processada", () => {
    const msg = InboxMessage.receive({
      messageId: "msg-2",
      consumerName: "wager-consumer",
      payloadHash: "hash-2",
    });
    const quando = new Date("2026-10-13T12:00:00Z");
    msg.markProcessed(quando);
    expect(msg.isProcessed()).toBe(true);
    expect(msg.processedAt).toBe(quando);
  });

  test("markProcessed é idempotente — não sobrescreve o 1º timestamp", () => {
    const msg = InboxMessage.receive({
      messageId: "msg-3",
      consumerName: "wager-consumer",
      payloadHash: "hash-3",
    });
    const primeiro = new Date("2026-10-13T12:00:00Z");
    const segundo = new Date("2026-10-13T13:00:00Z");
    msg.markProcessed(primeiro);
    msg.markProcessed(segundo);
    expect(msg.processedAt).toBe(primeiro);
  });

  test("receive valida campos obrigatórios", () => {
    const base = { messageId: "msg-4", consumerName: "c", payloadHash: "h" };
    expect(() => InboxMessage.receive({ ...base, messageId: "" }))
      .toThrow(InvalidInboxError);
    expect(() => InboxMessage.receive({ ...base, consumerName: "   " }))
      .toThrow(InvalidInboxError);
    expect(() => InboxMessage.receive({ ...base, payloadHash: "" }))
      .toThrow(InvalidInboxError);
  });

  test("rehydrate reconstrói sem revalidar", () => {
    const processada = InboxMessage.rehydrate({
      messageId: "msg-5",
      consumerName: "c",
      payloadHash: "h",
      receivedAt: new Date("2026-10-13T10:00:00Z"),
      processedAt: new Date("2026-10-13T10:05:00Z"),
    });
    expect(processada.isProcessed()).toBe(true);

    const pendente = InboxMessage.rehydrate({
      messageId: "msg-6",
      consumerName: "c",
      payloadHash: "h",
      receivedAt: new Date(),
    });
    expect(pendente.isProcessed()).toBe(false);
  });
});

describe("OutboxMessage", () => {
  test("enqueue nasce com attempts 0, pendente e due", () => {
    const { event } = novoEvento();
    const msg = OutboxMessage.enqueue(event);
    expect(msg.attempts).toBe(0);
    expect(msg.isPending()).toBe(true);
    expect(msg.isDue(new Date())).toBe(true);
    expect(msg.nextAttemptAt).toBeUndefined();
    expect(msg.publishedAt).toBeUndefined();
  });

  test("enqueue grava o envelope serializado como payload", () => {
    const { event } = novoEvento();
    const msg = OutboxMessage.enqueue(event);
    expect(msg.id).toBe(event.eventId);
    expect(msg.eventType).toBe("WalletBalanceChanged");
    expect(msg.aggregateId).toBe(event.aggregateId);
    expect(msg.occurredAt).toBe(event.occurredAt);
    // payload = event.toJSON(): occurredAt em ISO, data com MoneyProps string
    expect(msg.payload).toEqual(event.toJSON());
    expect(typeof event.toJSON().data.money.amount).toBe("string");
  });

  test("isDue: false logo após scheduleRetry, true quando a espera vence", () => {
    const { event } = novoEvento();
    const msg = OutboxMessage.enqueue(event);
    const agora = new Date("2026-10-13T12:00:00Z");
    msg.scheduleRetry(agora);
    expect(msg.isDue(agora)).toBe(false);
    expect(msg.isDue(new Date(agora.getTime() + 1_500))).toBe(true);
  });

  test("scheduleRetry: backoff exponencial 1s, 2s... com teto de 5 min", () => {
    const { event } = novoEvento();
    const msg = OutboxMessage.enqueue(event);
    const agora = new Date("2026-10-13T12:00:00Z");

    msg.scheduleRetry(agora);
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt).toEqual(new Date(agora.getTime() + 1_000));

    msg.scheduleRetry(agora);
    expect(msg.attempts).toBe(2);
    expect(msg.nextAttemptAt).toEqual(new Date(agora.getTime() + 2_000));

    for (let i = 0; i < 20; i++) msg.scheduleRetry(agora);
    expect(msg.attempts).toBe(22);
    // teto: 1000 * 2^21 ultrapassa 5 min — trava no teto
    expect(msg.nextAttemptAt).toEqual(new Date(agora.getTime() + 300_000));
  });

  test("markPublished encerra a mensagem — não é mais due", () => {
    const { event } = novoEvento();
    const msg = OutboxMessage.enqueue(event);
    msg.markPublished(new Date("2026-10-13T12:00:00Z"));
    expect(msg.isPending()).toBe(false);
    expect(msg.isDue(new Date("2026-10-13T13:00:00Z"))).toBe(false);
  });

  test("rehydrate restaura todos os campos", () => {
    const { event } = novoEvento();
    const original = OutboxMessage.enqueue(event);
    original.scheduleRetry(new Date("2026-10-13T12:00:00Z"));

    const msg = OutboxMessage.rehydrate({
      id: original.id,
      aggregateId: original.aggregateId,
      eventType: original.eventType,
      payload: original.payload,
      occurredAt: original.occurredAt,
      attempts: original.attempts,
      nextAttemptAt: original.nextAttemptAt,
      publishedAt: original.publishedAt,
    });
    expect(msg.attempts).toBe(1);
    expect(msg.nextAttemptAt).toEqual(original.nextAttemptAt);
    expect(msg.isPending()).toBe(true);
    expect(msg.payload).toEqual(original.payload);
  });
});
