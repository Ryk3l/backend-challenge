# ARCHITECTURE.md — Distributed Wagering Processor

Documento de **decisões, trade-offs e limitações** da solução, conforme exigido pela seção 14 do desafio.

---

## 1. Visão geral

Serviço financeiro distribuído que processa transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) enviadas por múltiplos provedores, por duas fronteiras de entrada — **API HTTP** e **fila SQS** — que convergem no **mesmo caso de uso**.

As quatro invariantes globais (seção 3) que a solução preserva:

1. Nunca duplicar créditos;
2. Nunca duplicar débitos;
3. Nunca perder eventos confirmados;
4. Nunca permitir saldo negativo.

A premissa de projeto é que a entrega é **at-least-once**: mensagens chegam duplicadas, fora de ordem, e o processo morre antes ou depois do commit. Portanto **o banco é a única fonte de garantia** — SQS FIFO, locks de aplicação e caches são otimização, nunca a correção.

---

## 2. Stack e justificativas

| Camada | Escolha | Por quê |
|---|---|---|
| Runtime / PM / test runner | **Bun 1.x** | Obrigatório (§4); um único toolchain para scripts e testes |
| Linguagem | **TypeScript estrito** | `strict` sem exceções — domínio financeiro não tolera `any` implícito |
| Framework | **NestJS** | Obrigatório (§4); DI explícita + módulos delimitam as fronteiras |
| Banco | **PostgreSQL 16** | Constraints, `CHECK`, triggers e `numeric(18,2)` aplicam invariantes no schema (§5) |
| Mensageria | **AWS SQS via LocalStack** | Obrigatório (§4); mesmo SDK e semântica de produção |
| ORM | **MikroORM 7** | Preferencial (§4): Unit of Work e Identity Map explícitos, `em.transactional()`, `LockMode` |
| Dinheiro | **decimal.js** | Eliminatório: nada de `number`/`float` para dinheiro |

### 2.1 Por que MikroORM (e não TypeORM/Prisma)

- **Unit of Work explícito**: um `flush()` único por transação, com Identity Map por execução — exatamente o modelo que a atomicidade wallet + ledger + inbox + outbox exige;
- **`em.transactional()`** entrega a fronteira de transação sem API própria;
- **Optimistic locking nativo** (`version` → `OptimisticLockError`), que é a base da estratégia de concorrência (§6);
- Mapeamento sem decorators (v7: `defineEntity` + `p`) mantém as entidades fora do domínio.

### 2.2 Mapeamento do Money

- **Em domínio:** `Money` envolve `Decimal` (decimal.js) — imutável, escala fixa de 2 casas.
- **Em banco:** `numeric(18,2)` — exatidão do próprio Postgres; a leitura volta como `string` e é reidratada como `Money`.
- **Em contrato:** sempre `{ "amount": "25.00", "currency": "BRL" }` (string decimal).
- **Nunca** existe `number` percorrendo o caminho domínio → persistência → contrato.

### 2.3 Estratégia transacional

**Optimistic locking (`version`) + retry limitado**, aplicado dentro de um Unit of Work de transação única (detalhamento em §6 e §7).

---

## 3. Arquitetura em camadas

```
src/
├── domain/            regras puras — Money, Wallet, WagerTransaction, ledger, eventos
│                      (zero dependências externas: sem Nest, sem MikroORM)
├── application/       casos de uso + portas (interfaces)
│                      └── ports/  persistence, observability, metrics
├── infrastructure/    detalhes técnicos
│                      ├── persistence/   entidades, repositórios, UoW, migrations
│                      ├── messaging/     SQS client, filas, consumidor, outbox publisher
│                      └── observability/ logger, métricas
└── interfaces/        bordas — controllers HTTP, app.module (wiring), tokens, error filter

tests/
├── unit/              regras de domínio e serialização (sem I/O)
└── integration/       PostgreSQL e LocalStack reais em containers
```

