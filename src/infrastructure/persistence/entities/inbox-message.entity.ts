import { defineEntity, p } from "@mikro-orm/postgresql";

export const InboxMessageEntitySchema = defineEntity({
    name: "InboxMessageEntity",
    tableName: "inbox_messages",
    // Dedup persistente do consumidor SQS (§10): mesma mensagem nunca processada 2x.
    // Garantia contra a eliminatória "idempotência apenas em memória".
    uniques: [
        { name: "uq_inbox_consumer_message", properties: ["consumerName", "messageId"] },
    ],
    properties: {
        id: p.uuid().primary(),
        messageId: p.string().length(128),
        consumerName: p.string().length(64),
        payloadHash: p.string().length(64), // hash do payload — detecta reentrega com conteúdo divergente
        receivedAt: p.datetime(),
        processedAt: p.datetime().nullable(), // nulo = ainda não processada
    },
});

export class InboxMessageEntity extends InboxMessageEntitySchema.class { }
InboxMessageEntitySchema.setClass(InboxMessageEntity);
