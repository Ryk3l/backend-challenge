// Porta de logging estruturado (§12): o domínio/aplicação não conhece o logger
// concreto — recebe esta porta. Contexto (correlationId, walletId, ...) é
// passado por parâmetro, nunca lido de variável global, para não amarrar o
// código a AsyncLocalStorage.

/** Campos estruturados sempre presentes; o resto são campos livres do evento. */
export interface LogContext {
    correlationId?: string;
    messageId?: string;
    transactionId?: string;
    walletId?: string;
    providerId?: string;
    [key: string]: unknown;
}

export type LogLevel = "debug" | "info" | "warn" | "error";

/**
 * Logs saem como JSON por linha (um objeto por evento) — sem payloads
 * financeiros completos nem dados sensíveis (§12). A implementação concreta
 * decide o destino (stdout no nosso caso).
 */
export interface LoggerPort {
    log(level: LogLevel, event: string, context?: LogContext): void;
    debug(event: string, context?: LogContext): void;
    info(event: string, context?: LogContext): void;
    warn(event: string, context?: LogContext): void;
    error(event: string, context?: LogContext): void;
}
