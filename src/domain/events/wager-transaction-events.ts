import { randomUUID } from "node:crypto";
import {
    IntegrationEvent,
    type IntegrationEventProps,
    type EventContext,
} from "./integration-event";
import { type MoneyProps } from "../money";
import {
    type WagerTransaction,
    type WagerTransactionKind,
    FailureCode,
    InvalidTransactionError,
} from "../wager-transaction";

// ---------- WagerTransactionProcessed (seção 11: qualquer transação aplicada, inclusive LOSS) ----------

export interface WagerTransactionProcessedData {
    transactionId: string;
    walletId: string;
    providerId: string;
    externalTransactionId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    referenceExternalTransactionId: string | undefined;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
    readonly eventType = "WagerTransactionProcessed";
    readonly version = 1;

    private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
        super(props);
    }

    static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionProcessed {
        return new WagerTransactionProcessed({
            eventId: randomUUID(),
            aggregateId: transaction.id,
            correlationId: ctx.correlationId,
            causationId: ctx.causationId,
            occurredAt: new Date(),
            data: {
                transactionId: transaction.id,
                walletId: transaction.walletId,
                providerId: transaction.providerId,
                externalTransactionId: transaction.externalTransactionId,
                kind: transaction.kind,
                money: transaction.money.toJSON(),
                referenceExternalTransactionId: transaction.referenceExternalTransactionId,
            },
        });
    }
}

// ---------- WagerTransactionRejected (seção 11: rejeição por regra de negócio) ----------

export interface WagerTransactionRejectedData {
    transactionId: string;
    walletId: string;
    providerId: string;
    externalTransactionId: string;
    kind: WagerTransactionKind;
    failureCode: FailureCode;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
    readonly eventType = "WagerTransactionRejected";
    readonly version = 1;

    private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
        super(props);
    }

    static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionRejected {
        const failureCode = transaction.failureCode;
        // invariante: evento de rejeição sempre carrega o código que motivou a rejeição
        if (!failureCode)
            throw new InvalidTransactionError("REJECTED_WITHOUT_FAILURE_CODE");

        return new WagerTransactionRejected({
            eventId: randomUUID(),
            aggregateId: transaction.id,
            correlationId: ctx.correlationId,
            causationId: ctx.causationId,
            occurredAt: new Date(),
            data: {
                transactionId: transaction.id,
                walletId: transaction.walletId,
                providerId: transaction.providerId,
                externalTransactionId: transaction.externalTransactionId,
                kind: transaction.kind,
                failureCode,
            },
        });
    }
}

// ---------- WagerTransactionPendingReference (seção 11: referência ausente) ----------

export interface WagerTransactionPendingReferenceData {
    transactionId: string;
    walletId: string;
    providerId: string;
    externalTransactionId: string;
    kind: WagerTransactionKind;
    referenceExternalTransactionId: string;
}

export class WagerTransactionPendingReference extends IntegrationEvent<WagerTransactionPendingReferenceData> {
    readonly eventType = "WagerTransactionPendingReference";
    readonly version = 1;

    private constructor(props: IntegrationEventProps<WagerTransactionPendingReferenceData>) {
        super(props);
    }

    static from(transaction: WagerTransaction, ctx: EventContext): WagerTransactionPendingReference {
        const reference = transaction.referenceExternalTransactionId;
        // invariante: PENDING_REFERENCE só existe com a referência externa declarada
        if (!reference)
            throw new InvalidTransactionError(FailureCode.REFERENCE_REQUIRED);

        return new WagerTransactionPendingReference({
            eventId: randomUUID(),
            aggregateId: transaction.id,
            correlationId: ctx.correlationId,
            causationId: ctx.causationId,
            occurredAt: new Date(),
            data: {
                transactionId: transaction.id,
                walletId: transaction.walletId,
                providerId: transaction.providerId,
                externalTransactionId: transaction.externalTransactionId,
                kind: transaction.kind,
                referenceExternalTransactionId: reference,
            },
        });
    }
}
