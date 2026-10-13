import { CreateQueueCommand, type SQSClient } from "@aws-sdk/client-sqs";

const DLQ_NAME = "wager-transactions-dlq.fifo";
const INBOUND_NAME = "wager-transactions.fifo";
const EVENTS_NAME = "wager-events.fifo";
const LOCAL_ACCOUNT_FALLBACK = "000000000000";
// limite de tentativas (redeliveries) antes da DLQ — §10
const MAX_RECEIVE_COUNT = 5;

async function createFifo(client: SQSClient, name: string, extra?: Record<string, string>): Promise<void> {
    await client.send(new CreateQueueCommand({
        QueueName: name,
        Attributes: {
            FifoQueue: "true",
            // dedup explícito via MessageDeduplicationId — content-based geraria
            // colisão entre eventos de payloads parecidos
            ContentBasedDeduplication: "false",
            ...extra,
        },
    }));
}

/**
 * Criação idempotente das filas do desafio (§10): CreateQueue com o mesmo
 * nome e mesmos atributos não falha — roda no bootstrap do consumidor e nos
 * testes de integração, sem passo manual de setup.
 */
export async function ensureQueues(client: SQSClient): Promise<void> {
    const account = process.env.AWS_ACCOUNT_ID ?? LOCAL_ACCOUNT_FALLBACK;
    const region = process.env.AWS_REGION ?? "us-east-1";
    const arn = (name: string) => `arn:aws:sqs:${region}:${account}:${name}`;

    await createFifo(client, DLQ_NAME);
    await createFifo(client, INBOUND_NAME, {
        // redrive automático: N redeliveries → DLQ — a rede de segurança da §10
        RedrivePolicy: JSON.stringify({
            deadLetterTargetArn: arn(DLQ_NAME),
            maxReceiveCount: MAX_RECEIVE_COUNT,
        }),
        // janela para processar antes do redelivery (§10)
        VisibilityTimeout: "30",
    });
    await createFifo(client, EVENTS_NAME);
}
