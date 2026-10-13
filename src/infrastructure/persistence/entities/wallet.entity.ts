import { defineEntity, p } from "@mikro-orm/postgresql";

/**
 * Entidade de PERSISTÊNCIA (camada infrastructure) — espelha a tabela `wallets`.
 * MikroORM v7: usamos a API recomendada `defineEntity` (decorators saíram do
 * @mikro-orm/core na migração v6 → v7 e viraram pacote separado).
 * Regra de camadas: o Wallet de domínio NÃO conhece esta classe —
 * a tradução entre os dois acontece no repositório (Dia 2).
 */
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

        balance: p.decimal().precision(18).scale(2),
        // optimistic locking: o ORM incrementa no flush; o repositório não escreve
        version: p.integer().version(),
        createdAt: p.datetime(),
        updatedAt: p.datetime(),
    },
});

export class WalletEntity extends WalletEntitySchema.class { }
WalletEntitySchema.setClass(WalletEntity);