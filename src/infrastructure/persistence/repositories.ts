import type { EntityManager } from "@mikro-orm/core";
import { LockMode } from "@mikro-orm/core";
import { Money } from "../../domain/money";
import type { Wallet } from "../../domain/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import type { WagerTransaction } from "../../domain/wager-transaction";
import { WagerTransactionStatus } from "../../domain/wager-transaction";
import type { OutboxMessage } from "../../domain/outbox-message";
import type { InboxMessage } from "../../domain/inbox-message";
import { NotFoundError } from "../../application/errors";
import type {
    WalletRepository,
    WagerTransactionRepository,
    WalletLedgerRepository,
    OutboxRepository,
    InboxRepository,
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
import { InboxMessageEntity } from "./entities/inbox-message.entity";

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

    async update(wallet: Wallet): Promise<void> {
        const entity = await this.em.findOne(WalletEntity, { id: wallet.id });
        if (!entity) throw new NotFoundError("WALLET_NOT_FOUND");

        // version NÃO é copiado de propósito: o domínio já incrementou (N → N+1)
        // e o ORM usa o valor ANTIGO da entidade gerenciada no WHERE, gerando
        // `SET version = version + 1` — 0 linhas = conflito otimista (§8)
        entity.balance = wallet.balance.toString();
        entity.updatedAt = wallet.updatedAt;
    }
}

export class MikroOrmWagerTransactionRepository implements WagerTransactionRepository {
    constructor(private readonly em: EntityManager) { }

    async findById(id: string): Promise<WagerTransaction | null> {
        const entity = await this.em.findOne(WagerTransactionEntity, { id });
        return entity ? WagerTransactionMapper.toDomain(entity) : null;
    }

    async findByIdempotencyKey(idempotencyKey: string): Promise<WagerTransaction | null> {
        const entity = await this.em.findOne(WagerTransactionEntity, { idempotencyKey });
        return entity ? WagerTransactionMapper.toDomain(entity) : null;
    }

    async findByProviderAndExternal(providerId: string, externalTransactionId: string): Promise<WagerTransaction | null> {
        const entity = await this.em.findOne(WagerTransactionEntity, { providerId, externalTransactionId });
        return entity ? WagerTransactionMapper.toDomain(entity) : null;
    }

    async existsReversal(
        providerId: string,
        referenceExternalTransactionId: string,
        kind: WagerTransaction["kind"],
    ): Promise<boolean> {
        const count = await this.em.count(WagerTransactionEntity, {
            providerId,
            referenceExternalTransactionId,
            kind,
            status: WagerTransactionStatus.Processed, // só reversão aplicada vale — rejeitada não congela a referência
        });
        return count > 0;
    }

    async findPendingReferences(limit: number): Promise<WagerTransaction[]> {
        // candidatas do worker §7.1: mais antigas primeiro (FIFO de resolução)
        const entities = await this.em.find(
            WagerTransactionEntity,
            { status: WagerTransactionStatus.PendingReference },
            { orderBy: { createdAt: "asc" }, limit },
        );
        return entities.map((entity) => WagerTransactionMapper.toDomain(entity));
    }

    async insert(transaction: WagerTransaction): Promise<void> {
        // FK wallet_id: reference resolvida pelo próprio UoW na ordenação do flush
        const wallet = this.em.getReference(WalletEntity, transaction.walletId);
        await this.em.persist(WagerTransactionMapper.toEntity(transaction, wallet));
    }

