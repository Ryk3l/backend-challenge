// Envelope de evento de integração (seção 11 do desafio).
// Uma subclasse concreta por evento — eventType e version vivem no tipo,
// não em string solta no call site.

export interface IntegrationEventProps<T> {
    eventId: string;
    aggregateId: string;
    correlationId: string;
    causationId?: string;
    occurredAt: Date;
    data: T;
}

/** Correlação do fluxo que gerou o evento — propagada para logs (seção 12). */
export interface EventContext {
    correlationId: string;
    causationId?: string;
}

export abstract class IntegrationEvent<T> {
    abstract readonly eventType: string;
    abstract readonly version: number;

    readonly eventId: string;
    readonly aggregateId: string;
    readonly correlationId: string;
    readonly causationId?: string;
    readonly occurredAt: Date;
    readonly data: Readonly<T>;

    protected constructor(props: IntegrationEventProps<T>) {
        this.eventId = props.eventId;
        this.aggregateId = props.aggregateId;
        this.correlationId = props.correlationId;
        this.causationId = props.causationId;
        this.occurredAt = props.occurredAt;
        this.data = Object.freeze(props.data); // payload imutável em runtime
    }

    /** Envelope serializado gravado no payload da outbox (seção 11). */
    toJSON(): {
        eventId: string;
        eventType: string;
        aggregateId: string;
        correlationId: string;
        causationId?: string;
        occurredAt: string;   // ISO-8601
        version: number;
        data: T;
    } {
        return {
            eventId: this.eventId,
            eventType: this.eventType,
            aggregateId: this.aggregateId,
            correlationId: this.correlationId,
            causationId: this.causationId,
            occurredAt: this.occurredAt.toISOString(),
            version: this.version,
            data: this.data,
        };
    }
}
