import { defineEntity, p } from "@mikro-orm/postgresql";
import { WalletEntity } from "./wallet.entity";

export const WagerTransactionEntitySchema = defineEntity({
    name: "WagerTransactionEntity",
    tableName: "wager_transactions",
    // Idempotência persistida no schema (seção 5): mesma operação lógica
    // e mesma Idempotency-Key nunca geram duas linhas.
    uniques: [
        { name: "uq_wager_tx_provider_external", properties: ["providerId", "externalTransactionId"] },
        { name: "uq_wager_tx_idempotency_key", properties: ["idempotencyKey"] },
    ],
    properties: {
        id: p.uuid().primary(),
        providerId: p.string().length(64),
        externalTransactionId: p.string().length(128),
        idempotencyKey: p.string().length(255),
        payloadHash: p.string().length(64), // sha-256 hex do JSON canônico (seção 9)
        wallet: p.manyToOne(WalletEntity), // FK: coluna wallet_id → wallets.id
        playerId: p.uuid(),
        roundId: p.string().length(64),
        gameId: p.string().length(64),
        kind: p.enum(["OPENING", "BET", "WIN", "LOSS", "REFUND", "ROLLBACK"]),
        status: p.enum(["PENDING", "PENDING_REFERENCE", "PROCESSED", "REJECTED", "FAILED"]).index(),
        amount: p.decimal().precision(18).scale(2).check("amount >= 0"),
        currency: p.string().length(3),
        referenceExternalTransactionId: p.string().length(128).nullable(),
        referenceTransactionId: p.uuid().nullable(),
        failureCode: p.string().length(64).nullable(),
        createdAt: p.datetime(),
        processedAt: p.datetime().nullable(),
        // saldo observado na transição terminal — resposta idempotente
        observedBalance: p.decimal().precision(18).scale(2).nullable(),
        updatedAt: p.datetime(),
    },
});

export class WagerTransactionEntity extends WagerTransactionEntitySchema.class { }
WagerTransactionEntitySchema.setClass(WagerTransactionEntity);