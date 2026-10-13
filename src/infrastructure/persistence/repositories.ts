import type { EntityManager } from "@mikro-orm/core";
import { Money } from "../../domain/money";
import type { Wallet } from "../../domain/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import type { WagerTransaction } from "../../domain/wager-transaction";
import type { OutboxMessage } from "../../domain/outbox-message";
import type {
    WalletRepository,
    WagerTransactionRepository,
    WalletLedgerRepository,
    OutboxRepository,
} from "../../application/ports/persistence";
import {
    WalletMapper,
    WagerTransactionMapper,
    WalletLedgerEntryMapper,
    OutboxMessageMapper,
} from "./mappers";
import { WalletEntity } from "./entities/wallet.entity";
import { WagerTransactionEntity } from "./entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "./entities/wallet-ledger-entry.entity";
import { OutboxMessageEntity } from "./entities/outbox-message.entity";

// Implementações MikroORM das portas. Cada instância recebe o EntityManager da
// transação corrente — os `insert` só enfileiram; o flush único acontece no
// UnitOfWork antes do COMMIT (seção 11).

export class MikroOrmWalletRepository implements WalletRepository {
    constructor(private readonly em: EntityManager) { }

    async findById(id: string): Promise<Wallet | null> {
        const entity = await this.em.findOne(WalletEntity, { id });
        return entity ? WalletMapper.toDomain(entity) : null;
    }

    async findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null> {
        const entity = await this.em.findOne(WalletEntity, { playerId, currency });
        return entity ? WalletMapper.toDomain(entity) : null;
    }

    async insert(wallet: Wallet): Promise<void> {
        await this.em.persist(WalletMapper.toEntity(wallet));
    }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
    constructor(private readonly em: EntityManager) { }

    async findById(id: string): Promise<WagerTransaction | null> {
        const entity = await this.em.findOne(WagerTransactionEntity, { id });
        return entity ? WagerTransactionMapper.toDomain(entity) : null;
    }

    async insert(transaction: WagerTransaction): Promise<void> {
        // FK wallet_id: reference resolvida pelo próprio UoW na ordenação do flush
        const wallet = this.em.getReference(WalletEntity, transaction.walletId);
        await this.em.persist(WagerTransactionMapper.toEntity(transaction, wallet));
    }
}

export class MikroOrmWalletLedgerRepository implements WalletLedgerRepository {
    constructor(private readonly em: EntityManager) { }

    async insert(entry: WalletLedgerEntry): Promise<void> {
        const wallet = this.em.getReference(WalletEntity, entry.walletId);
        const transaction = this.em.getReference(WagerTransactionEntity, entry.transactionId);
        await this.em.persist(WalletLedgerEntryMapper.toEntity(entry, wallet, transaction));
    }

    async calculateBalance(walletId: string, currency: string): Promise<Money> {
        const entries = await this.em.find(WalletLedgerEntryEntity, { wallet: walletId });
        // varredura no domínio: cada lançamento entra como Money — nenhum
        // cálculo em number (eliminatória); O(n) aceitável na escala do desafio
        return entries.reduce<Money>((balance, entry) => {
            const amount = Money.from({ amount: entry.amount, currency: entry.currency });
            return entry.direction === "CREDIT" ? balance.add(amount) : balance.subtract(amount);
        }, Money.zero(currency));
    }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
    constructor(private readonly em: EntityManager) { }

    async insert(message: OutboxMessage): Promise<void> {
        await this.em.persist(OutboxMessageMapper.toEntity(message));
    }
}
