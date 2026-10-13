import { randomUUID } from "node:crypto";
import {
    IntegrationEvent,
    type IntegrationEventProps,
    type EventContext,
} from "./integration-event";
import { type MoneyProps } from "../money";
import { type LedgerDirection, type WalletLedgerEntry } from "../wallet-ledger-entry";
import { type Wallet } from "../wallet";

// Publicado somente quando o saldo muda (seção 11) — LOSS não gera este evento.
export interface WalletBalanceChangedData {
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    walletVersion: number;
}

export class WalletBalanceChanged extends IntegrationEvent<WalletBalanceChangedData> {
    readonly eventType = "WalletBalanceChanged";
    readonly version = 1;

    private constructor(props: IntegrationEventProps<WalletBalanceChangedData>) {
        super(props);
    }

    static from(wallet: Wallet, entry: WalletLedgerEntry, ctx: EventContext): WalletBalanceChanged {
        return new WalletBalanceChanged({
            eventId: randomUUID(),
            aggregateId: wallet.id,
            correlationId: ctx.correlationId,
            causationId: ctx.causationId,
            occurredAt: new Date(),
            data: {
                walletId: wallet.id,
                transactionId: entry.transactionId,
                direction: entry.direction,
                // MoneyProps (string decimal), nunca a instância de Money
                money: entry.money.toJSON(),
                balanceBefore: entry.balanceBefore.toJSON(),
                balanceAfter: entry.balanceAfter.toJSON(),
                walletVersion: wallet.version,
            },
        });
    }
}
