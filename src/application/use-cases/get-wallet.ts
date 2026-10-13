import { NotFoundError } from "../errors";
import type { MoneyProps } from "../../domain/money";
import { type UnitOfWork } from "../ports/persistence";

export interface GetWalletResult {
    id: string;
    playerId: string;
    balance: MoneyProps;
    version: number;
}

/** GET /wallets/:walletId (§9) — leitura do saldo materializado. */
export class GetWallet {
    constructor(private readonly uow: UnitOfWork) { }

    async execute(walletId: string): Promise<GetWalletResult> {
        return this.uow.run(async (session) => {
            const wallet = await session.wallets.findById(walletId);
            if (!wallet) throw new NotFoundError("WALLET_NOT_FOUND");
            return {
                id: wallet.id,
                playerId: wallet.playerId,
                balance: wallet.balance.toJSON(),
                version: wallet.version,
            };
        });
    }
}
