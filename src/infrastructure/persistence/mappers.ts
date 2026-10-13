import { Money } from "../../domain/money";
import { Wallet, type WalletState } from "../../domain/wallet";
import {
    WalletLedgerEntry,
    LedgerDirection,
    type LedgerEntryState,
} from "../../domain/wallet-ledger-entry";
import {
    WagerTransaction,
    WagerTransactionKind,
    WagerTransactionStatus,
    type WagerTransactionState,
    type FailureCode,
} from "../../domain/wager-transaction";
import { OutboxMessage, type OutboxMessageState } from "../../domain/outbox-message";
import { WalletEntity } from "./entities/wallet.entity";
import { WagerTransactionEntity } from "./entities/wager-transaction.entity";
import { WalletLedgerEntryEntity } from "./entities/wallet-ledger-entry.entity";
import { OutboxMessageEntity } from "./entities/outbox-message.entity";

// Mappers entity ↔ domínio: dinheiro vira string decimal exata (nunca number —
// eliminatória) e o domínio nunca vê MikroORM. Round-trip coberto por
// tests/unit/mappers.test.ts; leitura com FK real coberta na integração.

export class WalletMapper {
    static toDomain(entity: WalletEntity): Wallet {
        const state: WalletState = {
            id: entity.id,
            playerId: entity.playerId,
            currency: entity.currency,
            balance: { amount: entity.balance, currency: entity.currency },
            version: entity.version,
            createdAt: entity.createdAt,
            updatedAt: entity.updatedAt,
        };
        return Wallet.rehydrate(state);
    }

    static toEntity(wallet: Wallet): WalletEntity {
        const entity = new WalletEntity();
        entity.id = wallet.id;
        entity.playerId = wallet.playerId;
        entity.currency = wallet.currency;
        entity.balance = wallet.balance.toString(); // "1000.00" — escala fixa
        entity.version = wallet.version;
        entity.createdAt = wallet.createdAt;
        entity.updatedAt = wallet.updatedAt;
        return entity;
    }
}

export class WagerTransactionMapper {
    static toDomain(entity: WagerTransactionEntity): WagerTransaction {
        const state: WagerTransactionState = {
            id: entity.id,
            providerId: entity.providerId,
            externalTransactionId: entity.externalTransactionId,
            idempotencyKey: entity.idempotencyKey,
            payloadHash: entity.payloadHash,
            walletId: entity.wallet.id, // FK carregada parcialmente (PK resolvida)
            playerId: entity.playerId,
            roundId: entity.roundId,
            gameId: entity.gameId,
            kind: entity.kind as WagerTransactionKind,
            money: Money.from({ amount: entity.amount, currency: entity.currency }),
            referenceExternalTransactionId: entity.referenceExternalTransactionId ?? undefined,
            createdAt: entity.createdAt,
            status: entity.status as WagerTransactionStatus,
            referenceTransactionId: entity.referenceTransactionId ?? undefined,
            failureCode: (entity.failureCode ?? undefined) as FailureCode | undefined,
            processedAt: entity.processedAt ?? undefined,
        };
        return WagerTransaction.rehydrate(state);
    }

    /** `wallet` chega como reference do EM — o mapper não consulta, só mapeia */
    static toEntity(transaction: WagerTransaction, wallet: WalletEntity): WagerTransactionEntity {
        const entity = new WagerTransactionEntity();
        entity.id = transaction.id;
        entity.providerId = transaction.providerId;
        entity.externalTransactionId = transaction.externalTransactionId;
        entity.idempotencyKey = transaction.idempotencyKey;
        entity.payloadHash = transaction.payloadHash;
        entity.wallet = wallet;
        entity.playerId = transaction.playerId;
        entity.roundId = transaction.roundId;
        entity.gameId = transaction.gameId;
        entity.kind = transaction.kind;
        entity.status = transaction.status;
        entity.amount = transaction.money.toJSON().amount;
        entity.currency = transaction.money.currency;
        entity.referenceExternalTransactionId = transaction.referenceExternalTransactionId ?? null;
        entity.referenceTransactionId = transaction.referenceTransactionId ?? null;
        entity.failureCode = transaction.failureCode ?? null;
        entity.createdAt = transaction.createdAt;
        entity.processedAt = transaction.processedAt ?? null;
        // updated_at é not null no schema e não existe no domínio (§6.3 não prevê):
        // última transição conhecida da transação
        entity.updatedAt = transaction.processedAt ?? transaction.createdAt;
        return entity;
    }
}

export class WalletLedgerEntryMapper {
    static toDomain(entity: WalletLedgerEntryEntity): WalletLedgerEntry {
        const state: LedgerEntryState = {
            id: entity.id,
            walletId: entity.wallet.id,
            transactionId: entity.transaction.id,
            direction: entity.direction as LedgerDirection,
            money: Money.from({ amount: entity.amount, currency: entity.currency }),
            balanceBefore: Money.from({ amount: entity.balanceBefore, currency: entity.currency }),
            balanceAfter: Money.from({ amount: entity.balanceAfter, currency: entity.currency }),
            createdAt: entity.createdAt,
        };
        return WalletLedgerEntry.rehydrate(state);
    }

    static toEntity(
        entry: WalletLedgerEntry,
        wallet: WalletEntity,
        transaction: WagerTransactionEntity,
    ): WalletLedgerEntryEntity {
        const entity = new WalletLedgerEntryEntity();
        entity.id = entry.id;
        entity.wallet = wallet;
        entity.transaction = transaction;
        entity.direction = entry.direction;
        entity.amount = entry.money.toJSON().amount;
        entity.currency = entry.money.currency;
        entity.balanceBefore = entry.balanceBefore.toJSON().amount;
        entity.balanceAfter = entry.balanceAfter.toJSON().amount;
        entity.createdAt = entry.createdAt; // sem updatedAt: imutabilidade estrutural (§6.4)
        return entity;
    }
}

export class OutboxMessageMapper {
    static toDomain(entity: OutboxMessageEntity): OutboxMessage {
        const state: OutboxMessageState = {
            id: entity.id,
            aggregateId: entity.aggregateId,
            eventType: entity.eventType,
            payload: entity.payload as Readonly<Record<string, unknown>>,
            occurredAt: entity.occurredAt,
            attempts: entity.attempts,
            nextAttemptAt: entity.nextAttemptAt ?? undefined,
            publishedAt: entity.publishedAt ?? undefined,
        };
        return OutboxMessage.rehydrate(state);
    }

    static toEntity(message: OutboxMessage): OutboxMessageEntity {
        const entity = new OutboxMessageEntity();
        entity.id = message.id;
        entity.aggregateId = message.aggregateId;
        entity.eventType = message.eventType as OutboxMessageEntity["eventType"];
        entity.payload = message.payload as Record<string, unknown>;
        entity.occurredAt = message.occurredAt;
        entity.attempts = message.attempts;
        entity.nextAttemptAt = message.nextAttemptAt ?? null;
        entity.publishedAt = message.publishedAt ?? null;
        return entity;
    }
}
