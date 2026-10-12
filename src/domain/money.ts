import { Decimal } from "decimal.js";

// DTO — formato do contrato da API: { "amount": "25.00", "currency": "BRL" }
export interface MoneyProps {
    amount: string;
    currency: string;
}

// Erro de domínio com código legível por máquina
export class InvalidMoneyError extends Error {
    constructor(public readonly code: string) {
        super(`Invalid money: ${code}`);
        this.name = "InvalidMoneyError";
    }
}

export class Money {
    // construtor PRIVADO: ninguém faz "new Money()" fora da classe
    private constructor(
        private readonly value: Decimal,
        public readonly currency: string,
    ) { }

    static from(props: MoneyProps): Money {
        const { amount, currency } = props;

        if (typeof amount !== "string" || amount.trim() === "")
            throw new InvalidMoneyError("EMPTY_AMOUNT");
        if (typeof currency !== "string" || !/^[A-Z]{3}$/.test(currency))
            throw new InvalidMoneyError("INVALID_CURRENCY");
        // escala fixa 2 — rejeita: "10", "10.005", "1e2", "NaN", "Infinity", "-1.00", ""
        if (!/^\d+\.\d{2}$/.test(amount))
            throw new InvalidMoneyError("INVALID_SCALE");

        const value = new Decimal(amount);
        if (!value.isFinite()) throw new InvalidMoneyError("NOT_FINITE");
        return new Money(value, currency);
    }

    static zero(currency: string): Money {
        return Money.from({ amount: "0.00", currency });
    }

    add(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.value.plus(other.value), this.currency);
    }

    subtract(other: Money): Money {
        this.assertSameCurrency(other);
        return new Money(this.value.minus(other.value), this.currency);
    }

    negate(): Money {
        return new Money(this.value.negated(), this.currency);
    }

    isZero(): boolean { return this.value.isZero(); }
    isPositive(): boolean { return this.value.gt(0); }
    isNegative(): boolean { return this.value.lt(0); }

    isLessThan(other: Money): boolean {
        this.assertSameCurrency(other);
        return this.value.lt(other.value);
    }

    equals(other: Money): boolean {
        return this.currency === other.currency && this.value.eq(other.value);
    }

    toJSON(): MoneyProps {
        return { amount: this.toString(), currency: this.currency };
    }

    toString(): string {
        return this.value.toFixed(2); // sempre 2 casas: "25.00"
    }

    private assertSameCurrency(other: Money): void {
        if (this.currency !== other.currency)
            throw new InvalidMoneyError("CURRENCY_MISMATCH");
    }
}