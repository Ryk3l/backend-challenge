import { Migration } from '@mikro-orm/migrations';

export class Migration20261013172140 extends Migration {

  override name = 'Migration20261013172140';

  override up(): void | Promise<void> {
    this.addSql(`create table "inbox_messages" ("id" uuid not null, "message_id" varchar(128) not null, "consumer_name" varchar(64) not null, "payload_hash" varchar(64) not null, "received_at" timestamptz not null, "processed_at" timestamptz null, primary key ("id"));`);
    this.addSql(`alter table "inbox_messages" add constraint "uq_inbox_consumer_message" unique ("consumer_name", "message_id");`);

    this.addSql(`create table "outbox_messages" ("id" uuid not null, "aggregate_id" varchar(64) not null, "event_type" text not null, "payload" jsonb not null, "occurred_at" timestamptz not null, "attempts" int not null, "next_attempt_at" timestamptz null, "published_at" timestamptz null, primary key ("id"));`);
    this.addSql(`create index "idx_outbox_pending" on "outbox_messages" ("published_at", "next_attempt_at");`);

    this.addSql(`alter table "outbox_messages" add constraint "outbox_messages_event_type_check" check ("event_type" in ('WagerTransactionProcessed', 'WagerTransactionRejected', 'WalletBalanceChanged', 'WagerTransactionPendingReference'));`);
  }

  override down(): void | Promise<void> {
    this.addSql(`drop table if exists "inbox_messages" cascade;`);
    this.addSql(`drop table if exists "outbox_messages" cascade;`);
  }

}
