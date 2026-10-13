// Inbox persistente (seção 6.5): dedup do consumidor por (consumerName, messageId).
// A garantia é o UNIQUE no schema — este classe carrega o estado e as regras de nascimento.

export class InvalidInboxError extends Error {
    constructor(public readonly code: string) {
        super(`Invalid inbox message: ${code}`);
        this.name = "InvalidInboxError";
    }
}

export interface ReceiveInboxProps {
    messageId: string;
    consumerName: string;
    payloadHash: string;
}

export interface InboxMessageState extends ReceiveInboxProps {
    receivedAt: Date;
    processedAt?: Date;
}

export class InboxMessage {
    private constructor(
        public readonly messageId: string,
        public readonly consumerName: string,
        public readonly payloadHash: string,
        public readonly receivedAt: Date,
        private _processedAt?: Date,
    ) { }

    static receive(props: ReceiveInboxProps): InboxMessage {
        if (props.messageId.trim() === "")
            throw new InvalidInboxError("EMPTY_MESSAGE_ID");
        if (props.consumerName.trim() === "")
            throw new InvalidInboxError("EMPTY_CONSUMER_NAME");
        if (props.payloadHash.trim() === "")
            throw new InvalidInboxError("EMPTY_PAYLOAD_HASH");
        return new InboxMessage(
            props.messageId, props.consumerName, props.payloadHash, new Date(),
        );
    }

    /** reconstrução do banco — sem revalidar */
    static rehydrate(state: InboxMessageState): InboxMessage {
        return new InboxMessage(
            state.messageId, state.consumerName, state.payloadHash,
            state.receivedAt, state.processedAt,
        );
    }

    get processedAt(): Date | undefined { return this._processedAt; }

    isProcessed(): boolean {
        return this._processedAt !== undefined;
    }

    /** idempotente: reprocessar não sobrescreve o timestamp do 1º processamento */
    markProcessed(at: Date): void {
        this._processedAt ??= at;
    }
}
