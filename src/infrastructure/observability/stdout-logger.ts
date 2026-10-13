import type { LoggerPort, LogContext, LogLevel } from "../../application/ports/observability";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * Logger estruturado de produção (§12): um objeto JSON por linha no stdout.
 * - `minLevel` filtra via env `LOG_LEVEL` (default info) para não poluir dev;
 * - contexto (correlationId, walletId, ...) é mergeado no payload do evento;
 * - timestamp e nível sempre presentes; a linha é estável e indexável.
 */
export class StdoutLogger implements LoggerPort {
    private readonly minLevel: number;

    constructor(options?: { minLevel?: LogLevel }) {
        const fromEnv = (process.env.LOG_LEVEL ?? "info") as LogLevel;
        this.minLevel = LEVEL_ORDER[options?.minLevel ?? fromEnv] ?? LEVEL_ORDER.info;
    }

    log(level: LogLevel, event: string, context?: LogContext): void {
        if (LEVEL_ORDER[level] < this.minLevel) return;
        // timestamp + level + event são o núcleo; context entra por merge
        const line = JSON.stringify({ timestamp: new Date().toISOString(), level, event, ...context });
        if (level === "error") console.error(line);
        else console.log(line);
    }

    debug(event: string, context?: LogContext): void { this.log("debug", event, context); }
    info(event: string, context?: LogContext): void { this.log("info", event, context); }
    warn(event: string, context?: LogContext): void { this.log("warn", event, context); }
    error(event: string, context?: LogContext): void { this.log("error", event, context); }
}

/** no-op silencioso — usado nos testes para não poluir a saída do bun test */
export class SilentLogger implements LoggerPort {
    log(): void { /* descarta */ }
    debug(): void { /* descarta */ }
    info(): void { /* descarta */ }
    warn(): void { /* descarta */ }
    error(): void { /* descarta */ }
}
