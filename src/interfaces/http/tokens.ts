// Tokens de injeção explícita (o Bun não emite emitDecoratorMetadata, então o
// Nest não resolve dependência por tipo — padrão suportado: token + @Inject)

export const MIKRO_ORM = "MIKRO_ORM";
export const UNIT_OF_WORK = "UNIT_OF_WORK";

// observabilidade (§12)
export const LOGGER = "LOGGER";
export const METRICS = "METRICS";

export const CREATE_WALLET = "CREATE_WALLET";
export const SUBMIT_TRANSACTION = "SUBMIT_TRANSACTION";
export const GET_WALLET = "GET_WALLET";
export const GET_WALLET_LEDGER = "GET_WALLET_LEDGER";
export const GET_TRANSACTION = "GET_TRANSACTION";
export const RECONCILE_WALLET = "RECONCILE_WALLET";

// mensageria (§10/§11)
export const SQS_CLIENT = "SQS_CLIENT";
export const WAGER_TRANSACTIONS_CONSUMER = "WAGER_TRANSACTIONS_CONSUMER";
export const OUTBOX_PUBLISHER = "OUTBOX_PUBLISHER";
export const REPROCESS_PENDING_REFERENCES = "REPROCESS_PENDING_REFERENCES";
