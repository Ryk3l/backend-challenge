import { defineConfig } from "@mikro-orm/postgresql";

/**
 * Configuração do MikroORM — lida pelo CLI e pelo bootstrap do NestJS (Dia 2).
 * Credenciais idênticas ao serviço `postgres` do docker-compose.yml.
 */
export default defineConfig({
  entities: ["./src/infrastructure/persistence/entities/*.ts"],
  dbName: "wagering",
  host: "127.0.0.1",
  port: 5433,
  user: "wager",
  password: "wager",
  migrations: {
    path: "./src/infrastructure/persistence/migrations",
    tableName: "mikro_orm_migrations",
    transactional: true,   // cada migration roda numa transação: ou aplica inteira, ou nada
    snapshot: true,        // snapshot do schema p/ gerar diffs das próximas migrations
  },
  // relógio sempre em UTC — app e banco nunca discutem fuso horário
  forceUtcTimezone: true,
});