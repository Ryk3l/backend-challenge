import { randomUUID } from "node:crypto";
import { Money, type MoneyProps, InvalidMoneyError } from "./money";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export class InsufficientBalanceError extends Error {
    constructor() {
        super("Insufficient balance");
        this.name = "InsufficientBalanceError";
    }
    readonly code = "INSUFFICIENT_BALANCE";
}

export class InvalidWalletError extends Error {
    constructor(public readonly code: string) {
        super(`Invalid wallet: ${code}`);
        this.name = "InvalidWalletError";
    }
}

export interface WalletState {
    id: string;
    playerId: string;
    currency: string;
    balance: MoneyProps;   // tipo importado com "type" — lembra?
    version: number;
    createdAt: Date;
    updatedAt: Date;
}

export class Wallet {
    private constructor(
        public readonly id: string,
        public readonly playerId: string,
        public readonly currency: string,
        private _balance: Money,
        private _version: number,          // base do optimistic locking
        public readonly createdAt: Date,
        private _updatedAt: Date,
    ) { }

    /** criação — valida regras de nascimento */
    static open(props: { id?: string; playerId: string; initialBalance: Money }): Wallet {
        if (props.initialBalance.isNegative())
            throw new InvalidWalletError("NEGATIVE_OPENING_BALANCE");
        const now = new Date();
        return new Wallet(
            props.id ?? randomUUID(),
            props.playerId,
            props.initialBalance.currency,
            props.initialBalance,
            1,                       // version inicia em 1 (regra do README)
            now,
            now,
        );
    }

    /** reconstrução do banco — NÃO revalida transições */
    static rehydrate(state: WalletState): Wallet {
        return new Wallet(state.id, state.playerId, state.currency,
            Money.from(state.balance), state.version, state.createdAt, state.updatedAt);
    }

    get balance(): Money { return this._balance; }
    get version(): number { return this._version; }
    get updatedAt(): Date { return this._updatedAt; }

    /** débito: só com saldo suficiente; gera 1 ledger; incrementa version */
    debit(money: Money, transactionId: string): WalletLedgerEntry {
        this.assertUsableAmount(money);
        if (this._balance.isLessThan(money))
            throw new InsufficientBalanceError();          // NÃO altera nada

        const before = this._balance;
        const after = before.subtract(money);
        this._balance = after;
        this._version += 1;                              // saldo mudou → version muda
        this._updatedAt = new Date();

        return WalletLedgerEntry.create({
            id: randomUUID(), walletId: this.id, transactionId,
            direction: LedgerDirection.Debit,
            money, balanceBefore: before, balanceAfter: after,
        });
    }

    /** crédito: espelho do débito */
    credit(money: Money, transactionId: string): WalletLedgerEntry {
        this.assertUsableAmount(money);

        const before = this._balance;
        const after = before.add(money);
        this._balance = after;
        this._version += 1;
        this._updatedAt = new Date();

        return WalletLedgerEntry.create({
            id: randomUUID(), walletId: this.id, transactionId,
            direction: LedgerDirection.Credit,
            money, balanceBefore: before, balanceAfter: after,
        });
    }

    private assertUsableAmount(money: Money): void {
        if (money.currency !== this.currency)
            throw new InvalidMoneyError("CURRENCY_MISMATCH");   // moeda ≠ da wallet
        if (!money.isPositive())
            throw new InvalidWalletError("NON_POSITIVE_AMOUNT"); // negativo/zero nunca entra
    }
}