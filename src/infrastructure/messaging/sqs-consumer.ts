import {
    DeleteMessageCommand,
    ReceiveMessageCommand,
    SendMessageCommand,
    type Message,
    type SQSClient,
} from "@aws-sdk/client-sqs";
import {
    SubmitTransaction,
    type SubmitTransactionCommand,
} from "../../application/use-cases/submit-transaction";
import { InvalidRequestError } from "../../application/errors";
import { InvalidMoneyError } from "../../domain/money";
import { InvalidTransactionError, WagerTransactionKind, WagerTransactionStatus } from "../../domain/wager-transaction";
import { QUEUE_URLS } from "./sqs-client";

export const CONSUMER_NAME = "wager-transactions-consumer";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Consumidor da wager-transactions.fifo (§10):
 * - reutiliza o MESMO use case da borda HTTP (SubmitTransaction) — regras num lugar só;
 * - dedup de reentrega via inbox persistente (gravada na transação dos efeitos);
 * - ack (delete) SOMENTE após o commit;
 * - erros de negócio (REJECTED) são terminal e ack; permanentes vão para a DLQ;
 *   transitórios não são ack — a mensagem volta após a visibility timeout e o
 *   redrive da fila a encaminha para a DLQ no limite de tentativas;
 * - stop() conclui a mensagem em andamento antes de sair (SIGTERM, §10).
 */
export class WagerTransactionConsumer {
    private running = false;

    constructor(
        private readonly client: SQSClient,
        private readonly submitTransaction: SubmitTransaction,
    ) { }

    /**
     * Um passe de consumo: recebe até 10 → processa → deleta. Retorna quantas
     * mensagens foram consumidas (para o loop decidir drenar backlog sem esperar).
     */
    async processAvailable(maxMessages = 10): Promise<number> {
        const received = await this.client.send(new ReceiveMessageCommand({
            QueueUrl: QUEUE_URLS.inbound,
            MaxNumberOfMessages: maxMessages,
            WaitTimeSeconds: 1,        // long polling — sem spinner ocioso
            VisibilityTimeout: 30,     // janela para processar antes do redelivery
        }));
        let consumed = 0;
        for (const message of received.Messages ?? []) {
            await this.handle(message);
            consumed++;
        }
        return consumed;
    }

    private async handle(message: Message): Promise<void> {
        const messageId = message.MessageId ?? "";
        const body = message.Body ?? "";

        let command: SubmitTransactionCommand;
        try {
            command = parseCommand(body, messageId);
        } catch {
            // permanente: payload não é recuperável → DLQ para diagnóstico (§10)
            await this.toDlq(body, messageId, "MALFORMED_MESSAGE");
            await this.ack(message);
            return;
        }

        try {
            const result = await this.submitTransaction.execute(command);
            // REJECTED é decisão de negócio, não falha: terminal → ack; o
            // evento WagerTransactionRejected sai pela outbox (§11)
            if (result.status === WagerTransactionStatus.Rejected)
                console.log(JSON.stringify({
                    event: "wager_transaction_rejected",
                    transactionId: result.transactionId,
                    failureCode: result.failureCode,
                }));
            await this.ack(message);
        } catch (error) {
            if (isPermanent(error)) {
                // não recuperável (ex.: OPENING tentado pela fila) → DLQ + ack
                await this.toDlq(body, messageId, errorName(error));
                await this.ack(message);
                return;
            }
            // transitória (lock esgotado, banco fora): NÃO ack — a mensagem
            // volta após a visibility timeout e o redrive decide a DLQ (§10)
            console.log(JSON.stringify({
                event: "message_processing_failed",
                messageId,
                retryable: true,
                error: errorName(error),
            }));
        }
    }

    private async ack(message: Message): Promise<void> {
        await this.client.send(new DeleteMessageCommand({
            QueueUrl: QUEUE_URLS.inbound,
            ReceiptHandle: message.ReceiptHandle,
        }));
    }

    /** cópia na DLQ + ack da original: o consumidor escolhe o destino, não o redrive */
    private async toDlq(body: string, messageId: string, reason: string): Promise<void> {
        await this.client.send(new SendMessageCommand({
            QueueUrl: QUEUE_URLS.dlq,
            MessageBody: body || "{}",
            MessageGroupId: "dlq",
            MessageDeduplicationId: `${messageId}-${reason}`,
            MessageAttributes: {
                Reason: { DataType: "String", StringValue: reason },
            },
        }));
    }

    /** loop contínuo — stop() conclui a mensagem em andamento (§10 SIGTERM) */
    async start(pollMs = 1_000): Promise<void> {
        this.running = true;
        while (this.running) {
            try {
                await this.processAvailable();
            } catch (error) {
                console.log(JSON.stringify({ event: "consumer_poll_failed", error: errorName(error) }));
            }
            // re-checa a flag ANTES de dormir: stop() durante o passe em
            // andamento não pode custar um poll inteiro de espera
            if (this.running) await sleep(pollMs);
        }
    }

    stop(): void { this.running = false; }
}

/**
 * Contrato do payload na fila: envelope com `data` nos MESMOS campos do body
 * HTTP — fronteiras diferentes, comando único do use case (§10).
 */
function parseCommand(body: string, messageId: string): SubmitTransactionCommand {
    const envelope = JSON.parse(body) as { data?: Record<string, unknown> };
    const data = envelope.data;
    if (!data || typeof data !== "object") throw new InvalidRequestError("MISSING_ENVELOPE_DATA");

    const kind = String(data.kind) as WagerTransactionKind;
    if (!Object.values(WagerTransactionKind).includes(kind))
        throw new InvalidRequestError("INVALID_KIND");
    const money = data.money as { amount?: unknown; currency?: unknown } | undefined;
    if (!money || typeof money.amount !== "string" || typeof money.currency !== "string")
        throw new InvalidRequestError("INVALID_MONEY");

    return {
        idempotencyKey: requireString(data.idempotencyKey, "IDEMPOTENCY_KEY"),
        providerId: requireString(data.providerId, "PROVIDER_ID"),
        externalTransactionId: requireString(data.externalTransactionId, "EXTERNAL_TRANSACTION_ID"),
        playerId: requireString(data.playerId, "PLAYER_ID"),
        walletId: requireString(data.walletId, "WALLET_ID"),
        roundId: requireString(data.roundId, "ROUND_ID"),
        gameId: requireString(data.gameId, "GAME_ID"),
        kind,
        // Money.from dentro do use case valida decimal/escala — inválido aqui
        // vira erro permanente → DLQ
        money: { amount: money.amount, currency: money.currency },
        referenceExternalTransactionId: typeof data.referenceExternalTransactionId === "string"
            ? data.referenceExternalTransactionId
            : undefined,
        // dedup de reentrega: inbox persistente por (consumerName, messageId)
        delivery: { messageId, consumerName: CONSUMER_NAME },
    };
}

function requireString(value: unknown, field: string): string {
    if (typeof value !== "string" || value.trim() === "")
        throw new InvalidRequestError(`MISSING_${field}`);
    return value;
}

/** erros que a fila não resolve por retry — payload inválido é permanente (§10) */
function isPermanent(error: unknown): boolean {
    return error instanceof InvalidRequestError
        || error instanceof InvalidTransactionError
        || error instanceof InvalidMoneyError;
}

function errorName(error: unknown): string {
    return error instanceof Error ? error.name : "unknown";
}
