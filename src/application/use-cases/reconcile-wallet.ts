import { NotFoundError } from "../errors";
import type { MoneyProps } from "../../domain/money";
import { type UnitOfWork } from "../ports/persistence";

export interface ReconcileWalletResult {
    walletId: string;
    storedBalance: MoneyProps;
    calculatedBalance: MoneyProps;
    difference: MoneyProps;
    consistent: boolean;
    checkedEntries: number;
}

/**
 * POST /wallets/:walletId/reconciliation (§9): saldo materializado (wallet)
 * versus saldo reconstruído pelo ledger. Divergência NUNCA é corrigida em
 * silêncio — é sinalizada na resposta, logada e (§12) contada em métrica.
 */
export class ReconcileWallet {
    constructor(private readonly uow: UnitOfWork) { }

    async execute(walletId: string): Promise<ReconcileWalletResult> {
        return this.uow.run(async (session) => {
            const wallet = await session.wallets.findById(walletId);
            if (!wallet) throw new NotFoundError("WALLET_NOT_FOUND");

            const calculated = await session.ledgerEntries.calculateBalance(walletId, wallet.currency);
            const checkedEntries = await session.ledgerEntries.countByWallet(walletId);
            const difference = calculated.subtract(wallet.balance);
            const consistent = difference.isZero();

            if (!consistent) {
                // TODO(§12): rotear por LoggerPort + contador de métrica
                console.log(JSON.stringify({
                    level: "error",
                    event: "reconciliation_divergence",
                    walletId,
                    stored: wallet.balance.toString(),
                    calculated: calculated.toString(),
                }));
            }

            return {
                walletId,
                storedBalance: wallet.balance.toJSON(),
                calculatedBalance: calculated.toJSON(),
                difference: difference.toJSON(),
                consistent,
                checkedEntries,
            };
        });
    }
}
