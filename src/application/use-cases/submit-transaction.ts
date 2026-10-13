import { randomUUID } from "node:crypto";
import { Money, type MoneyProps } from "../../domain/money";
import { Wallet, InsufficientBalanceError } from "../../domain/wallet";
import { LedgerDirection, type WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import {
    WagerTransaction,
    WagerTransactionKind,
    WagerTransactionStatus,
    FailureCode,
    InvalidTransactionError,
} from "../../domain/wager-transaction";
import { OutboxMessage } from "../../domain/outbox-message";
import { InboxMessage } from "../../domain/inbox-message";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed";
import {
    WagerTransactionProcessed,
    WagerTransactionRejected,
    WagerTransactionPendingReference,
} from "../../domain/events/wager-transaction-events";
import { payloadHash } from "../payload-hash";
import { ConflictError, NotFoundError, ConcurrencyConflictError } from "../errors";
import { type PersistenceSession, type UnitOfWork } from "../ports/persistence";

export interface SubmitTransactionCommand {
    /** header obrigatório (§9) — fonte da verdade da idempotência */
    idempotencyKey: string;
    providerId: string;
    externalTransactionId: string;
    playerId: string;
    walletId: string;
    roundId: string;
    gameId: string;
    kind: WagerTransactionKind;
    money: MoneyProps;
    /** obrigatório para REFUND/ROLLBACK — validado no domínio (§7) */
    referenceExternalTransactionId?: string;
    /** repasse do correlationId do request (§12) — gerado se ausente */
    correlationId?: string;
    /**
     * preenchido quando a entrada veio da fila (§10): habilita o dedup de
     * reentrega via inbox persistente na MESMA transação dos efeitos
     */
    delivery?: { messageId: string; consumerName: string };
}

export interface SubmitTransactionResult {
    transactionId: string;
    status: WagerTransactionStatus;
    balance: MoneyProps;
    idempotentReplay: boolean;
    /** presente quando status = REJECTED — lido pelo provedor para decidir reenvio (§7.2) */
    failureCode?: FailureCode;
}

// §8: até 3 retries novos além da primeira tentativa
const MAX_RETRIES = 3;
// §7.1: TTL de PENDING_REFERENCE — decisão documentada no ARCHITECTURE
export const DEFAULT_PENDING_TTL_MS = 10 * 60 * 1000;

/**
 * POST /wagering/transactions (§7, §8, §9): idempotência persistente,
 * regras BET/WIN/LOSS/REFUND/ROLLBACK, referências fora de ordem e
 * concorrência otimista com retry limitado sobre a wallet.
 */
export class SubmitTransaction {
    constructor(private readonly uow: UnitOfWork) { }

    async execute(command: SubmitTransactionCommand): Promise<SubmitTransactionResult> {
        // OPENING é interno — não pode ser submetido pela API nem pela fila (§6.3)
        if (command.kind === WagerTransactionKind.Opening)
            throw new InvalidTransactionError("OPENING_NOT_SUBMITTABLE");

        // payloadHash: só campos de negócio — header e transporte ficam fora (§9)
        const hash = payloadHash(businessPayload(command));

        for (let attempt = 0; ; attempt++) {
            try {
                return await this.tryExecute(command, hash);
            } catch (error) {
                // wallet movida por outra instância entre leitura e commit →
                // reexecuta do zero com leitura fresca (retry ≤ 3, §8)
                if (error instanceof ConcurrencyConflictError && attempt < MAX_RETRIES)
                    continue;
                // perdeu a corrida de idempotência: o vencedor já committed,
                // então devolvemos a resposta dele em vez de um erro
                if (error instanceof ConflictError && error.code === "DUPLICATE_ROW")
                    return await this.replayAfterConflict(command, hash);
                throw error;
            }
        }
    }

    private async tryExecute(command: SubmitTransactionCommand, hash: string): Promise<SubmitTransactionResult> {
        return this.uow.run(async (session) => {
            // 0) dedup de reentrega SQS (§10): inbox na MESMA transação dos
            // efeitos — mensagem já vista = o efeito já foi aplicado
            if (command.delivery) {
                const { consumerName, messageId } = command.delivery;
                if (await session.inbox.exists(consumerName, messageId)) {
                    const processed = await session.transactions.findByIdempotencyKey(command.idempotencyKey);
                    // reentrega da mesma mensagem: devolve a resposta original
                    // em vez de repetir efeito — sem transação é estado corrompido
                    if (!processed) throw new ConflictError("INBOX_WITHOUT_TRANSACTION");
                    return replayResult(processed, hash);
                }
                await session.inbox.insert(InboxMessage.receive({
                    messageId, consumerName, payloadHash: hash,
                }));
            }

            // 1) replay: mesma key + mesmo payload = mesma resposta (§9)
            const existing = await session.transactions.findByIdempotencyKey(command.idempotencyKey);
            if (existing) return replayResult(existing, hash);

            // 2) wallet — a unidade de concorrência é a walletId (§8)
            const wallet = await session.wallets.findById(command.walletId);
            if (!wallet) throw new NotFoundError("WALLET_NOT_FOUND");
            const ctx = { correlationId: command.correlationId ?? randomUUID() };

            // 3) nasce PENDING; create() valida a exigência de referência por kind
            const transaction = WagerTransaction.create({
                id: randomUUID(),
                providerId: command.providerId,
                externalTransactionId: command.externalTransactionId,
                idempotencyKey: command.idempotencyKey,
                payloadHash: hash,
                walletId: command.walletId,
                playerId: command.playerId,
                roundId: command.roundId,
                gameId: command.gameId,
                kind: command.kind,
                money: Money.from(command.money),
                referenceExternalTransactionId: command.referenceExternalTransactionId,
            });
            // entra no identity map e no flush; as transições abaixo atualizam a
            // MESMA entidade gerenciada antes do commit (um único INSERT final)
            await session.transactions.insert(transaction);

            // 4) identidade e moeda precisam bater com a wallet (§3/§6.2)
            if (command.playerId !== wallet.playerId)
                return this.reject(session, transaction, wallet, FailureCode.PLAYER_WALLET_MISMATCH, ctx);
            if (transaction.money.currency !== wallet.currency)
                return this.reject(session, transaction, wallet, FailureCode.CURRENCY_MISMATCH, ctx);

            // 5) referência (§7/§7.1)
            let reference: WagerTransaction | undefined;
            if (transaction.requiresReference()) {
                const found = await session.transactions.findByProviderAndExternal(
                    command.providerId, command.referenceExternalTransactionId!,
                );
                if (!found)
                    return this.acceptPending(session, transaction, wallet, ctx);
                reference = found;
                // a referência existe mas ainda espera a dela — aguardamos junto
                if (reference.status === WagerTransactionStatus.PendingReference)
                    return this.acceptPending(session, transaction, wallet, ctx);

                const violation = transaction.referenceViolation(reference);
                if (violation) return this.reject(session, transaction, wallet, violation, ctx);

                // uma referência não pode ser revertida duas vezes pelo MESMO tipo (§7)
                const alreadyReversed = await session.transactions.existsReversal(
                    command.providerId, command.referenceExternalTransactionId!, transaction.kind,
                );
                if (alreadyReversed)
                    return this.reject(session, transaction, wallet, FailureCode.REFERENCE_ALREADY_REVERSED, ctx);
            }

            // 6) aplicar efeito — LOSS registra resultado sem mover saldo (§7)
            return this.applyAndFinish(session, transaction, wallet, reference, ctx);
        });
    }

    /**
     * Aplica os efeitos financeiros e transiciona para estado terminal —
     * trecho único compartilhado entre o submit (HTTP/fila) e o worker de
     * referências fora de ordem (§7.1): regras num lugar só.
     */
    private async applyAndFinish(
        session: PersistenceSession,
        transaction: WagerTransaction,
        wallet: Wallet,
        reference: WagerTransaction | undefined,
        ctx: { correlationId: string },
    ): Promise<SubmitTransactionResult> {
        let entry: WalletLedgerEntry | undefined;
        if (transaction.affectsBalance()) {
            const direction = transaction.ledgerDirectionFor(reference);
            try {
                entry = direction === LedgerDirection.Debit
                    ? wallet.debit(transaction.money, transaction.id)
                    : wallet.credit(transaction.money, transaction.id);
            } catch (error) {
                // reversão que ficaria negativa tem failureCode distinto de
                // aposta sem saldo — situações operacionalmente diferentes (§7)
                if (error instanceof InsufficientBalanceError) {
                    const code = transaction.kind === WagerTransactionKind.Rollback
                        ? FailureCode.NEGATIVE_BALANCE_ON_REVERSAL
                        : FailureCode.INSUFFICIENT_BALANCE;
                    return this.reject(session, transaction, wallet, code, ctx);
                }
                throw error;
            }
            await session.ledgerEntries.insert(entry);
            // otimista: WHERE version = <antigo> — conflito vira retry (§8)
            await session.wallets.update(wallet);
        }

        transaction.markProcessed(reference?.id, new Date());
        transaction.recordObservedBalance(wallet.balance);
        await session.transactions.update(transaction);

        // 7) eventos atômicos com o commit (§11)
        await session.outbox.insert(
            OutboxMessage.enqueue(WagerTransactionProcessed.from(transaction, ctx)),
        );
        if (entry)
            await session.outbox.insert(
                OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx)),
            );

        return resultOf(transaction, false);
    }

    /**
     * §7.1 — worker: tenta resolver uma transação PENDING_REFERENCE.
     * "resolved" aplicou os efeitos; "rejected" esgotou o TTL ou violou regra;
     * "waiting" continua aguardando a referência (o worker tenta de novo).
     */
    async reprocessPending(
        transactionId: string,
        options?: { now?: Date; ttlMs?: number },
    ): Promise<"resolved" | "rejected" | "waiting"> {
        const now = options?.now ?? new Date();
        const ttlMs = options?.ttlMs ?? DEFAULT_PENDING_TTL_MS;
        return this.uow.run(async (session) => {
            const transaction = await session.transactions.findById(transactionId);
            // outra instância já resolveu/rejeitou entre a listagem e aqui —
            // o optimistic lock do wallet cobre a corrida de aplicação dupla
            if (!transaction || transaction.status !== WagerTransactionStatus.PendingReference)
                return "waiting";
            const wallet = await session.wallets.findById(transaction.walletId);
            if (!wallet) throw new NotFoundError("WALLET_NOT_FOUND"); // não ocorre: FK
            const ctx = { correlationId: randomUUID() };

            const reference = await session.transactions.findByProviderAndExternal(
                transaction.providerId, transaction.referenceExternalTransactionId!,
            );
            if (!reference) {
                if (now.getTime() - transaction.createdAt.getTime() > ttlMs) {
                    // TTL esgotado → REJECTED + evento (§7.1)
                    await this.reject(session, transaction, wallet, FailureCode.REFERENCE_NOT_FOUND, ctx);
                    return "rejected";
                }
                return "waiting"; // ainda dentro do TTL — referência pode chegar
            }
            if (reference.status === WagerTransactionStatus.PendingReference)
                return "waiting"; // cadeia de referências ainda em voo

            const violation = transaction.referenceViolation(reference);
            if (violation) {
                await this.reject(session, transaction, wallet, violation, ctx);
                return "rejected";
            }
            const alreadyReversed = await session.transactions.existsReversal(
                transaction.providerId, transaction.referenceExternalTransactionId!, transaction.kind,
            );
            if (alreadyReversed) {
                await this.reject(session, transaction, wallet, FailureCode.REFERENCE_ALREADY_REVERSED, ctx);
                return "rejected";
            }

            const result = await this.applyAndFinish(session, transaction, wallet, reference, ctx);
            return result.status === WagerTransactionStatus.Rejected ? "rejected" : "resolved";
        });
    }

    /** rejeição terminal: sem efeito no saldo, sem ledger, auditável (§7) */
    private async reject(
        session: PersistenceSession,
        transaction: WagerTransaction,
        wallet: Wallet,
        code: FailureCode,
        ctx: { correlationId: string },
    ): Promise<SubmitTransactionResult> {
        transaction.reject(code);
        transaction.recordObservedBalance(wallet.balance);
        await session.transactions.update(transaction);
        await session.outbox.insert(
            OutboxMessage.enqueue(WagerTransactionRejected.from(transaction, ctx)),
        );
        return resultOf(transaction, false);
    }

    /** referência ausente: persiste PENDING_REFERENCE e espera o worker (§7.1) */
    private async acceptPending(
        session: PersistenceSession,
        transaction: WagerTransaction,
        wallet: Wallet,
        ctx: { correlationId: string },
    ): Promise<SubmitTransactionResult> {
        transaction.markPendingReference();
        transaction.recordObservedBalance(wallet.balance);
        await session.transactions.update(transaction);
        await session.outbox.insert(
            OutboxMessage.enqueue(WagerTransactionPendingReference.from(transaction, ctx)),
        );
        return resultOf(transaction, false);
    }

    /** UNIQUE estourou: a outra transação committed — devolve a resposta dela */
    private async replayAfterConflict(
        command: SubmitTransactionCommand,
        hash: string,
    ): Promise<SubmitTransactionResult> {
        const found = await this.uow.run((session) =>
            session.transactions.findByIdempotencyKey(command.idempotencyKey),
        );
        if (found) return replayResult(found, hash);

        // mesma operação lógica sob OUTRA key → conflito real, não replay (§9)
        const byExternal = await this.uow.run((session) =>
            session.transactions.findByProviderAndExternal(command.providerId, command.externalTransactionId),
        );
        if (byExternal) throw new ConflictError(FailureCode.IDEMPOTENCY_CONFLICT);
        throw new ConflictError("DUPLICATE_ROW");
    }
}

/** subconjunto de campos de negócio — algoritmo do hash documentado no ARCHITECTURE */
function businessPayload(command: SubmitTransactionCommand): unknown {
    return {
        providerId: command.providerId,
        externalTransactionId: command.externalTransactionId,
        playerId: command.playerId,
        walletId: command.walletId,
        roundId: command.roundId,
        gameId: command.gameId,
        kind: command.kind,
        money: command.money,
    };
}

function replayResult(existing: WagerTransaction, hash: string): SubmitTransactionResult {
    if (!existing.matchesPayload(hash))
        // mesma key com payload diferente = conflito, e não replay (§9)
        throw new ConflictError(FailureCode.IDEMPOTENCY_CONFLICT);
    return resultOf(existing, true);
}

function resultOf(transaction: WagerTransaction, idempotentReplay: boolean): SubmitTransactionResult {
    return {
        transactionId: transaction.id,
        status: transaction.status,
        // saldo observado na transição original — não o saldo atual da wallet (§7)
        balance: (transaction.observedBalance ?? transaction.money).toJSON(),
        idempotentReplay,
        failureCode: transaction.failureCode,
    };
}
