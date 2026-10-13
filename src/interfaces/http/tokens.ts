// Tokens de injeção explícita (o Bun não emite emitDecoratorMetadata, então o
// Nest não resolve dependência por tipo — padrão suportado: token + @Inject)

export const MIKRO_ORM = "MIKRO_ORM";
export const UNIT_OF_WORK = "UNIT_OF_WORK";

export const CREATE_WALLET = "CREATE_WALLET";
export const SUBMIT_TRANSACTION = "SUBMIT_TRANSACTION";
export const GET_WALLET = "GET_WALLET";
export const GET_WALLET_LEDGER = "GET_WALLET_LEDGER";
export const GET_TRANSACTION = "GET_TRANSACTION";
export const RECONCILE_WALLET = "RECONCILE_WALLET";
