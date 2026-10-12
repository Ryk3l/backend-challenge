import { Money } from "./money";

export enum LedgerDirection {
    Debit = "DEBIT",
    Credit = "CREDIT",
}

export class InvalidLedgerError extends Error {
    constructor(public readonly code: string) {
        super(`Invalid ledger entry: ${code}`);
        this.name = "InvalidLedgerError";
    }
}

export interface CreateLedgerEntryProps {
    id: string;
    walletId: string;
    transactionId: string;
    direction: LedgerDirection;
    money: Money;
    balanceBefore: Money;
    balanceAfter: Money;
}

export interface LedgerEntryState extends CreateLedgerEntryProps {
    createdAt: Date;
}

export class WalletLedgerEntry {
    // imutável: construtor privado, campos readonly, sem setters
    private constructor(
        public readonly id: string,
        public readonly walletId: string,
        public readonly transactionId: string,
        public readonly direction: LedgerDirection,
        public readonly money: Money,
        public readonly balanceBefore: Money,
        public readonly balanceAfter: Money,
        public readonly createdAt: Date,
    ) { }

    static create(props: CreateLedgerEntryProps): WalletLedgerEntry {
        const entry = new WalletLedgerEntry(props.id, props.walletId, props.transactionId,
            props.direction, props.money, props.balanceBefore, props.balanceAfter, new Date());
        // a factory VALIDA a aritmética na criação
        if (!entry.isBalanced()) throw new InvalidLedgerError("UNBALANCED_ENTRY");
        return entry;
    }

    /** reconstrução do banco — sem revalidar */
    static rehydrate(state: LedgerEntryState): WalletLedgerEntry {
        return new WalletLedgerEntry(state.id, state.walletId, state.transactionId,
            state.direction, state.money, state.balanceBefore, state.balanceAfter, state.createdAt);
    }

    /** balanceBefore ± money === balanceAfter */
    isBalanced(): boolean {
        const expected = this.direction === LedgerDirection.Credit
            ? this.balanceBefore.add(this.money)
            : this.balanceBefore.subtract(this.money);
        return this.balanceAfter.equals(expected);
    }
}