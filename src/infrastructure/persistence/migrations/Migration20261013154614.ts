import { Migration } from '@mikro-orm/migrations';

export class Migration20261013154614 extends Migration {

  override name = 'Migration20261013154614';

  override up(): void | Promise<void> {
    this.addSql(`create table "wager_transactions" ("id" uuid not null, "provider_id" varchar(64) not null, "external_transaction_id" varchar(128) not null, "idempotency_key" varchar(255) not null, "payload_hash" varchar(64) not null, "wallet_id" uuid not null, "player_id" uuid not null, "round_id" varchar(64) not null, "game_id" varchar(64) not null, "kind" text not null, "status" text not null, "amount" numeric(18,2) not null, "currency" varchar(3) not null, "reference_external_transaction_id" varchar(128) null, "reference_transaction_id" uuid null, "failure_code" varchar(64) null, "created_at" timestamptz not null, "processed_at" timestamptz null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "wager_transactions_status_index" on "wager_transactions" ("status");`);
    this.addSql(`alter table "wager_transactions" add constraint "uq_wager_tx_provider_external" unique ("provider_id", "external_transaction_id");`);
    this.addSql(`alter table "wager_transactions" add constraint "uq_wager_tx_idempotency_key" unique ("idempotency_key");`);

    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id");`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_amount_check" check (amount >= 0);`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_kind_check" check ("kind" in ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK'));`);
    this.addSql(`alter table "wager_transactions" add constraint "wager_transactions_status_check" check ("status" in ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wager_transactions" cascade;`);
  }

}
