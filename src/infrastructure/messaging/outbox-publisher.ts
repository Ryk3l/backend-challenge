import { SendMessageCommand, type SQSClient } from "@aws-sdk/client-sqs";
import type { UnitOfWork } from "../../application/ports/persistence";
import type { LoggerPort } from "../../application/ports/observability";
import type { MetricsPort } from "../../application/ports/metrics";
import { QUEUE_URLS } from "./sqs-client";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
const DEFAULT_BATCH = 10;

/**
 * Worker da outbox (§11): claim com FOR UPDATE SKIP LOCKED + scheduleRetry →
 * publica DEPOIS do commit da claim → marca published em transação nova.
 *
 * Cenário da §11: PG commit → processo morre antes de publicar → o próximo
 * vencimento (backoff do claim) libera a mensagem e OUTRA instância assume.
 * Crash entre publicar e marcar → próxima tentativa republica: at-least-once,
 * seguro para o consumidor.
 */
export class OutboxPublisher {
    private running = false;

    constructor(
        private readonly client: SQSClient,
        private readonly uow: UnitOfWork,
        private readonly logger: LoggerPort,
        private readonly metrics: MetricsPort,
    ) { }

    /** um passe de publicação — retorna quantos eventos saíram */
    async publishOnce(batchSize = DEFAULT_BATCH): Promise<number> {
        const batch = await this.uow.run((session) =>
            session.outbox.claimDue(new Date(), batchSize),
        );
        let published = 0;
        for (const message of batch) {
            try {
                await this.client.send(new SendMessageCommand({
                    QueueUrl: QUEUE_URLS.events,
                    MessageBody: JSON.stringify(message.payload),
                    MessageGroupId: message.aggregateId,      // ordenação por wallet
                    MessageDeduplicationId: message.id,       // janela FIFO de 5 min
                }));
                await this.uow.run((session) =>
                    session.outbox.markPublished(message.id, new Date()),
                );
                this.metrics.increment("outbox_published_total", { eventType: message.eventType });
                // lag de publicação (§12): ocorrência → publicação, em milissegundos
                this.metrics.observe("outbox_lag_ms", Date.now() - message.occurredAt.getTime());
                published++;
            } catch (error) {
                // falha de publicação: o claim já agendou o próximo vencimento —
                // esta ou outra instância tenta de novo na próxima janela
                this.metrics.increment("outbox_publish_failed_total");
                this.logger.warn("outbox_publish_failed", {
                    eventId: message.id,
                    retryable: true,
                });
            }
        }
        return published;
    }

    /** loop contínuo; drena backlog sem esperar o tick quando publica em lote */
    async start(pollMs = 500): Promise<void> {
        this.running = true;
        while (this.running) {
            try {
                if ((await this.publishOnce()) > 0) continue;
            } catch (error) {
                this.logger.error("outbox_poll_failed", {
                    error: error instanceof Error ? error.name : "unknown",
                });
            }
            // re-checa antes de dormir: stop() durante um passe não espera o tick
            if (this.running) await sleep(pollMs);
        }
    }

    stop(): void { this.running = false; }
}
