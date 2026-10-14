# Distributed Wagering Processor

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) recebidas de múltiplos provedores, via API HTTP e fila SQS.

> Enunciado completo do desafio em [`DESAFIO.md`](./DESAFIO.md) · Decisões técnicas em [`ARCHITECTURE.md`](./ARCHITECTURE.md)

As invariantes que o sistema preserva são as da seção 3 do desafio:

1. Nunca duplicar créditos;
2. Nunca duplicar débitos;
3. Nunca perder eventos confirmados;
4. Nunca permitir saldo negativo.

---

## Setup

### Pré-requisitos

- [Bun](https://bun.sh) 1.x
- Docker Desktop (ou Docker Engine + Compose v2)
- Uma licença LocalStack Hobby (gratuita) — ver nota abaixo

### 1. Subir as dependências

```bash
docker compose up -d
```

Sobe dois containers:

| Serviço | Porta | Credenciais |
|---|---|---|
| PostgreSQL 16 | `localhost:5433` | usuário `wager`, senha `wager`, banco `wagering` |
| LocalStack (SQS) | `localhost:4566` | — |

Confira que ambos estão `healthy` antes de seguir:

```bash
docker compose ps
```

> **Nota sobre o LocalStack:** desde 2026 o LocalStack exige um token de licença para as filas SQS. Gere um plano gratuito em <https://localstack.cloud/dashboard> e exporte antes de subir o compose:
>
> ```bash
> export LOCALSTACK_AUTH_TOKEN=ls-token-...
> docker compose up -d
> ```
>
> O token é lido pelo `docker-compose.yml` (`${LOCALSTACK_AUTH_TOKEN}`) e **nunca deve ser commitado** — mantenha-o no seu shell ou em um `.env` local (já ignorado pelo `.gitignore`).

### 2. Instalar dependências e aplicar migrations

```bash
bun install
bunx --bun mikro-orm migration:up
```

As migrations são versionadas e reversíveis (cada uma tem `up()` e `down()`), e vivem em `src/infrastructure/persistence/migrations/`.

Para verificar que o schema está em dia com o código (drift test):

```bash
bunx --bun mikro-orm migration:create
```

Se não houver mudanças pendentes, o comando responde `No changes required` e não cria arquivo algum.

> **Por que `--bun`?** O `bunx` por padrão executa o binário com o shebang `node`. Como todo o projeto roda em Bun, `bunx --bun` força o runtime correto e evita comportamentos divergentes na CLI do MikroORM.

### 3. Rodar a aplicação

```bash
bun run dev      # watch mode
# ou
bun run start    # produção
```

A API sobe em `http://localhost:3000`. No bootstrap, a aplicação garante que as filas SQS existam (idempotente) e inicia os três workers: consumidor da fila, publisher da outbox e o worker de referências fora de ordem (§7.1).

Para subir **somente a API HTTP**, sem os workers (útil para depurar a borda HTTP isoladamente):

```bash
WORKERS=disabled bun run start
```

### 4. Rodar os testes

```bash
bun test
```

> Os testes de integração (`tests/integration/`) exigem o Docker em pé — eles usam PostgreSQL e LocalStack reais, não mocks.

---

## Variáveis de ambiente

| Variável | Padrão | Descrição |
|---|---|---|
| `PORT` | `3000` | Porta da API HTTP |
| `LOG_LEVEL` | `info` | Nível do logger estruturado (`debug` \| `info` \| `warn` \| `error`) |
| `WORKERS` | `enabled` | `disabled` sobe só a API HTTP, sem os 3 workers |
| `SQS_ENDPOINT` | `http://localhost:4566` | Endpoint do SQS (LocalStack local) |
| `AWS_REGION` | `us-east-1` | Região reportada ao SDK |
| `SQS_INBOUND_QUEUE_URL` | derivada | Override da URL da fila de entrada |
| `SQS_DLQ_QUEUE_URL` | derivada | Override da URL da DLQ |
| `SQS_EVENTS_QUEUE_URL` | derivada | Override da URL da fila de eventos |
| `LOCALSTACK_AUTH_TOKEN` | — | Token de licença do LocalStack (via env do compose) |

A conexão com o PostgreSQL usa os valores do `mikro-orm.config.ts` (host `localhost`, porta `5433`, `wager`/`wager`/`wagering`).

---

## API HTTP

Autenticação: **não implementada** — decisão documentada em `ARCHITECTURE.md` §9 (não vale pontos, seção 2 do desafio). Os endpoints de health ficam abertos por decisão do enunciado.

### Criar wallet

```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
```

O saldo inicial, quando maior que zero, gera uma transação interna `OPENING` na mesma transação SQL, com lançamento `CREDIT` correspondente no ledger. Criar wallet duplicada para o mesmo `playerId + currency` falha como conflito (`409`).

### Submeter transação

```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:transaction-123" \
  -H "x-correlation-id: meu-correlation-id-123" \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "0192f291-27dd-7d3f-8071-5f8685deef37",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

O header `Idempotency-Key` é obrigatório (ausente/vazio → `400`). O header `x-correlation-id` é opcional: se enviado, o mesmo id costura request → log → evento; se ausente, a aplicação gera um.

### Consultas

```bash
curl http://localhost:3000/wallets/:walletId
curl "http://localhost:3000/wallets/:walletId/ledger?limit=50"
curl http://localhost:3000/wagering/transactions/:transactionId
curl http://localhost:3000/providers/:providerId/wagering/transactions/:externalTransactionId
```

O endpoint de ledger usa paginação por cursor opaco e estável (keyset), não offset.

### Reconciliação

```bash
curl -X POST http://localhost:3000/wallets/:walletId/reconciliation
```

Compara o saldo materializado (`wallets.balance`) com o saldo reconstruído pelo ledger. Divergências **não** são corrigidas em silêncio: são logadas, contabilizadas em métrica (`reconciliation_divergence_total`) e sinalizadas na resposta (`consistent: false`).

### Health checks

```bash
curl http://localhost:3000/health/live    # processo vivo
curl http://localhost:3000/health/ready   # PostgreSQL E SQS alcançáveis
curl http://localhost:3000/health/metrics # métricas em Prometheus text
```

`/health/live` não toca dependência externa; `/health/ready` retorna `503` se qualquer uma das duas dependências estiver inacessível.

---

## Status HTTP

A API distingue claramente as situações que o provedor precisa separar para decidir se reenvia, corrige o payload ou desiste:

| Código | Situação |
|---|---|
| `200` | Aplicada (`PROCESSED`) |
| `202` | Aceita, processamento pendente (`PENDING` \| `PENDING_REFERENCE`) |
| `400` | Payload inválido (corpo, cursor, `Money`, `kind`, referência obrigatória ausente) |
| `404` | Wallet ou transação inexistente |
| `409` | Conflito de idempotência (key com payload divergente, wallet duplicada) |
| `422` | Regra de negócio (`REJECTED` — o corpo carrega o `failureCode`) |
| `503` | Falha transitória de infraestrutura (retryable) |
| `500` | Inesperado (logado; nunca vaza stack para o provedor) |

---

## Estrutura do projeto

```
src/
├── domain/                 regras puras — Money, Wallet, WagerTransaction, ledger, eventos
├── application/            casos de uso e portas (interfaces)
├── infrastructure/         detalhes técnicos — MikroORM, SQS, observabilidade
└── interfaces/             bordas — controllers HTTP, wiring do NestJS (app.module)

tests/
├── unit/                   regras de domínio e serialização
└── integration/            PostgreSQL e LocalStack reais em containers
```

Regra de dependência (unidirecional): `interfaces → application → domain ← infrastructure`. O `domain/` nunca importa `@nestjs/*` nem `@mikro-orm/*`.

O **mesmo use case** (`SubmitTransaction`) atende a borda HTTP e o consumidor da fila — requisito da seção 10 do desafio.

---

## Comandos úteis

| Comando | O que faz |
|---|---|
| `bun run dev` | Sobe a API em watch mode |
| `bun run start` | Sobe a API (produção) |
| `bun run typecheck` | `tsc --noEmit` |
| `bun test` | Suíte completa (unit + integração) |
| `bunx --bun mikro-orm migration:up` | Aplica migrations pendentes |
| `bunx --bun mikro-orm migration:create` | Drift test — cria migration se houver mudança |
| `bunx --bun mikro-orm migration:down` | Reverte a última migration |

---

## Decisões e limitações

As decisões técnicas, trade-offs e limitações estão documentadas em [`ARCHITECTURE.md`](./ARCHITECTURE.md).
