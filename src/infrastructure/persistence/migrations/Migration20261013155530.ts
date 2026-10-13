import { Migration } from '@mikro-orm/migrations';

export class Migration20261013155530 extends Migration {

  override name = 'Migration20261013155530';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallet_ledger_entries" ("id" uuid not null, "wallet_id" uuid not null, "transaction_id" uuid not null, "direction" text not null, "amount" numeric(18,2) not null, "currency" varchar(3) not null, "balance_before" numeric(18,2) not null, "balance_after" numeric(18,2) not null, "created_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`create index "idx_ledger_wallet_created_at" on "wallet_ledger_entries" ("wallet_id", "created_at");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "uq_ledger_transaction_wallet" unique ("transaction_id", "wallet_id");`);

    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_wallet_id_foreign" foreign key ("wallet_id") references "wallets" ("id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_transaction_id_foreign" foreign key ("transaction_id") references "wager_transactions" ("id");`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "chk_ledger_balanced" check ((direction = 'CREDIT' AND balance_after = balance_before + amount) OR (direction = 'DEBIT' AND balance_after = balance_before - amount));`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_amount_check" check (amount >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_balance_before_check" check (balance_before >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_balance_after_check" check (balance_after >= 0);`);
    this.addSql(`alter table "wallet_ledger_entries" add constraint "wallet_ledger_entries_direction_check" check ("direction" in ('DEBIT', 'CREDIT'));`);
    this.addSql(`create or replace function "wallet_ledger_entries_trg_wallet_ledger_append_only_fn"() returns trigger as \$\$ begin raise exception 'wallet_ledger_entries is append-only'; end; \$\$ language plpgsql;`);
    this.addSql(`create trigger "trg_wallet_ledger_append_only" BEFORE UPDATE OR DELETE on "wallet_ledger_entries" for each ROW execute function "wallet_ledger_entries_trg_wallet_ledger_append_only_fn"();`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop trigger if exists "trg_wallet_ledger_append_only" on "wallet_ledger_entries";`);
    this.addSql(`drop function if exists "wallet_ledger_entries_trg_wallet_ledger_append_only_fn"();`);
    this.addSql(`drop table if exists "wallet_ledger_entries" cascade;`);
  }

}
