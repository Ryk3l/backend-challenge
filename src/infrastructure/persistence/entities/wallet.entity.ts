import { defineEntity, p } from "@mikro-orm/postgresql";

export const WalletEntitySchema = defineEntity({
    name: "WalletEntity",
    tableName: "wallets",
    // UNIQUE (player_id, currency) — 1 wallet por playerId + moeda (seção 6.2)
    uniques: [
        { name: "uq_wallets_player_currency", properties: ["playerId", "currency"] },
    ],
    properties: {
        id: p.uuid().primary(),
        playerId: p.uuid(),
        currency: p.string().length(3),
        balance: p.decimal().precision(18).scale(2).check("balance >= 0"),
        version: p.integer().version(),
        createdAt: p.datetime(),
        updatedAt: p.datetime(),
    },
});

export class WalletEntity extends WalletEntitySchema.class { }
WalletEntitySchema.setClass(WalletEntity);