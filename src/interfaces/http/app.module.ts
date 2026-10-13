import "reflect-metadata";
import { Module, Inject, Injectable, type OnApplicationShutdown } from "@nestjs/common";
import { APP_FILTER } from "@nestjs/core";
import { MikroORM } from "@mikro-orm/postgresql";
import { type SQSClient } from "@aws-sdk/client-sqs";
import ormConfig from "../../../mikro-orm.config";
import { MikroOrmUnitOfWork } from "../../infrastructure/persistence/unit-of-work";
import type { UnitOfWork } from "../../application/ports/persistence";
import { CreateWallet } from "../../application/use-cases/create-wallet";
import { SubmitTransaction } from "../../application/use-cases/submit-transaction";
import { GetWallet } from "../../application/use-cases/get-wallet";
import { GetWalletLedger } from "../../application/use-cases/get-wallet-ledger";
import { GetTransaction } from "../../application/use-cases/get-transaction";
import { ReconcileWallet } from "../../application/use-cases/reconcile-wallet";
import { ReprocessPendingReferences } from "../../application/use-cases/reprocess-pending-references";
import { createSqsClient } from "../../infrastructure/messaging/sqs-client";
import { WagerTransactionConsumer } from "../../infrastructure/messaging/sqs-consumer";
import { OutboxPublisher } from "../../infrastructure/messaging/outbox-publisher";
import { StdoutLogger } from "../../infrastructure/observability/stdout-logger";
import { InMemoryMetrics } from "../../infrastructure/observability/in-memory-metrics";
import type { LoggerPort } from "../../application/ports/observability";
import type { MetricsPort } from "../../application/ports/metrics";
import * as tokens from "./tokens";
import { HttpErrorFilter } from "./http-error.filter";
import { WalletsController } from "./controllers/wallets.controller";
import { WageringController } from "./controllers/wagering.controller";
import { ProvidersController } from "./controllers/providers.controller";
import { HealthController } from "./controllers/health.controller";

/** Fecha o Postgres no shutdown — app.close() e SIGTERM (via enableShutdownHooks) */
@Injectable()
export class OrmShutdown implements OnApplicationShutdown {
    constructor(@Inject(tokens.MIKRO_ORM) private readonly orm: MikroORM) { }

    async onApplicationShutdown(): Promise<void> {
        await this.orm.close(true);
    }
}

/**
 * SIGTERM (§10): para os workers — cada um conclui o que está em andamento
 * antes de sair; mensagens não confirmadas voltam para a fila (visibility
 * timeout) e a outbox pendente fica para a próxima instância.
 */
@Injectable()
export class WorkersLifecycle implements OnApplicationShutdown {
    constructor(
        @Inject(tokens.WAGER_TRANSACTIONS_CONSUMER) private readonly consumer: WagerTransactionConsumer,
        @Inject(tokens.OUTBOX_PUBLISHER) private readonly publisher: OutboxPublisher,
        @Inject(tokens.REPROCESS_PENDING_REFERENCES) private readonly reprocessor: ReprocessPendingReferences,
    ) { }

    onApplicationShutdown(): void {
        this.consumer.stop();
        this.publisher.stop();
        this.reprocessor.stop();
    }
}

/**
 * Composition root (§3 — camada interfaces): o ÚNICO lugar que conhece
 * implementações concretas. Domínio, aplicação e infraestrutura não importam Nest.
 *
 * DI explícita: o Bun não emite `emitDecoratorMetadata`, então usamos tokens de
 * injeção + `@Inject` nos controllers e `useFactory` nos providers — padrão
 * suportado do Nest, sem depender do metadata de design-time.
 */
@Module({
    controllers: [WalletsController, WageringController, ProvidersController, HealthController],
    providers: [
        { provide: tokens.MIKRO_ORM, useFactory: async () => MikroORM.init(ormConfig) },
        OrmShutdown,
        {
            provide: tokens.UNIT_OF_WORK,
            useFactory: (orm: MikroORM, metrics: MetricsPort) => new MikroOrmUnitOfWork(orm, metrics),
            inject: [tokens.MIKRO_ORM, tokens.METRICS],
        },
        // observabilidade (§12): porta + implementação concreta; a aplicação
        // só conhece LoggerPort/MetricsPort, nunca o stdout/in-memory
        { provide: tokens.LOGGER, useFactory: () => new StdoutLogger() },
        { provide: tokens.METRICS, useFactory: () => new InMemoryMetrics() },
        {
            provide: tokens.CREATE_WALLET,
            useFactory: (uow: UnitOfWork) => new CreateWallet(uow),
            inject: [tokens.UNIT_OF_WORK],
        },
        {
            provide: tokens.SUBMIT_TRANSACTION,
            useFactory: (uow: UnitOfWork, logger: LoggerPort, metrics: MetricsPort) =>
                new SubmitTransaction(uow, logger, metrics),
            inject: [tokens.UNIT_OF_WORK, tokens.LOGGER, tokens.METRICS],
        },
        {
            provide: tokens.GET_WALLET,
            useFactory: (uow: UnitOfWork) => new GetWallet(uow),
            inject: [tokens.UNIT_OF_WORK],
        },
        {
            provide: tokens.GET_WALLET_LEDGER,
            useFactory: (uow: UnitOfWork) => new GetWalletLedger(uow),
            inject: [tokens.UNIT_OF_WORK],
        },
        {
            provide: tokens.GET_TRANSACTION,
            useFactory: (uow: UnitOfWork) => new GetTransaction(uow),
            inject: [tokens.UNIT_OF_WORK],
        },
        {
            provide: tokens.RECONCILE_WALLET,
            useFactory: (uow: UnitOfWork, logger: LoggerPort, metrics: MetricsPort) =>
                new ReconcileWallet(uow, logger, metrics),
            inject: [tokens.UNIT_OF_WORK, tokens.LOGGER, tokens.METRICS],
        },
        // filtro global: todos os endpoints falam o mesmo vocabulário de erro (§9)
        { provide: APP_FILTER, useClass: HttpErrorFilter },
        // mensageria (§10/§11) — instanciados aqui, iniciados no main.ts;
        // testes chamam os passes unitários (processAvailable/publishOnce/tick)
        { provide: tokens.SQS_CLIENT, useFactory: createSqsClient },
        {
            provide: tokens.WAGER_TRANSACTIONS_CONSUMER,
            useFactory: (client: SQSClient, submit: SubmitTransaction, logger: LoggerPort, metrics: MetricsPort) =>
                new WagerTransactionConsumer(client, submit, logger, metrics),
            inject: [tokens.SQS_CLIENT, tokens.SUBMIT_TRANSACTION, tokens.LOGGER, tokens.METRICS],
        },
        {
            provide: tokens.OUTBOX_PUBLISHER,
            useFactory: (client: SQSClient, uow: UnitOfWork, logger: LoggerPort, metrics: MetricsPort) =>
                new OutboxPublisher(client, uow, logger, metrics),
            inject: [tokens.SQS_CLIENT, tokens.UNIT_OF_WORK, tokens.LOGGER, tokens.METRICS],
        },
        {
            provide: tokens.REPROCESS_PENDING_REFERENCES,
            useFactory: (uow: UnitOfWork, submit: SubmitTransaction) =>
                new ReprocessPendingReferences(uow, submit),
            inject: [tokens.UNIT_OF_WORK, tokens.SUBMIT_TRANSACTION],
        },
        WorkersLifecycle,
    ],
})
export class AppModule { }
