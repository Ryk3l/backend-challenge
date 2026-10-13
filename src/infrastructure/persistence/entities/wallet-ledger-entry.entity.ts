import { defineEntity, p } from "@mikro-orm/postgresql";
import { WalletEntity } from "./wallet.entity";
import { WagerTransactionEntity } from "./wager-transaction.entity";

export const WalletLedgerEntryEntitySchema = defineEntity({
    name: "WalletLedgerEntryEntity",
    tableName: "wallet_ledger_entries",
    // Uma transação produz no máximo um lançamento por wallet (§6.4)
    uniques: [
        { name: "uq_ledger_transaction_wallet", properties: ["transaction", "wallet"] },
    ],
    // Paginação por cursor de GET /wallets/:id/ledger: filtra por wallet e varre por data
    indexes: [
        { name: "idx_ledger_wallet_created_at", properties: ["wallet", "createdAt"] },
    ],
    // before ± amount = after — a fórmula da §6.4 validada também no banco
    checks: [
        {
            name: "chk_ledger_balanced",
            expression: "(direction = 'CREDIT' AND balance_after = balance_before + amount) OR (direction = 'DEBIT' AND balance_after = balance_before - amount)",
        },
    ],
    // Imutabilidade no schema (§5): o ledger é append-only — UPDATE e DELETE nunca passam
    triggers: [
        {
            name: "trg_wallet_ledger_append_only",
            timing: "before",
            events: ["update", "delete"],
            body: "raise exception 'wallet_ledger_entries is append-only'",
        },
    ],
    properties: {
        id: p.uuid().primary(),
        wallet: p.manyToOne(WalletEntity),
        transaction: p.manyToOne(WagerTransactionEntity),
        direction: p.enum(["DEBIT", "CREDIT"]),
        amount: p.decimal().precision(18).scale(2).check("amount >= 0"),
        currency: p.string().length(3),
        balanceBefore: p.decimal().precision(18).scale(2).check("balance_before >= 0"),
        balanceAfter: p.decimal().precision(18).scale(2).check("balance_after >= 0"),
        createdAt: p.datetime(),
    },
});

export class WalletLedgerEntryEntity extends WalletLedgerEntryEntitySchema.class { }
WalletLedgerEntryEntitySchema.setClass(WalletLedgerEntryEntity);