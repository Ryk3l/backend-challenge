import { Controller, Get, Inject, Res } from "@nestjs/common";
import type { Response } from "express";
import type { MikroORM } from "@mikro-orm/postgresql";
import * as tokens from "../tokens";

// health sem autenticação (§9); liveness e readiness separadas (§12)
@Controller("health")
export class HealthController {
    constructor(@Inject(tokens.MIKRO_ORM) private readonly orm: MikroORM) { }

    /** liveness: o processo responde — não toca dependência externa */
    @Get("live")
    live() {
        return { status: "ok", uptimeSeconds: Math.floor(process.uptime()) };
    }

    /** readiness: PostgreSQL alcançável (ping); SQS entra quando o consumidor da §10 existir */
    @Get("ready")
    async ready(@Res({ passthrough: true }) res: Response) {
        const checks: Record<string, "ok" | "down"> = {};
        try {
            await this.orm.em.getConnection().execute("select 1");
            checks.postgres = "ok";
        } catch {
            checks.postgres = "down";
        }

        const ready = Object.values(checks).every((check) => check === "ok");
        if (!ready) res.status(503);
        return { status: ready ? "ok" : "unavailable", checks };
    }
}