**Regra de dependência (unidirecional):** `interfaces → application → domain ← infrastructure`. O `domain/` não importa `@nestjs/*` nem `@mikro-orm/*`.

**Portas (interfaces)** ficam em `application/ports/` e são implementadas pela `infrastructure/`: `UnitOfWork`/`PersistenceSession`, `LoggerPort`, `MetricsPort`. Os casos de uso recebem as portas por construtor — o domínio roda testável sem container.

**Por quê:** testabilidade do domínio sem infraestrutura, evolução de ferramenta sem tocar regra de negócio, e atende ao critério *"invariantes encapsuladas em classes, boundaries, portas, simplicidade"* (§14).

**DI no NestJS + Bun:** o `experimentalDecorators` não funciona de forma confiável com o transpiler do Bun, então a wiring é **explícita**: tokens string (`interfaces/http/tokens.ts`) + `@Inject(token)` + providers `useFactory` no `app.module`. Mais verboso que decorators, porém previsível e sem mágica de reflection.

---

## 4. Modelo de domínio

Padrão de modelagem (§6.0):

- **`private constructor` + factories estáticas** (`create` / `from` / `open` / `rehydrate`);
- **`rehydrate`** reconstrói estado persistido **sem revalidar** transições — só a factory `create` valida regras de entrada;
- Estado encapsulado (`_balance`, `_version`, `_status` privados): transições só por métodos de domínio.

### 4.1 Money (Value Object)

- Imutável: toda operação retorna **nova instância**;
- Escala fixa de 2 casas validada na criação (`^\d+\.\d{2}$`) — rejeita `NaN`, `Infinity`, notação científica, string vazia, escala inválida e negativos de entrada;
- Operações entre moedas diferentes → `InvalidMoneyError(CURRENCY_MISMATCH)`;
- Serialização: `{ "amount": "25.00", "currency": "BRL" }`.

### 4.2 Wallet (Aggregate Root)

Invariantes:

- No máximo uma wallet por `(playerId, currency)` — `UNIQUE` no schema;
- Saldo **nunca** negativo — regra no domínio **e** `CHECK (balance >= 0)` no banco;
- Toda alteração de saldo gera exatamente **um lançamento no ledger** (e vice-versa);
- Moeda da operação deve ser igual à da wallet;
- `version` inicia em 1 e incrementa **somente quando o saldo muda** (base do optimistic locking).

### 4.3 WagerTransaction — máquina de estados

```
create() → PENDING ──(referência ausente)──→ PENDING_REFERENCE ──(worker reprocessa)──┐
            │                                                                          │
            ├─(referência resolvida / não requerida)──→ PROCESSED (terminal) ◄──────────┘
            ├─(regra de negócio violada)──────────────→ REJECTED (terminal)
            └─(erro permanente de infraestrutura)─────→ FAILED (terminal)
```

Transições válidas (❌ = `InvalidTransactionStateError`, erro de programação):

| Estado atual | `markPendingReference` | `markProcessed` | `reject` | `fail` |
|---|---|---|---|---|
| `PENDING` | ✅ | ✅ | ✅ | ✅ |
| `PENDING_REFERENCE` | ✅ (re-marca) | ✅ | ✅ | ✅ |
| `PROCESSED` | ❌ | ❌ | ❌ | ❌ |
| `REJECTED` | ❌ | ❌ | ❌ | ❌ |
| `FAILED` | ❌ | ❌ | ❌ | ❌ |

- `OPENING` é interno: não pode ser submetido pela API nem pela fila (o consumidor rejeita com erro permanente);
- `LOSS` não afeta saldo e não gera lançamento;
- Transição a partir de estado terminal é **erro de programação**, nunca caminho de negócio.

### 4.4 WalletLedgerEntry

