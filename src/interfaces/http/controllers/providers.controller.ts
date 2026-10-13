import { Controller, Get, Inject, Param } from "@nestjs/common";
import type { GetTransaction } from "../../../application/use-cases/get-transaction";
import * as tokens from "../tokens";

// DI explícita por token — o Bun não emite decorator metadata (ver app.module)
@Controller("providers")
export class ProvidersController {
    constructor(
        @Inject(tokens.GET_TRANSACTION) private readonly getTransaction: GetTransaction,
    ) { }

    /** GET /providers/:providerId/wagering/transactions/:externalTransactionId (§9) */
    @Get(":providerId/wagering/transactions/:externalTransactionId")
    getByExternal(
        @Param("providerId") providerId: string,
        @Param("externalTransactionId") externalTransactionId: string,
    ) {
        return this.getTransaction.executeByExternal(providerId, externalTransactionId);
    }
}
