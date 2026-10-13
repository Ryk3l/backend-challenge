import { Body, Controller, Get, HttpCode, Inject, Param, Post, Query } from "@nestjs/common";
import type { CreateWallet } from "../../../application/use-cases/create-wallet";
import type { GetWallet } from "../../../application/use-cases/get-wallet";
import type { GetWalletLedger } from "../../../application/use-cases/get-wallet-ledger";
import type { ReconcileWallet } from "../../../application/use-cases/reconcile-wallet";
import * as tokens from "../tokens";
import { asMoney, requireString } from "../http-input";

// DI explícita por token — o Bun não emite decorator metadata (ver app.module)
@Controller("wallets")
export class WalletsController {
    constructor(
        @Inject(tokens.CREATE_WALLET) private readonly createWallet: CreateWallet,
        @Inject(tokens.GET_WALLET) private readonly getWallet: GetWallet,
        @Inject(tokens.GET_WALLET_LEDGER) private readonly getWalletLedger: GetWalletLedger,
        @Inject(tokens.RECONCILE_WALLET) private readonly reconcileWallet: ReconcileWallet,
    ) { }

    /** POST /wallets (§9) — 201 na criação; duplicada → 409 via ConflictError */
    @Post()
    create(@Body() body: Record<string, unknown>) {
        return this.createWallet.execute({
            playerId: requireString(body.playerId, "playerId"),
            initialBalance: asMoney(body.initialBalance, "initialBalance"),
        });
    }

    /** GET /wallets/:walletId (§9) */
    @Get(":walletId")
    get(@Param("walletId") walletId: string) {
        return this.getWallet.execute(walletId);
    }

    /** GET /wallets/:walletId/ledger?cursor=...&limit=50 (§9) — cursor opaco e estável */
    @Get(":walletId/ledger")
    ledger(
        @Param("walletId") walletId: string,
        @Query("cursor") cursor?: string,
        @Query("limit") limit?: string,
    ) {
        return this.getWalletLedger.execute({
            walletId,
            cursor: cursor || undefined,
            // NaN/não-numérico chega ao use case e vira 400 INVALID_LIMIT
            limit: limit === undefined || limit === "" ? undefined : Number(limit),
        });
    }

    /**
     * POST /wallets/:walletId/reconciliation (§9) — saldo materializado vs
     * ledger; divergência sinalizada no corpo (nunca corrigida em silêncio).
     */
    @Post(":walletId/reconciliation")
    @HttpCode(200)
    reconciliation(@Param("walletId") walletId: string) {
        return this.reconcileWallet.execute(walletId);
    }
}