- **Append-only por construção:** sem campos mutáveis, sem métodos de transição — a imutabilidade é estrutural;
- A factory valida a aritmética do lançamento: `balanceBefore ± money === balanceAfter`;
- Uma transação produz no máximo **um lançamento por wallet** (`UNIQUE (transaction_id, wallet_id)`).

---

## 5. Persistência e schema

Cinco tabelas, cinco migrations **versionadas e reversíveis** (sempre com `up()` e `down()`) em `src/infrastructure/persistence/migrations/`.

A exigência da §5 é que unicidade, imutabilidade e não-negatividade vivam **no schema**, não só em código. É o que foi feito:

| Garantia | Como ela existe no banco |
|---|---|
| Uma wallet por jogador + moeda | `UNIQUE (player_id, currency)` |
| Saldo nunca negativo | `CHECK (balance >= 0)` em `wallets` |
| Ledger imutável | Trigger `BEFORE UPDATE OR DELETE` → `RAISE EXCEPTION` (append-only forçado) |
| Ledger balanceado | `CHECK`: `balance_before ± amount = balance_after` |
| Sem ledger duplicado por transação | `UNIQUE (transaction_id, wallet_id)` |
| Idempotência | `UNIQUE (idempotency_key)` e `UNIQUE (provider_id, external_transaction_id)` em `wager_transactions` |
| Dedup de entrega | `UNIQUE (consumer_name, message_id)` em `inbox_messages` |
| Índice de outbox pendente | `idx_outbox_pending (published_at, next_attempt_at)` |

Detalhes:

- `numeric(18,2)` em todas as colunas monetárias (exatidão do banco);
- Isolation level `READ COMMITTED` + controle de concorrência explícito (§6) — nenhum `SERIALIZABLE`, para não depender de retry de abort em escala;
- `wager_transactions.observed_balance numeric(18,2)`: guarda o saldo observado na transição terminal de cada transação, e é o que permite ao replay devolver **a resposta original** mesmo com a wallet já avançada.

---

## 6. Concorrência

- **Unidade de concorrência: `walletId`** — nenhum lock global compartilhado entre wallets (eliminatório, §5).
- **Estratégia: optimistic locking via `version` + retry limitado (até 3 reexecuções).**

**Mecanismo:** o update efetiva `SET version = version + 1 WHERE version = <valor lido>`; zero linhas afetadas → `OptimisticLockError` → traduzido para `ConcurrencyConflictError` pelo Unit of Work → o caso de uso reexecuta **do zero, com leitura fresca** (retry ≤ 3). O optimistic lock só funciona porque cada transação SQL faz **exatamente uma mutação de wallet** — garantido pelo domínio (uma transação financeira = no máximo um lançamento).

**Por quê optimistic e não pessimistic:**

- Não segura transação aberta esperando lock → sem deadlock, sem fila de espera;
- Escala naturalmente com N instâncias (o requisito da §8);
- Suportado nativamente pelo MikroORM, que é o ORM preferencial.

*Alternativa considerada:* pessimistic (`SELECT ... FOR UPDATE`) — mais simples sob hot wallet, mas prolonga transações e exige ordem de lock. Foi adotado **pessimistic apenas na outbox** (`FOR UPDATE SKIP LOCKED`), onde a disputa é por lote de trabalho, não por saldo (§8.3).

**Erros de negócio não são retryable:** saldo insuficiente ou moeda divergente vão direto para `REJECTED`, sem bump de `version` e sem consumir tentativas.

**Cenário obrigatório (§8)** — saldo 100.00, duas BET de 80.00 simultâneas — coberto por teste de concorrência real (`Promise.all`), sem mocks sequenciais: exatamente uma `PROCESSED`, a outra `REJECTED` por saldo insuficiente, saldo final 20.00, **um único** débito no ledger.

---

## 7. Idempotência

