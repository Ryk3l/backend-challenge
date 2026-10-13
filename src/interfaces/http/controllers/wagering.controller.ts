import { Body, Controller, Get, Headers, Inject, Param, Post, Res } from "@nestjs/common";
import type { Response } from "express";
import type {
    SubmitTransaction,
    SubmitTransactionCommand,
} from "../../../application/use-cases/submit-transaction";
import type { GetTransaction } from "../../../application/use-cases/get-transaction";
import { WagerTransactionStatus } from "../../../domain/wager-transaction";
import * as tokens from "../tokens";
import { asKind, asMoney, optionalString, reject400, requireString } from "../http-input";

/**
 * Status HTTP por desfecho (§9) — o provedor distingue sem ler mensagem:
 *   200 aplicada · 422 regra de negócio (corpo com failureCode) ·
 *   202 aceita, processamento pendente · 503 infraestrutura (reenviável)
 */
const STATUS_BY_OUTCOME: Record<WagerTransactionStatus, number> = {
    [WagerTransactionStatus.Processed]: 200,
    [WagerTransactionStatus.Rejected]: 422,
    [WagerTransactionStatus.PendingReference]: 202,
    [WagerTransactionStatus.Pending]: 202,
    [WagerTransactionStatus.Failed]: 503,
};

@Controller("wagering/transactions")
export class WageringController {
    constructor(
        @Inject(tokens.SUBMIT_TRANSACTION) private readonly submitTransaction: SubmitTransaction,
        @Inject(tokens.GET_TRANSACTION) private readonly getTransaction: GetTransaction,
    ) { }

    /** GET /wagering/transactions/:transactionId (§9) */
    @Get(":transactionId")
    getOne(@Param("transactionId") transactionId: string) {
        return this.getTransaction.execute(transactionId);
    }

    /**
     * POST /wagering/transactions (§9) — Idempotency-Key é a fonte da verdade;
     * header ausente/vazio é 400 (a API não infere: sem key não há replay).
     */
    @Post()
    async submit(
        @Headers("idempotency-key") idempotencyKey: unknown,
        @Body() body: Record<string, unknown>,
        @Res({ passthrough: true }) res: Response,
    ) {
        if (typeof idempotencyKey !== "string" || idempotencyKey.length === 0)
            reject400("MISSING_IDEMPOTENCY_KEY");

        const command: SubmitTransactionCommand = {
            idempotencyKey,
            providerId: requireString(body.providerId, "providerId"),
            externalTransactionId: requireString(body.externalTransactionId, "externalTransactionId"),
            playerId: requireString(body.playerId, "playerId"),
            walletId: requireString(body.walletId, "walletId"),
            roundId: requireString(body.roundId, "roundId"),
            gameId: requireString(body.gameId, "gameId"),
            kind: asKind(body.kind),
            money: asMoney(body.money),
            referenceExternalTransactionId: optionalString(
                body.referenceExternalTransactionId, "referenceExternalTransactionId",
            ),
        };

        const result = await this.submitTransaction.execute(command);
        res.status(STATUS_BY_OUTCOME[result.status]);
        return {
            transactionId: result.transactionId,
            status: result.status,
            balance: result.balance,
            idempotentReplay: result.idempotentReplay,
            ...(result.failureCode ? { failureCode: result.failureCode } : {}),
        };
    }
}
