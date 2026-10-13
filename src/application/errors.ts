// Erros da camada de aplicação — a camada de interfaces (HTTP) os mapeia
// para status distintos (seção 9: conflito ≠ rejeição ≠ falha transitória).

/** Conflito: recurso duplicado ou idempotency key com payload divergente (→ 409) */
export class ConflictError extends Error {
    constructor(public readonly code: string, options?: { cause?: unknown }) {
        super(`Conflict: ${code}`, options);
        this.name = "ConflictError";
    }
}

/** Recurso inexistente (→ 404) */
export class NotFoundError extends Error {
    constructor(public readonly code: string) {
        super(`Not found: ${code}`);
        this.name = "NotFoundError";
    }
}

/** Wallet movida por outra transação/instância entre leitura e commit — o use case tenta de novo */
export class ConcurrencyConflictError extends Error {
    constructor(options?: { cause?: unknown }) {
        super("Concurrency conflict on wallet version", options);
        this.name = "ConcurrencyConflictError";
    }
}

/** Requisição malformada do ponto de vista da aplicação (→ 400) — cursor, limit etc. */
export class InvalidRequestError extends Error {
    constructor(public readonly code: string) {
        super(`Invalid request: ${code}`);
        this.name = "InvalidRequestError";
    }
}