- **Fonte da verdade:** header `Idempotency-Key` obrigatório (formato recomendado `{providerId}:{externalTransactionId}`).
- **`payloadHash`** = SHA-256 de um **JSON canônico** (chaves ordenadas recursivamente, sem espaços) do subconjunto de campos de negócio. O header e metadados de transporte ficam fora do hash. Assim, requisição idêntica → mesmo hash → replay; mesma key com payload divergente → hash diferente → **conflito (409), não replay**.
- **Dedup é persistente** (tabela), nunca cache em memória — eliminatório (§5).
- **Replay devolve a resposta original:** o saldo observado na transição terminal vem de `observed_balance`, não de uma leitura atual.
- **Corrida pelo mesmo UNIQUE:** o perdedor re-lê em transação nova e devolve a resposta do vencedor com `idempotentReplay: true` — perda de corrida de idempotência é replay, não falha.

Duas camadas distintas, com papéis distintos:

| Camada | Deduplica | Chave |
|---|---|---|
| **Inbox** | entrega da mensagem | `(consumerName, messageId)` |
| **Idempotência** | a operação em si | `Idempotency-Key` + `payloadHash` |

Mensagens diferentes que carregam a mesma operação também replaiam — é o que torna seguro o redelivery do SQS.

---

## 8. Mensageria e entrega at-least-once

### 8.1 Filas (§10)

| FIFO | Papel |
|---|---|
| `wager-transactions.fifo` | entrada de comandos; `RedrivePolicy` → DLQ com `maxReceiveCount: 5`, `VisibilityTimeout: 30s` |
| `wager-transactions-dlq.fifo` | mensagens permanentes (payload não recuperável) |
| `wager-events.fifo` | saída da outbox; `MessageGroupId = aggregateId` (ordenação por wallet) |

Criação **idempotente** no bootstrap (`ensureQueues`) — nenhum passo manual de setup.

### 8.2 Consumidor (§10)

- **Reutiliza o mesmo caso de uso do HTTP** (`SubmitTransaction`) — fronteiras diferentes, regra em um lugar só; o corpo da mensagem é o envelope `{messageId, type, occurredAt, data}` com `data` nos mesmos campos do body HTTP;
- **Inbox atômica:** o comando carrega `delivery: {messageId, consumerName}` e a linha de inbox é gravada **na mesma transação SQL** dos efeitos — reentrega da mesma mensagem cai em replay e devolve a resposta original; corrida entre dois consumidores vira `UNIQUE (consumer_name, message_id)` → replay do vencedor;
- **Ack somente após o commit:** `DeleteMessage` roda depois do `execute` retornar. Crash entre commit e ack ⇒ redelivery ⇒ replay por inbox, sem efeito duplicado;
- **Classificação de erros:**
  - **negócio** (`REJECTED`) → é **resposta**, não falha → ack (o evento sai pela outbox);
  - **permanente** (JSON malformado, campo ausente, `OPENING` na fila, decimal inválido) → cópia na DLQ + ack da original;
  - **transitória** (lock esgotado, banco indisponível) → **sem ack** — a mensagem volta após a visibility timeout, e o `RedrivePolicy` encaminha à DLQ no limite de 5 tentativas;
- **SIGTERM:** `stop()` sinaliza e o loop conclui a mensagem em andamento antes de sair; a flag é re-checada **antes do sleep** para não desperdiçar um poll inteiro.

### 8.3 Transactional Outbox (§11)

- O evento é persistido (coluna `payload` com o envelope `toJSON()`) na **mesma transação** da mudança financeira: wallet + transação + ledger + inbox + outbox confirmam num único `flush`, antes do `COMMIT`;
- **Nada é publicado antes do commit** — eliminatório (§5);
- **Claim concorrente do publisher:** `FOR UPDATE SKIP LOCKED` (`LockMode.PESSIMISTIC_PARTIAL_WRITE`) + `scheduleRetry` (`attempts+1` e backoff exponencial de 1s até 5min). O backoff **é** a claim: o lock morre no commit, e o próximo vencimento impede re-claim. Dois publishers reivindicam lotes diferentes — sem perda e sem duplicação no fluxo normal;
- **At-least-once por desenho:** a publicação acontece **depois** do commit da claim; crash entre publicar e `markPublished` ⇒ próxima janela republica. Consumidor trata duplicata como replay (§7);
- Publicação falha não desfaz o claim: `nextAttemptAt` já agendado libera a mensagem na próxima janela.

