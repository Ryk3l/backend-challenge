import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import type { MikroORM } from "@mikro-orm/postgresql";
import type { SQSClient } from "@aws-sdk/client-sqs";
import type { MetricsPort } from "../../../application/ports/metrics";
import { pingSqs } from "../../../infrastructure/messaging/sqs-client";
import * as tokens from "../tokens";

// health sem autenticação (§9); liveness e readiness separadas (§12)
@Controller("health")
export class HealthController {
    constructor(
        @Inject(tokens.MIKRO_ORM) private readonly orm: MikroORM,
        @Inject(tokens.SQS_CLIENT) private readonly sqs: SQSClient,
        @Inject(tokens.METRICS) private readonly metrics: MetricsPort,
    ) { }

    /** liveness: o processo responde — não toca dependência externa */
    @Get("live")
    live() {
        return { status: "ok", uptimeSeconds: Math.floor(process.uptime()) };
    }

    /** readiness: PostgreSQL e SQS alcançáveis (§12) */
    @Get("ready")
    async ready(@Res({ passthrough: true }) res: Response) {
        const checks: Record<string, "ok" | "down"> = {};
        try {
            await this.orm.em.getConnection().execute("select 1");
            checks.postgres = "ok";
        } catch {
            checks.postgres = "down";
        }
        try {
            await pingSqs(this.sqs);
            checks.sqs = "ok";
        } catch {
            checks.sqs = "down";
        }

        const ready = Object.values(checks).every((check) => check === "ok");
        if (!ready) res.status(503);
        return { status: ready ? "ok" : "unavailable", checks };
    }

    /** expõe métricas no formato Prometheus text (§12) — sem autenticação */
    @Get("metrics")
    metricsEndpoint(@Res({ passthrough: true }) res: Response) {
        res.header("Content-Type", "text/plain; version=0.0.4; charset=utf-8");
        return this.metrics.snapshot();
    }
}
