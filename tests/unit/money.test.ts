import { describe, test, expect } from "bun:test";
import { Money, InvalidMoneyError } from "../../src/domain/money";

describe("Money", () => {
    test("aceita escala 2 e serializa sempre com 2 casas", () => {
        expect(Money.from({ amount: "25.00", currency: "BRL" }).toString()).toBe("25.00");
    });

    test.each(["10.005", "10", "1e2", "", "abc", "NaN", "Infinity", "-1.00"])(
        "rejeita entrada inválida: %s",
        (amount) => {
            expect(() => Money.from({ amount, currency: "BRL" })).toThrow(InvalidMoneyError);
        },
    );

    test("0.10 + 0.20 = 0.30 (sem erro de float)", () => {
        const r = Money.from({ amount: "0.10", currency: "BRL" })
            .add(Money.from({ amount: "0.20", currency: "BRL" }));
        expect(r.toString()).toBe("0.30");
    });

    test("soma de moedas diferentes lança erro", () => {
        const brl = Money.from({ amount: "1.00", currency: "BRL" });
        const usd = Money.from({ amount: "1.00", currency: "USD" });
        expect(() => brl.add(usd)).toThrow(InvalidMoneyError);
    });

    test("imutabilidade: add não altera a instância original", () => {
        const a = Money.from({ amount: "10.00", currency: "BRL" });
        a.add(Money.from({ amount: "5.00", currency: "BRL" }));
        expect(a.toString()).toBe("10.00");
    });

    test("zero cria 0.00 na moeda informada", () => {
        expect(Money.zero("BRL").toString()).toBe("0.00");
    });

    test("subtract calcula corretamente", () => {
        expect(Money.from({ amount: "10.00", currency: "BRL" })
            .subtract(Money.from({ amount: "3.50", currency: "BRL" })).toString()).toBe("6.50");
    });

    test("equals compara valor E moeda", () => {
        const a = Money.from({ amount: "5.00", currency: "BRL" });
        expect(a.equals(Money.from({ amount: "5.00", currency: "BRL" }))).toBe(true);
        expect(a.equals(Money.from({ amount: "5.00", currency: "USD" }))).toBe(false);
    });

});