Cenário da §11 (PG commita → processo morre antes de publicar → outra instância assume → evento publicado) coberto por teste.

### 8.4 Worker de referências fora de ordem (§7.1)

- `ReprocessPendingReferences` varre `PENDING_REFERENCE` (mais antigas primeiro) e delega a resolução ao `SubmitTransaction.reprocessPending` — as mesmas regras do submit, aplicadas em um lugar só;
- **TTL de 10 minutos** (`DEFAULT_PENDING_TTL_MS`): referência que não chega a tempo → `REJECTED` + `REFERENCE_NOT_FOUND` + evento `WagerTransactionRejected`;
- Loop com backoff exponencial quando ocioso (5s → 60s);
- Corrida entre workers é coberta pelo optimistic lock da wallet — o perdedor re-lê e encontra o estado já terminal.

---

## 9. Autenticação — decisão: não implementada

Conforme a §2 do desafio, autenticação **não vale pontos** (§14) e não deve competir com correção financeira, concorrência e idempotência. A decisão foi não implementá-la e focar o timebox nos 95 pontos do core.

**Desenho que seria adotado** (a ser discutido na apresentação):

- Identity Provider externo via OIDC — **Keycloak** no Docker Compose (alternativa mais leve: Zitadel);
- Um `AuthGuard` global do NestJS validando o JWT e populando o `providerId` autenticado no contexto da request;
- Uma `ProviderIdentityPort` na camada `application/ports/`, de modo que os casos de uso leiam a identidade por porta e não por framework — a troca de IdP não tocaria o domínio;
- Os endpoints de `/health/*` ficam abertos (exigência da §9);
- Mensagens vindas da fila são tratadas como canal interno confiável, **mantendo-se a validação de domínio** sobre a identidade do provedor contida na mensagem.

**Ponto de extensão:** a wiring global é `src/interfaces/http/app.module.ts` (aí entrariam `APP_GUARD`), e a porta de identidade entraria em `src/application/ports/`. **Esta extensão não foi escrita no código** — está registrada aqui como limitação consciente (§15).

---

## 10. Observabilidade

**Logs estruturados (JSON, uma linha por evento)** via `LoggerPort`, com contexto de correlação — `correlationId`, `messageId`, `transactionId`, `walletId`, `providerId` — propagado de HTTP (`x-correlation-id`) e de fila (`data.correlationId`) até o log e o evento. Sem payloads financeiros completos nem dados sensíveis.

**Health checks separados e abertos:**

- `GET /health/live` — processo vivo, não toca dependência externa;
- `GET /health/ready` — PostgreSQL **e** SQS alcançáveis; `503` se qualquer uma falhar;
- `GET /health/metrics` — métricas em Prometheus text format.

**Métricas** (`MetricsPort` → `InMemoryMetrics`):

| Métrica | Cobre (mínimo da §12) |
|---|---|
| `transactions_total{status}` | transações por status |
| `transactions_replayed_total` | duplicatas detectadas (replay) |
| `consumer_duplicates_total` | duplicatas detectadas (entrega) |
| `transaction_retries_total{reason}` / `consumer_retries_total{error}` | retries |
| `consumer_dlq_total{reason}` | mensagens em DLQ |
| `concurrency_conflicts_total` | conflitos de lock |
| `outbox_lag_ms` | outbox lag |
| `processing_latency_ms{status}` | latência de processamento |

