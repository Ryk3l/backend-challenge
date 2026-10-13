import { InvalidRequestError, NotFoundError } from "../errors";
import type { MoneyProps } from "../../domain/money";
import type { LedgerDirection } from "../../domain/wallet-ledger-entry";
import { type UnitOfWork } from "../ports/persistence";

export interface LedgerEntryView {
    id: string;
    transactionId: string;
    direction: LedgerDirection;
    money: MoneyProps;
    balanceBefore: MoneyProps;
    balanceAfter: MoneyProps;
    createdAt: Date;
}

export interface GetWalletLedgerResult {
    entries: LedgerEntryView[];
    /** opaco: devolve para `?cursor=` na próxima página; null = última página */
    nextCursor: string | null;
}

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 100;

// cursor opaco = base64url do keyset {c: createdAt, i: id} — formato interno,
// nunca interpretado pelo cliente (§9: "cursor estável e opaco")
interface CursorPayload { c: string; i: string }

/** GET /wallets/:walletId/ledger?cursor=...&limit=50 (§9). */
export class GetWalletLedger {
    constructor(private readonly uow: UnitOfWork) { }

    async execute(query: { walletId: string; cursor?: string; limit?: number }): Promise<GetWalletLedgerResult> {
        const limit = clampLimit(query.limit);
        const after = decodeCursor(query.cursor);

        return this.uow.run(async (session) => {
            const wallet = await session.wallets.findById(query.walletId);
            if (!wallet) throw new NotFoundError("WALLET_NOT_FOUND");

            // busca limit+1 para saber se há próxima página sem COUNT extra
            const rows = await session.ledgerEntries.findPage(query.walletId, after, limit + 1);
            const hasMore = rows.length > limit;
            const page = hasMore ? rows.slice(0, limit) : rows;
            const last = page.at(-1);

            return {
                entries: page.map((entry) => ({
                    id: entry.id,
                    transactionId: entry.transactionId,
                    direction: entry.direction,
                    money: entry.money.toJSON(),
                    balanceBefore: entry.balanceBefore.toJSON(),
                    balanceAfter: entry.balanceAfter.toJSON(),
                    createdAt: entry.createdAt,
                })),
                nextCursor: hasMore && last ? encodeCursor(last) : null,
            };
        });
    }
}

function clampLimit(limit: number | undefined): number {
    if (limit === undefined) return DEFAULT_LIMIT;
    if (!Number.isInteger(limit) || limit < 1)
        throw new InvalidRequestError("INVALID_LIMIT");
    return Math.min(limit, MAX_LIMIT);
}

function encodeCursor(last: { createdAt: Date; id: string }): string {
    const payload: CursorPayload = { c: last.createdAt.toISOString(), i: last.id };
    return Buffer.from(JSON.stringify(payload)).toString("base64url");
}

function decodeCursor(cursor: string | undefined): { createdAt: Date; id: string } | null {
    if (!cursor) return null;
    try {
        const payload = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as Partial<CursorPayload>;
        if (typeof payload.c !== "string" || typeof payload.i !== "string") throw new Error();
        const createdAt = new Date(payload.c);
        if (Number.isNaN(createdAt.getTime())) throw new Error();
        return { createdAt, id: payload.i };
    } catch {
        throw new InvalidRequestError("INVALID_CURSOR");
    }
}
