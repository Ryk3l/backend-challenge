import { defineEntity, p } from "@mikro-orm/postgresql";

export const OutboxMessageEntitySchema = defineEntity({
    name: "OutboxMessageEntity",
    tableName: "outbox_messages",
    // Worker (§11): varre pendentes — published_at nulo e next_attempt_at vencido
    indexes: [
        { name: "idx_outbox_pending", properties: ["publishedAt", "nextAttemptAt"] },
    ],
    properties: {
        id: p.uuid().primary(), // = eventId do evento de integração
        aggregateId: p.string().length(64),
        // eventType no tipo, não string solta no call site (§11)
        eventType: p.enum([
            "WagerTransactionProcessed",
            "WagerTransactionRejected",
            "WalletBalanceChanged",
            "WagerTransactionPendingReference",
        ]),
        payload: p.json(), // envelope serializado (event.toJSON()) — jsonb no Postgres
        occurredAt: p.datetime(),
        attempts: p.integer(), // inicia em 0; scheduleRetry incrementa + backoff
        nextAttemptAt: p.datetime().nullable(), // retry agendado (§7.1/§11)
        publishedAt: p.datetime().nullable(), // nulo = pendente; preenchido só após o commit
    },
});

export class OutboxMessageEntity extends OutboxMessageEntitySchema.class { }
OutboxMessageEntitySchema.setClass(OutboxMessageEntity);