Complementares: `outbox_published_total{eventType}`, `outbox_publish_failed_total`, `consumer_outcomes_total{status}`, `pending_reprocess_total{outcome}`, `http_errors_total{status}`, `reconciliation_divergence_total`.

**Reconciliação:** `POST /wallets/:walletId/reconciliation` compara o saldo materializado com o saldo reconstruído pelo ledger. Divergências **não** são corrigidas em silêncio: logadas, contabilizadas em métrica e sinalizadas na resposta (`consistent: false`).

OpenTelemetry e dashboards: não implementados (opcionais na §12).

---

## 11. API HTTP e mapeamento de status

O mapeamento é decisão da solução (§9), e o critério é que o provedor consiga decidir **sem interpretar mensagem de erro**:

| Código | Situação |
|---|---|
| `200` | Aplicada (`PROCESSED`) |
| `202` | Aceita, processamento pendente (`PENDING` \| `PENDING_REFERENCE`) |
| `400` | Payload inválido (corpo, cursor, `Money`, `kind`, `Idempotency-Key` ausente, referência obrigatória ausente) |
| `404` | Wallet ou transação inexistente |
| `409` | Conflito de idempotência (key com payload divergente, wallet duplicada) |
| `422` | Regra de negócio (`REJECTED` — o corpo carrega o `failureCode`) |
| `503` | Falha transitória de infraestrutura (retryable) |
| `500` | Inesperado (logado; nunca vaza stack para o provedor) |

Endpoints: `POST /wallets`, `GET /wallets/:walletId`, `GET /wallets/:walletId/ledger` (cursor opaco/keyset, não offset), `GET /wagering/transactions/:transactionId`, `GET /providers/:providerId/wagering/transactions/:externalTransactionId`, `POST /wagering/transactions`, `POST /wallets/:walletId/reconciliation`, `/health/*`. Um filtro global de erros (`APP_FILTER` único) garante o mapeamento consistente entre todos.

---

## 12. Testes

| Nível | Arquivos | Ferramenta | Foco |
|---|---|---|---|
| Unidade | 8 | `bun test` (domínio puro, sem I/O) | Money (escala, arredondamento, entradas inválidas), invariantes da Wallet, regras BET/WIN/LOSS/REFUND/ROLLBACK, conflito de moeda, payload divergente |
| Integração | 5 | `bun test` + **containers reais** (Postgres + LocalStack) | migrations/constraints, atomicidade wallet+ledger+inbox+outbox, redelivery, retry/DLQ, crash recovery, API HTTP |
| Concorrência / distribuído | — | `Promise.all` real, **não** mocks sequenciais | 50× replay → 1 débito; cenário da §8; wallets paralelas; ≥3 instâncias; 2+ publishers; worker morto pós-commit/pré-ack; out-of-order; reinício com consistência final |

**Suíte atual: 129 testes, 0 falhas, 486 asserções em 13 arquivos** (`bun test`, ~15s).

A suíte distribuída (`tests/integration/distributed.test.ts`) simula múltiplas instâncias com `orm.em.fork()` — cada "instância" tem identity map próprio e transações isoladas, sobre o mesmo pool de conexões do Postgres. Os publishers rodam **depois** do consumo, porque publicar em paralelo com a escrita dos efeitos faria o publisher enxergar a outbox vazia.

**Invariante final verificado em todos os testes:** `wallet.balance == saldo reconstruído pelo ledger`.

---

## 13. Trade-offs

