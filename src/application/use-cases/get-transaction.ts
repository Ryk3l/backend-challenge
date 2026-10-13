import { NotFoundError } from "../errors";
import type { MoneyProps } from "../../domain/money";
import {
    type WagerTransaction,
    type WagerTransactionKind,
    type WagerTransactionStatus,
    FailureCode,
} from "../../domain/wager-transaction";
import { type UnitOfWork } from "../ports/persistence";

export interface GetTransactionResult {
    id: string;
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    status: WagerTransactionStatus;
    money: MoneyProps;
    referenceExternalTransactionId?: string;
    referenceTransactionId?: string;
    failureCode?: FailureCode;
    /** saldo da wallet observado na transição — o mesmo do replay idempotente (§9) */
    observedBalance?: MoneyProps;
    createdAt: Date;
    processedAt?: Date;
}

/**
 * GET /wagering/transactions/:transactionId e
 * GET /providers/:providerId/wagering/transactions/:externalTransactionId (§9).
 */
export class GetTransaction {
    constructor(private readonly uow: UnitOfWork) { }

    async execute(transactionId: string): Promise<GetTransactionResult> {
        return this.uow.run(async (session) => {
            const transaction = await session.transactions.findById(transactionId);
            if (!transaction) throw new NotFoundError("TRANSACTION_NOT_FOUND");
            return toView(transaction);
        });
    }

    async executeByExternal(providerId: string, externalTransactionId: string): Promise<GetTransactionResult> {
        return this.uow.run(async (session) => {
            const transaction = await session.transactions.findByProviderAndExternal(
                providerId, externalTransactionId,
            );
            if (!transaction) throw new NotFoundError("TRANSACTION_NOT_FOUND");
            return toView(transaction);
        });
    }
}

function toView(transaction: WagerTransaction): GetTransactionResult {
    return {
        id: transaction.id,
        providerId: transaction.providerId,
        externalTransactionId: transaction.externalTransactionId,
        playerId: transaction.playerId,
        walletId: transaction.walletId,
        roundId: transaction.roundId,
        gameId: transaction.gameId,
        kind: transaction.kind,
        status: transaction.status,
        money: transaction.money.toJSON(),
        referenceExternalTransactionId: transaction.referenceExternalTransactionId,
        referenceTransactionId: transaction.referenceTransactionId,
        failureCode: transaction.failureCode,
        observedBalance: transaction.observedBalance?.toJSON(),
        createdAt: transaction.createdAt,
        processedAt: transaction.processedAt,
    };
}