    async update(transaction: WagerTransaction): Promise<void> {
        const entity = await this.em.findOne(WagerTransactionEntity, { id: transaction.id });
        if (!entity) throw new NotFoundError("TRANSACTION_NOT_FOUND");

        entity.status = transaction.status;
        entity.referenceTransactionId = transaction.referenceTransactionId ?? null;
        entity.failureCode = transaction.failureCode ?? null;
        entity.processedAt = transaction.processedAt ?? null;
        entity.observedBalance = transaction.observedBalance?.toString() ?? null;
        entity.updatedAt = transaction.processedAt ?? new Date();
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

    async findPage(
        walletId: string,
        after: { createdAt: Date; id: string } | null,
        limit: number,
    ): Promise<WalletLedgerEntry[]> {
        // keyset (createdAt, id) ascendente: sem OFFSET — páginas estáveis
        // mesmo com lançamentos chegando ao fim da tabela (cursor opaco, §9)
        const where = after
            ? {
                wallet: walletId,
                $or: [
                    { createdAt: { $gt: after.createdAt } },
                    { createdAt: after.createdAt, id: { $gt: after.id } },
                ],
            }
            : { wallet: walletId };
        const entries = await this.em.find(WalletLedgerEntryEntity, where, {
            orderBy: { createdAt: "asc", id: "asc" },
            limit,
        });
        return entries.map((entry) => WalletLedgerEntryMapper.toDomain(entry));
    }

    async countByWallet(walletId: string): Promise<number> {
        return this.em.count(WalletLedgerEntryEntity, { wallet: walletId });
    }
}

export class MikroOrmOutboxRepository implements OutboxRepository {
    constructor(private readonly em: EntityManager) { }

    async insert(message: OutboxMessage): Promise<void> {
        await this.em.persist(OutboxMessageMapper.toEntity(message));
    }

    async claimDue(now: Date, limit: number): Promise<OutboxMessage[]> {
        // FOR UPDATE SKIP LOCKED (§11): dois publishers concorrentes
        // reivindicam lotes DIFERENTES — nenhum perde evento e ninguém
        // publica o mesmo duas vezes no fluxo normal
        const entities = await this.em.find(OutboxMessageEntity, {
            publishedAt: null,
            $or: [{ nextAttemptAt: null }, { nextAttemptAt: { $lte: now } }],
        }, {
            orderBy: { nextAttemptAt: "asc", id: "asc" },
            lockMode: LockMode.PESSIMISTIC_PARTIAL_WRITE,
            limit,
        });

        const claimed: OutboxMessage[] = [];
        for (const entity of entities) {
            const message = OutboxMessageMapper.toDomain(entity);
            // claim = scheduleRetry: attempts+1 e próximo vencimento no futuro;
            // o lock morre no commit da claim, mas o backoff impede re-claim
            // imediato por outra instância
            message.scheduleRetry(now);
            entity.attempts = message.attempts;
            entity.nextAttemptAt = message.nextAttemptAt ?? null;
            claimed.push(message);
        }
        await this.em.flush();
        return claimed;
    }

    async markPublished(id: string, at: Date): Promise<void> {
        await this.em.nativeUpdate(OutboxMessageEntity, { id }, { publishedAt: at });
    }
}

/**
 * Inbox persistente (§10): fast-path de dedup; a garantia real é o
 * UNIQUE (consumer_name, message_id) — corrida entre dois consumidores
 * vira DUPLICATE_ROW no flush e cai no replay idempotente.
 */
export class MikroOrmInboxRepository implements InboxRepository {
    constructor(private readonly em: EntityManager) { }

    async exists(consumerName: string, messageId: string): Promise<boolean> {
        const count = await this.em.count(InboxMessageEntity, { consumerName, messageId });
        return count > 0;
    }

    async insert(message: InboxMessage): Promise<void> {
        // processedAt preenchido: a linha só existe se os efeitos commitaram
        // junto — row ausente = nunca vista; row presente = processada (§10)
        message.markProcessed(message.receivedAt);
        const entity = new InboxMessageEntity();
        entity.id = crypto.randomUUID();
        entity.messageId = message.messageId;
        entity.consumerName = message.consumerName;
        entity.payloadHash = message.payloadHash;
        entity.receivedAt = message.receivedAt;
        entity.processedAt = message.processedAt ?? message.receivedAt;
        await this.em.persist(entity);
    }
}
