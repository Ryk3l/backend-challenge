import { createHash } from "node:crypto";

/**
 * JSON canônico (seção 9): chaves ordenadas recursivamente, sem espaços.
 * payloadHash = sha-256 deste formato — a ordem das chaves no objeto de origem
 * não altera o hash, então requisições idênticas sempre batem, e qualquer
 * campo de negócio divergente gera hash diferente (conflito, não replay).
 */
export function canonicalJson(value: unknown): string {
    if (value === undefined) return "null";
    if (value === null || typeof value !== "object") return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;

    const record = value as Record<string, unknown>;
    const fields = Object.keys(record)
        .sort()
        .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${fields.join(",")}}`;
}

/** sha-256 em hex (64 chars) — cabe em payload_hash varchar(64) */
export function payloadHash(value: unknown): string {
    return createHash("sha256").update(canonicalJson(value)).digest("hex");
}
