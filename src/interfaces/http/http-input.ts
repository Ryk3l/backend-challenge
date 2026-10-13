import { HttpException } from "@nestjs/common";
import type { MoneyProps } from "../../domain/money";
import { WagerTransactionKind } from "../../domain/wager-transaction";

/** 400 consistente em todos os endpoints: { error: "INVALID_PAYLOAD", code } (§9) */
export function reject400(code: string): never {
    throw new HttpException({ error: "INVALID_PAYLOAD", code }, 400);
}

export function requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.length === 0)
        reject400(`MISSING_${field.toUpperCase()}`);
    return value;
}

export function optionalString(value: unknown, field: string): string | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "string" || value.length === 0)
        reject400(`INVALID_${field.toUpperCase()}`);
    return value;
}

/** só valida o formato do contrato; a validação monetária é do domínio (Money.from) */
export function asMoney(value: unknown, field = "money"): MoneyProps {
    if (typeof value !== "object" || value === null)
        reject400(`MISSING_${field.toUpperCase()}`);
    const money = value as Record<string, unknown>;
    return {
        amount: requireString(money.amount, `${field}.amount`),
        currency: requireString(money.currency, `${field}.currency`),
    };
}

// OPENING é interno (§6.3) — a API só aceita os kinds submetíveis pelo provedor
const SUBMITTABLE_KINDS = new Set<string>([
    WagerTransactionKind.Bet,
    WagerTransactionKind.Win,
    WagerTransactionKind.Loss,
    WagerTransactionKind.Refund,
    WagerTransactionKind.Rollback,
]);

export function asKind(value: unknown): WagerTransactionKind {
    const kind = requireString(value, "kind");
    if (!SUBMITTABLE_KINDS.has(kind)) reject400("INVALID_KIND");
    return kind as WagerTransactionKind;
}
