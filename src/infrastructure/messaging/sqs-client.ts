import { SQSClient, GetQueueUrlCommand } from "@aws-sdk/client-sqs";

// URLs das filas FIFO do desafio no LocalStack (compose, §4) —
// sobrescrevíveis por env quando o endpoint não for o padrão local
const LOCAL_ACCOUNT = "000000000000";
export const QUEUE_URLS = {
    /** entrada de comandos (§10) — wager-transactions.fifo */
    inbound: process.env.SQS_INBOUND_QUEUE_URL
        ?? `http://localhost:4566/${LOCAL_ACCOUNT}/wager-transactions.fifo`,
    /** destino de mensagens permanentes (§10) — wager-transactions-dlq.fifo */
    dlq: process.env.SQS_DLQ_QUEUE_URL
        ?? `http://localhost:4566/${LOCAL_ACCOUNT}/wager-transactions-dlq.fifo`,
    /** saída da outbox (§11) — wager-events.fifo */
    events: process.env.SQS_EVENTS_QUEUE_URL
        ?? `http://localhost:4566/${LOCAL_ACCOUNT}/wager-events.fifo`,
};

/**
 * Checagem de prontidão do SQS (§12 /health/ready): resolve a URL da fila de
 * entrada pelo nome — leve e idempotente, não consome mensagem. Lança se o
 * broker estiver inacessível, para o health marcar `sqs: down`.
 */
export async function pingSqs(client: SQSClient): Promise<void> {
    await client.send(new GetQueueUrlCommand({ QueueName: "wager-transactions.fifo" }));
}

export function createSqsClient(): SQSClient {
    return new SQSClient({
        region: process.env.AWS_REGION ?? "us-east-1",
        endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
        // credenciais dummy do LocalStack — nunca as reais em dev (§4)
        credentials: {
            accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
            secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
        },
    });
}
