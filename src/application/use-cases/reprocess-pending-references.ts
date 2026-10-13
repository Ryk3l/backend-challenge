import type { UnitOfWork } from "../ports/persistence";
import { SubmitTransaction } from "./submit-transaction";

const BATCH_SIZE = 20;
const POLL_BASE_MS = 5_000;
const POLL_MAX_MS = 60_000;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export interface ReprocessCounts {
    resolved: number;
    rejected: number;
    waiting: number;
}

/**
 * Worker de referências fora de ordem (§7.1): varre PENDING_REFERENCE (mais
 * antigas primeiro), delega a resolução ao SubmitTransaction — mesmas regras
 * do submit, num lugar só — e rejeita com REFERENCE_NOT_FOUND quando o TTL
 * esgota. Loop com backoff exponencial quando ocioso (5s → 60s).
 */
export class ReprocessPendingReferences {
    private running = false;

    constructor(
        private readonly uow: UnitOfWork,
        private readonly submitTransaction: SubmitTransaction,
    ) { }

    /** um passe sobre as candidatas pendentes */
    async tick(options?: { now?: Date; ttlMs?: number; limit?: number }): Promise<ReprocessCounts> {
        const candidates = await this.uow.run((session) =>
            session.transactions.findPendingReferences(options?.limit ?? BATCH_SIZE),
        );
        const counts: ReprocessCounts = { resolved: 0, rejected: 0, waiting: 0 };
        for (const candidate of candidates) {
            try {
                counts[await this.submitTransaction.reprocessPending(candidate.id, options)]++;
            } catch {
                // corrida de concorrência (lock esgotado): a próxima janela
                // tenta de novo — worker não é caminho de resposta ao usuário
                counts.waiting++;
            }
        }
        return counts;
    }

    async start(): Promise<void> {
        this.running = true;
        let idleMs = POLL_BASE_MS;
        while (this.running) {
            let worked = false;
            try {
                const counts = await this.tick();
                worked = counts.resolved + counts.rejected > 0;
            } catch {
                // banco fora: backoff abaixo segura a tentativa
            }
            if (!this.running) break; // stop() durante o passe: sai sem dormir
            await sleep(worked ? POLL_BASE_MS : idleMs);
            idleMs = worked ? POLL_BASE_MS : Math.min(idleMs * 2, POLL_MAX_MS);
        }
    }

    stop(): void { this.running = false; }
}
