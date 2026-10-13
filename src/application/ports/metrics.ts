// Porta de métricas (§12): contadores e histogramas expostos por nome.
// Implementação concreta serializa em Prometheus text format no /metrics.

export type MetricLabels = Record<string, string>;

export interface MetricsPort {
    /** contador monótono (transações por status, duplicatas, retries, DLQ, ...) */
    increment(name: string, labels?: MetricLabels, value?: number): void;
    /** medição de tempo/valor (latência de processamento, outbox lag) */
    observe(name: string, value: number, labels?: MetricLabels): void;
    /** instantâneo para o endpoint /metrics */
    snapshot(): string;
}
