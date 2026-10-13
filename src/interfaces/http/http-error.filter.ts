import { Catch, HttpException, Inject, Injectable } from "@nestjs/common";
import type { ExceptionFilter, ArgumentsHost } from "@nestjs/common";
import type { Response } from "express";
import {
    ConflictError,
    ConcurrencyConflictError,
    InvalidRequestError,
    NotFoundError,
} from "../../application/errors";
import type { LoggerPort } from "../../application/ports/observability";
import type { MetricsPort } from "../../application/ports/metrics";
import { InvalidMoneyError } from "../../domain/money";
import {
    InvalidTransactionError,
    InvalidTransactionStateError,
} from "../../domain/wager-transaction";
import * as tokens from "./tokens";

/**
 * Mapeamento único e consistente de erros → status HTTP (§9):
 *
 *   400 payload inválido (corpo, cursor, Money, kind, referência obrigatória)
 *   404 wallet/transação inexistente
 *   409 conflito de idempotência (key com payload divergente, duplicatas)
 *   503 falha transitória de infraestrutura — retryable, o provedor PODE reenviar
 *   500 inesperado (logado; nunca vaza stack para o provedor)
 *
 * REJECTED (422) e PENDING_REFERENCE (202) não são erros: o controller deriva
 * o status do resultado do use case.
 */
@Catch()
@Injectable()
export class HttpErrorFilter implements ExceptionFilter {
    constructor(
        @Inject(tokens.LOGGER) private readonly logger: LoggerPort,
        @Inject(tokens.METRICS) private readonly metrics: MetricsPort,
    ) { }

    catch(exception: unknown, host: ArgumentsHost): void {
        const res = host.switchToHttp().getResponse<Response>();
        const { status, body } = mapException(exception);
        this.metrics.increment("http_errors_total", { status: String(status) });
        if (status >= 500) {
            // nunca vaza stack para o provedor; o log carrega o detalhe (§12)
            this.logger.error("unhandled_exception", {
                status,
                error: exception instanceof Error ? exception.message : String(exception),
            });
        }
        res.status(status).json(body);
    }
}

function mapException(exception: unknown): { status: number; body: Record<string, unknown> } {
    if (exception instanceof NotFoundError)
        return { status: 404, body: { error: "NOT_FOUND", code: exception.code } };

    if (exception instanceof ConflictError)
        return { status: 409, body: { error: "CONFLICT", code: exception.code } };

    if (exception instanceof ConcurrencyConflictError)
        return {
            status: 503,
            body: { error: "SERVICE_UNAVAILABLE", code: "CONCURRENCY_CONFLICT", retryable: true },
        };

    if (exception instanceof InvalidRequestError)
        return { status: 400, body: { error: "INVALID_PAYLOAD", code: exception.code } };

    // erros de domínio na validação de entrada
    if (
        exception instanceof InvalidMoneyError
        || exception instanceof InvalidTransactionError
        || exception instanceof InvalidTransactionStateError
    )
        return {
            status: 400,
            body: { error: "INVALID_PAYLOAD", code: errorCodeOf(exception) },
        };

    // JSON malformado: o parser do express lança SyntaxError com o corpo anexado
    if (exception instanceof SyntaxError && "body" in exception)
        return { status: 400, body: { error: "INVALID_PAYLOAD", code: "INVALID_JSON" } };

    if (exception instanceof HttpException) {
        const response = exception.getResponse();
        if (typeof response === "string")
            return { status: exception.getStatus(), body: { error: "INVALID_PAYLOAD", code: response } };
        const body = response as Record<string, unknown>;
        // 400 embrulhado pelo próprio Nest (ex.: body JSON malformado, vindo do
        // body parser) — reconhecido pela AUSÊNCIA do nosso `code` e normalizado
        // para o mesmo vocabulário dos nossos 400
        if (!("code" in body))
            return {
                status: exception.getStatus(),
                body: { error: "INVALID_PAYLOAD", code: "BAD_REQUEST", message: body.message },
            };
        return { status: exception.getStatus(), body };
    }

    return { status: 500, body: { error: "INTERNAL", code: "UNEXPECTED" } };
}

function errorCodeOf(error: unknown): string {
    const code = (error as { code?: unknown }).code;
    return typeof code === "string" ? code : "INVALID_INPUT";
}
