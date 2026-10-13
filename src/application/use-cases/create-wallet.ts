import { randomUUID } from "node:crypto";
import { Money, type MoneyProps } from "../../domain/money";
import { Wallet } from "../../domain/wallet";
import { WalletLedgerEntry, LedgerDirection } from "../../domain/wallet-ledger-entry";
import { WagerTransaction, WagerTransactionKind } from "../../domain/wager-transaction";
import { OutboxMessage } from "../../domain/outbox-message";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-events";
import { payloadHash } from "../payload-hash";
import { ConflictError } from "../errors";
import { type UnitOfWork } from "../ports/persistence";

export interface CreateWalletCommand {
    playerId: string;
    initialBalance: MoneyProps;
    /** repasse do correlationId do request (§12) — gerado se ausente */
    correlationId?: string;
}

/** Mesmo formato do response da seção 9 */
export interface CreateWalletResult {
    id: string;
    playerId: string;
    balance: MoneyProps;
    version: number;
}

/**
 * POST /wallets (seção 9): wallet + transação interna OPENING + lançamento no
 * ledger + eventos na outbox — tudo na MESMA transação SQL (seção 11).
 */
export class CreateWallet {
    constructor(private readonly uow: UnitOfWork) { }

    async execute(command: CreateWalletCommand): Promise<CreateWalletResult> {
        // valida formato (2 casas) e rejeita negativos antes de tocar no banco
        const initialBalance = Money.from(command.initialBalance);
        const correlationId = command.correlationId ?? randomUUID();

        return this.uow.run(async (session) => {
            const existing = await session.wallets.findByPlayerAndCurrency(
                command.playerId, initialBalance.currency,
            );
            // fast-path legível — a garantia real contra corrida é o
            // UNIQUE (player_id, currency) no schema, capturado pelo UnitOfWork
            if (existing) throw new ConflictError("WALLET_ALREADY_EXISTS");

            const wallet = Wallet.open({ playerId: command.playerId, initialBalance });
            await session.wallets.insert(wallet);

            // saldo inicial zero: só a wallet — sem OPENING, ledger ou eventos (§9)
            if (initialBalance.isPositive()) {
                const opening = this.openingTransaction(wallet);
                await session.transactions.insert(opening);

                // Wallet.open já nasceu com o saldo; o ledger documenta a
                // transição 0.00 → inicial e mantém balance == sum(ledger)
                const entry = WalletLedgerEntry.create({
                    id: randomUUID(),
                    walletId: wallet.id,
                    transactionId: opening.id,
                    direction: LedgerDirection.Credit,
                    money: initialBalance,
                    balanceBefore: Money.zero(initialBalance.currency),
                    balanceAfter: initialBalance,
                });
                await session.ledgerEntries.insert(entry);

                const ctx = { correlationId };
                // saldo mudou → WalletBalanceChanged; transação aplicada → Processed
                await session.outbox.insert(
                    OutboxMessage.enqueue(WalletBalanceChanged.from(wallet, entry, ctx)),
                );
                await session.outbox.insert(
                    OutboxMessage.enqueue(WagerTransactionProcessed.from(opening, ctx)),
                );
            }

            return {
                id: wallet.id,
                playerId: wallet.playerId,
                balance: wallet.balance.toJSON(),
                version: wallet.version,
            };
        });
    }

    /** transação interna OPENING: nasce PENDING e vai direto para PROCESSED */
    private openingTransaction(wallet: Wallet): WagerTransaction {
        const transaction = WagerTransaction.create({
            id: randomUUID(),
            providerId: "internal",
            externalTransactionId: wallet.id,          // interno: sem provedor externo
            idempotencyKey: `internal:${wallet.id}`,   // mesmo formato {provider}:{external}
            payloadHash: payloadHash({
                kind: WagerTransactionKind.Opening,
                walletId: wallet.id,
                playerId: wallet.playerId,
                money: wallet.balance.toJSON(),
            }),
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: wallet.id,                        // OPENING não pertence a rodada de jogo
            gameId: "wallet-opening",
            kind: WagerTransactionKind.Opening,
            money: wallet.balance,
        });
        transaction.markProcessed(undefined, new Date());
        return transaction;
    }
}
