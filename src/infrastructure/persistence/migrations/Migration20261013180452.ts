import { Migration } from '@mikro-orm/migrations';

export class Migration20261013180452 extends Migration {

  override name = 'Migration20261013180452';

  override up(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" add "observed_balance" numeric(18,2) null;`);
  }

  override down(): void | Promise<void> {
    this.addSql(`alter table "wager_transactions" drop column "observed_balance";`);
  }

}
