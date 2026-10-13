import type { Money } from "../../domain/money";
import type { Wallet } from "../../domain/wallet";
import type { WalletLedgerEntry } from "../../domain/wallet-ledger-entry";
import type { WagerTransaction } from "../../domain/wager-transaction";
import type { OutboxMessage } from "../../domain/outbox-message";

// Portas de persistência (dependência invertida): a camada de aplicação
// enxerga SÓ estas interfaces — a implementação MikroORM mora em
// infrastructure/persistence e nunca vaza para o domínio ou para os use cases.

export interface WalletRepository {
    findById(id: string): Promise<Wallet | null>;
    findByPlayerAndCurrency(playerId: string, currency: string): Promise<Wallet | null>;
    /** enfileira para o flush da transação — nada é gravado antes do commit (§11) */
    insert(wallet: Wallet): Promise<void>;
}

export interface WagerTransactionRepository {
    findById(id: string): Promise<WagerTransaction | null>;
    insert(transaction: WagerTransaction): Promise<void>;
}

export interface WalletLedgerRepository {
    insert(entry: WalletLedgerEntry): Promise<void>;
    /** saldo reconstruído pelo ledger — invariante final de todos os testes (§13) */
    calculateBalance(walletId: string, currency: string): Promise<Money>;
}

export interface OutboxRepository {
    insert(message: OutboxMessage): Promise<void>;
}

/** Repositórios compartilhando o mesmo EntityManager da transação corrente. */
export interface PersistenceSession {
    wallets: WalletRepository;
    transactions: WagerTransactionRepository;
    ledgerEntries: WalletLedgerRepository;
    outbox: OutboxRepository;
}

/**
 * Unit of Work (§11): tudo dentro de `run` — wallet, transação, ledger e outbox —
 * acontece numa única transação SQL: ou confirma tudo junto, ou nada.
 * inbox entra nesta sessão quando o canal SQS chegar (§10).
 */
export interface UnitOfWork {
    run<T>(fn: (session: PersistenceSession) => Promise<T>): Promise<T>;
}