| Decisão | Ganho | Custo |
|---|---|---|
| Optimistic locking + retry ≤3 | Sem deadlock, escala com N instâncias | Sob hot wallet, retries consomem tentativas (limitadas) |
| Outbox em vez de publicar direto | Atomicidade real — nenhum evento órfão, nada antes do commit | Latência de publicação e mais uma tabela |
| Inbox persistente em vez de cache | Correção com N instâncias e restarts | 1 INSERT a mais por mensagem (mitigado pelo UNIQUE) |
| `decimal.js` + `numeric(18,2)` | Exatidão monetária garantida ponta a ponta | Overhead de performance (irrelevante neste volume) |
| `READ COMMITTED` + controle explícito | Simples e performático | Exige disciplina de locking (mitigada por testes) |
| DI explícita (tokens + `useFactory`) | Previsível no Bun, sem reflection frágil | Mais verbosa que decorators |
| Auth não implementada | Foco nos 95 pontos do core | Decisão documentada em §9, discutida na apresentação |
| Transação única (UoW) para saldo + ledger + inbox + outbox | Ou tudo persiste, ou nada — ledger nunca fica órfão | `debit`/`credit` alteram estado em memória antes do `flush`; se a persistência falhar, a exceção propaga e nada é gravado (rollback). Fora de contexto transacional, o domínio só é persistido dentro de `em.transactional()` |

---

## 14. Taxonomia de failure codes

Toda rejeição carrega um `failureCode` estável e legível por máquina (§7.2), suficiente para o provedor decidir se reenvia, corrige o payload ou desiste:

| Código | Significado |
|---|---|
| `INSUFFICIENT_BALANCE` | BET maior que o saldo |
| `NEGATIVE_BALANCE_ON_REVERSAL` | Reversão deixaria o saldo negativo (distinto do caso acima: operacionalmente diferente) |
| `REFERENCE_REQUIRED` | REFUND/ROLLBACK sem `referenceExternalTransactionId` |
| `REFERENCE_NOT_FOUND` | Referência inexistente (TTL do worker esgotado) |
| `REFERENCE_ALREADY_REVERSED` | Referência já revertida pelo mesmo tipo |
| `REFERENCE_NOT_PROCESSED` | Referência existe, mas não está `PROCESSED` |
| `REFERENCE_SCOPE_MISMATCH` | Player, wallet, moeda ou rodada da referência ≠ da operação |
| `INVALID_KIND_FOR_REFERENCE` | REFUND só referencia BET; ROLLBACK só BET/WIN/REFUND |
| `AMOUNT_DIFFERS_FROM_REFERENCE` | Valor ≠ da referência (reversão parcial fora de escopo) |
| `CURRENCY_MISMATCH` | Moeda da operação ≠ moeda da wallet |
| `PLAYER_WALLET_MISMATCH` | `playerId` do payload ≠ dono da wallet |
| `IDEMPOTENCY_CONFLICT` | Mesma `Idempotency-Key` com `payloadHash` divergente |

Erros de **programação**, fora da taxonomia de negócio: `InvalidTransactionStateError` (transição a partir de estado terminal) e `InvalidLedgerError` (`UNBALANCED_ENTRY`). Não devem ocorrer em tráfego normal.

---

## 15. Limitações e o que não foi feito

- **Autenticação não implementada** — decisão da §9; o desenho previsto está descrito, mas o ponto de extensão (`AuthGuard` no-op / `ProviderIdentityPort`) **não está escrito no código**;
- **Teste de carga (`test:load`) não realizado** — é diferencial opcional na §14, não requisito;
- **Moeda única (BRL) nos testes** — o modelo permanece multi-moeda e conflitos de moeda são cobertos por teste (permitido pela §6.1);
- **Reversões parciais fora de escopo** — REFUND/ROLLBACK exigem valor igual ao da referência;
- **Ledger *double-entry* não implementado** — diferencial opcional, não requisito;
- **OpenTelemetry e dashboards não incluídos** — opcionais na §12;
- **Métricas em memória** (`InMemoryMetrics`) — suficiente para o endpoint `/metrics` em formato Prometheus; em produção real, seria substituída por um backend de métricas (a porta `MetricsPort` já isola essa troca);
- **"Instâncias" na suíte distribuída são forks de EntityManager** sobre o mesmo Postgres — é o que o ambiente local permite; o processo em si (loops, SIGTERM, crash) é testado de verdade.
