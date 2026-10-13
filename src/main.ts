import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./interfaces/http/app.module";
import * as tokens from "./interfaces/http/tokens";
import type { LoggerPort } from "./application/ports/observability";
import { ensureQueues } from "./infrastructure/messaging/queues";
import type { WagerTransactionConsumer } from "./infrastructure/messaging/sqs-consumer";
import type { OutboxPublisher } from "./infrastructure/messaging/outbox-publisher";
import type { ReprocessPendingReferences } from "./application/use-cases/reprocess-pending-references";
import type { SQSClient } from "@aws-sdk/client-sqs";

// bootstrap da API HTTP (§9) — o wiring todo mora em interfaces/http/app.module
async function bootstrap(): Promise<void> {
    const app = await NestFactory.create(AppModule);
    const logger = app.get<LoggerPort>(tokens.LOGGER);

    // SIGTERM → onApplicationShutdown: workers param e conexões fecham depois
    // de concluir o andamento (§10)
    app.enableShutdownHooks();

    const port = Number(process.env.PORT ?? 3000);
    await app.listen(port);
    logger.info("listening", { port });

    // workers (§10/§11): mesma instância do processo HTTP — SQS compete entre
    // consumidores, então várias instâncias rodam os mesmos loops com segurança.
    // WORKERS=disabled desliga (ex.: teste de HTTP puro).
    if (process.env.WORKERS !== "disabled") {
        await ensureQueues(app.get<SQSClient>(tokens.SQS_CLIENT));
        void app.get<WagerTransactionConsumer>(tokens.WAGER_TRANSACTIONS_CONSUMER).start();
        void app.get<OutboxPublisher>(tokens.OUTBOX_PUBLISHER).start();
        void app.get<ReprocessPendingReferences>(tokens.REPROCESS_PENDING_REFERENCES).start();
        logger.info("workers_started");
    }
}

void bootstrap();
