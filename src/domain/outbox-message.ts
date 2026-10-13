import { type IntegrationEvent } from "./events/integration-event";

// Outbox persistente (seção 6.5): evento enfileirado na MESMA transação SQL
// da mudança financeira; worker publica depois do commit (seção 11).

export interface OutboxMessageState {
    id: string;
    aggregateId: string;
    eventType: string;
    payload: Readonly<Record<string, unknown>>;
    occurredAt: Date;
    attempts: number;
    nextAttemptAt?: Date;
    publishedAt?: Date;
}

// backoff exponencial: 1s, 2s, 4s... com teto de 5 min (decisão documentada no ARCHITECTURE)
const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 5 * 60 * 1_000;

export class OutboxMessage {
    private constructor(
        public readonly id: string,
        public readonly aggregateId: string,
        public readonly eventType: string,
        public readonly payload: Readonly<Record<string, unknown>>,
        public readonly occurredAt: Date,
        private _attempts: number,
        private _nextAttemptAt?: Date,
        private _publishedAt?: Date,
    ) { }

    static enqueue(event: IntegrationEvent<unknown>): OutboxMessage {
        return new OutboxMessage(
            event.eventId, event.aggregateId, event.eventType,
            event.toJSON() as Readonly<Record<string, unknown>>,
            event.occurredAt, 0,
        );
    }

    /** reconstrução do banco — sem revalidar */
    static rehydrate(state: OutboxMessageState): OutboxMessage {
        return new OutboxMessage(
            state.id, state.aggregateId, state.eventType, state.payload,
            state.occurredAt, state.attempts, state.nextAttemptAt, state.publishedAt,
        );
    }

    get attempts(): number { return this._attempts; }
    get nextAttemptAt(): Date | undefined { return this._nextAttemptAt; }
    get publishedAt(): Date | undefined { return this._publishedAt; }

    isPending(): boolean {
        return this._publishedAt === undefined;
    }

    /** pronta para o worker publicar: pendente e sem espera (ou com espera vencida) */
    isDue(now: Date): boolean {
        return this.isPending()
            && (this._nextAttemptAt === undefined || this._nextAttemptAt <= now);
    }

    markPublished(at: Date): void {
        this._publishedAt = at;
    }

    /** incrementa attempts e agenda o próximo nextAttemptAt (backoff exponencial) */
    scheduleRetry(now: Date): void {
        this._attempts += 1;
        const backoff = Math.min(RETRY_BASE_MS * 2 ** (this._attempts - 1), RETRY_MAX_MS);
        this._nextAttemptAt = new Date(now.getTime() + backoff);
    }
}
