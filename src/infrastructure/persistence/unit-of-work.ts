import type { MikroORM } from "@mikro-orm/postgresql";
import { OptimisticLockError, UniqueConstraintViolationException } from "@mikro-orm/core";
import { ConflictError, ConcurrencyConflictError } from "../../application/errors";
import type { PersistenceSession, UnitOfWork } from "../../application/ports/persistence";
import {
    MikroOrmWalletRepository,
    MikroOrmWagerTransactionRepository,
    MikroOrmWalletLedgerRepository,
    MikroOrmOutboxRepository,
    MikroOrmInboxRepository,
} from "./repositories";

/**
 * Unit of Work sobre MikroORM: cada `run` = 1 fork de EntityManager = 1
 * transação SQL isolada. Fork por execução é obrigatório para o cenário
 * multi-instância da seção 8 — transações concorrentes nunca compartilham
 * identity map.
 */
export class MikroOrmUnitOfWork implements UnitOfWork {
    constructor(private readonly orm: MikroORM) { }

    async run<T>(fn: (session: PersistenceSession) => Promise<T>): Promise<T> {
        const em = this.orm.em.fork();
        try {
            return await em.transactional(async (txEm) => {
                const session: PersistenceSession = {
                    wallets: new MikroOrmWalletRepository(txEm),
                    transactions: new MikroOrmWagerTransactionRepository(txEm),
                    ledgerEntries: new MikroOrmWalletLedgerRepository(txEm),
                    inbox: new MikroOrmInboxRepository(txEm),
                    outbox: new MikroOrmOutboxRepository(txEm),
                };
                const result = await fn(session);
                // flush único antes do COMMIT: wallet + transação + ledger +
                // inbox + outbox confirmam juntos ou não confirmam (§11)
                await txEm.flush();
                return result;
            });
        } catch (err) {
            throw translate(err);
        }
    }
}

/**
 * Erros de infra traduzidos para o vocabulário da aplicação:
 * - UNIQUE violado em corrida (duas criações simultâneas, replay duplicado)
 *   → conflito de negócio (409 na API);
 * - version desatualizado da wallet (§8) → o use case pode tentar de novo.
 * Todo o resto propaga intacto (erros de domínio, falhas de infra).
 */
function translate(err: unknown): unknown {
    if (err instanceof UniqueConstraintViolationException)
        return new ConflictError("DUPLICATE_ROW", { cause: err });
    if (err instanceof OptimisticLockError)
        return new ConcurrencyConflictError({ cause: err });
    return err;
}
