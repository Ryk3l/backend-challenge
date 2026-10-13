import { Migration } from '@mikro-orm/migrations';

export class Migration20261013141459 extends Migration {

  override name = 'Migration20261013141459';

  override up(): void | Promise<void> {
    this.addSql(`create table "wallets" ("id" uuid not null, "player_id" uuid not null, "currency" varchar(3) not null, "balance" numeric(18,2) not null, "version" int not null default 1, "created_at" timestamptz not null, "updated_at" timestamptz not null, primary key ("id"));`);
    this.addSql(`alter table "wallets" add constraint "uq_wallets_player_currency" unique ("player_id", "currency");`);

    this.addSql(`alter table "wallets" add constraint "wallets_balance_check" check (balance >= 0);`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "wallets" cascade;`);
  }

}
