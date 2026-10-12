import { Money, type MoneyProps } from "./money";
import { LedgerDirection } from "./wallet-ledger-entry";

// ---------- enums de domínio ----------

export enum WagerTransactionKind {
    Opening = "OPENING",     // interno: crédito de abertura da wallet
    Bet = "BET",
    Win = "WIN",
    Loss = "LOSS",
    Refund = "REFUND",
    Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
    Pending = "PENDING",                // aceita, ainda não aplicada
    PendingReference = "PENDING_REFERENCE",  // aguardando transação referenciada
    Processed = "PROCESSED",            // aplicada (terminal)
    Rejected = "REJECTED",              // violação de regra de negócio (terminal)
    Failed = "FAILED",                  // erro permanente de infra (terminal)
}

// ---------- failure codes (seção 7.2 do desafio) ----------

export enum FailureCode {
    INSUFFICIENT_BALANCE = "INSUFFICIENT_BALANCE",
    NEGATIVE_BALANCE_ON_REVERSAL = "NEGATIVE_BALANCE_ON_REVERSAL",
    REFERENCE_REQUIRED = "REFERENCE_REQUIRED",
    REFERENCE_NOT_FOUND = "REFERENCE_NOT_FOUND",
    REFERENCE_ALREADY_REVERSED = "REFERENCE_ALREADY_REVERSED",
    INVALID_KIND_FOR_REFERENCE = "INVALID_KIND_FOR_REFERENCE",
    AMOUNT_DIFFERS_FROM_REFERENCE = "AMOUNT_DIFFERS_FROM_REFERENCE",
    CURRENCY_MISMATCH = "CURRENCY_MISMATCH",
    IDEMPOTENCY_CONFLICT = "IDEMPOTENCY_CONFLICT",
}

// ---------- erros ----------

export class InvalidTransactionStateError extends Error {
    constructor(status: WagerTransactionStatus, action: string) {
        super(`Cannot ${action} a transaction in status ${status}`);
        this.name = "InvalidTransactionStateError";
    }
}

export class InvalidTransactionError extends Error {
    constructor(public readonly code: string) {
        super(`Invalid transaction: ${code}`);
        this.name = "InvalidTransactionError";
    }
}

// ---------- props ----------

export interface CreateWagerTransactionProps {
    id: string;
    providerId: string;
    externalTransactionId: string;
    idempotencyKey: string;
    payloadHash: string;
    walletId: string;
    playerId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: Money;
    referenceExternalTransactionId?: string;
}

export interface WagerTransactionState extends CreateWagerTransactionProps {
    createdAt: Date;
    status: WagerTransactionStatus;
    referenceTransactionId?: string;
    failureCode?: FailureCode;
    processedAt?: Date;
}

// ---------- entidade ----------

export class WagerTransaction {
    private constructor(
        public readonly id: string,
        public readonly providerId: string,
        public readonly externalTransactionId: string,
        public readonly idempotencyKey: string,
        public readonly payloadHash: string,
        public readonly walletId: string,
        public readonly playerId: string,
        public readonly roundId: string,
        public readonly gameId: string,
        public readonly kind: WagerTransactionKind,
        public readonly money: Money,
        public readonly referenceExternalTransactionId: string | undefined,
        public readonly createdAt: Date,
        private _status: WagerTransactionStatus,
        private _referenceTransactionId?: string,
        private _failureCode?: FailureCode,
        private _processedAt?: Date,
    ) { }

    /** Nasce em PENDING. Valida a exigência de referência por kind. */
    static create(props: CreateWagerTransactionProps): WagerTransaction {
        if (Object.values(WagerTransactionKind).includes(props.kind) === false)
            throw new InvalidTransactionError("UNKNOWN_KIND");

        // REFUND e ROLLBACK exigem referência (regra da seção 7)
        const requiresReference =
            props.kind === WagerTransactionKind.Refund ||
            props.kind === WagerTransactionKind.Rollback;
        if (requiresReference && !props.referenceExternalTransactionId)
            throw new InvalidTransactionError(FailureCode.REFERENCE_REQUIRED);

        return new WagerTransaction(
            props.id, props.providerId, props.externalTransactionId,
            props.idempotencyKey, props.payloadHash, props.walletId,
            props.playerId, props.roundId, props.gameId, props.kind,
            props.money, props.referenceExternalTransactionId,
            new Date(), WagerTransactionStatus.Pending,
        );
    }

    /** reconstrução do banco — sem revalidar transições */
    static rehydrate(state: WagerTransactionState): WagerTransaction {
        return new WagerTransaction(
            state.id, state.providerId, state.externalTransactionId,
            state.idempotencyKey, state.payloadHash, state.walletId,
            state.playerId, state.roundId, state.gameId, state.kind,
            state.money, state.referenceExternalTransactionId,
            state.createdAt, state.status, state.referenceTransactionId,
            state.failureCode, state.processedAt,
        );
    }

    // ---------- getters ----------

    get status(): WagerTransactionStatus { return this._status; }
    get referenceTransactionId(): string | undefined { return this._referenceTransactionId; }
    get failureCode(): FailureCode | undefined { return this._failureCode; }
    get processedAt(): Date | undefined { return this._processedAt; }

    // ---------- transições ----------

    markProcessed(referenceTransactionId: string | undefined, at: Date): void {
        this.assertNotTerminal("mark processed");
        this._status = WagerTransactionStatus.Processed;
        this._referenceTransactionId = referenceTransactionId;
        this._processedAt = at;
    }

    markPendingReference(): void {
        this.assertNotTerminal("mark pending reference");
        this._status = WagerTransactionStatus.PendingReference;
    }

    reject(code: FailureCode): void {
        this.assertNotTerminal("reject");
        this._status = WagerTransactionStatus.Rejected;
        this._failureCode = code;
        this._processedAt = new Date();
    }

    fail(code: FailureCode): void {
        this.assertNotTerminal("fail");
        this._status = WagerTransactionStatus.Failed;
        this._failureCode = code;
        this._processedAt = new Date();
    }

    // ---------- consultas de domínio ----------

    isTerminal(): boolean {
        return this._status === WagerTransactionStatus.Processed
            || this._status === WagerTransactionStatus.Rejected
            || this._status === WagerTransactionStatus.Failed;
    }

    /** false para LOSS (não move saldo) */
    affectsBalance(): boolean {
        return this.kind !== WagerTransactionKind.Loss;
    }

    /** true para REFUND e ROLLBACK */
    requiresReference(): boolean {
        return this.kind === WagerTransactionKind.Refund
            || this.kind === WagerTransactionKind.Rollback;
    }

    matchesPayload(payloadHash: string): boolean {
        return this.payloadHash === payloadHash;
    }

    ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
        switch (this.kind) {
            case WagerTransactionKind.Opening:
                return LedgerDirection.Credit;  
            case WagerTransactionKind.Bet:
                return LedgerDirection.Debit;
            case WagerTransactionKind.Win:
            case WagerTransactionKind.Refund:
                return LedgerDirection.Credit;
            case WagerTransactionKind.Rollback: {
                if (!reference)
                    throw new InvalidTransactionError(FailureCode.REFERENCE_REQUIRED);
                return reference.ledgerDirectionFor() === LedgerDirection.Debit
                    ? LedgerDirection.Credit
                    : LedgerDirection.Debit;
            }
            case WagerTransactionKind.Loss:
                throw new InvalidTransactionError("LOSS_HAS_NO_LEDGER");
        }
    }

    // ---------- proteção ----------

    private assertNotTerminal(action: string): void {
        if (this.isTerminal())
            throw new InvalidTransactionStateError(this._status, action);
    }
}