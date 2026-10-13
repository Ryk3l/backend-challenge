import type { MetricsPort, MetricLabels } from "../../application/ports/metrics";

interface Series {
    labels: MetricLabels;
    value: number;
}

/**
 * Coletor de métricas em memória com renderização no formato de texto do
 * Prometheus (§12). Contadores e observações são agregados por
 * (nome + labels) — suficiente para expor em /metrics sem dependência externa.
 *
 * Nota de honestidade: o estado vive na memória do processo (reset a cada
 * restart), o que é adequado para o escopo do desafio. Em produção real
 * usaria um client Prometheus/OTel — a porta `MetricsPort` é o ponto de troca.
 */
export class InMemoryMetrics implements MetricsPort {
    private readonly counters = new Map<string, Series>();
    private readonly observations = new Map<string, Series[]>();

    increment(name: string, labels: MetricLabels = {}, value = 1): void {
        const key = seriesKey(name, labels);
        const existing = this.counters.get(key);
        if (existing) existing.value += value;
        else this.counters.set(key, { labels: { ...labels }, value });
    }

    observe(name: string, value: number, labels: MetricLabels = {}): void {
        const key = seriesKey(name, labels);
        const bucket = this.observations.get(key) ?? [];
        bucket.push({ labels, value });
        this.observations.set(key, bucket);
    }

    /** texto Prometheus: contadores + resumo (count/sum) das observações */
    snapshot(): string {
        const lines: string[] = [];
        for (const [key, series] of this.counters) {
            const name = metricNameOf(key);
            lines.push(`# TYPE ${name} counter`);
            lines.push(`${renderSeries(name, series.labels)} ${series.value}`);
        }
        for (const [key, samples] of this.observations) {
            const name = metricNameOf(key);
            lines.push(`# TYPE ${name} summary`);
            const total = samples.reduce((acc, s) => acc + s.value, 0);
            const count = samples.length;
            const labels = samples[0]?.labels ?? {};
            lines.push(`${renderSeries(name + "_count", labels)} ${count}`);
            lines.push(`${renderSeries(name + "_sum", labels)} ${total.toFixed(3)}`);
        }
        return lines.join("\n") + (lines.length ? "\n" : "");
    }
}

// chave estável: nome + labels ordenados — garante agregação consistente
function seriesKey(name: string, labels: MetricLabels): string {
    const parts = Object.keys(labels).sort().map((k) => `${k}=${labels[k]}`);
    return [name, ...parts].join("\u0000");
}

function metricNameOf(key: string): string {
    return key.split("\u0000")[0] ?? "metric";
}

function renderSeries(name: string, labels: MetricLabels): string {
    const entries = Object.keys(labels).sort();
    if (!entries.length) return name;
    const inner = entries.map((k) => `${k}="${escapeLabel(labels[k] ?? "")}"`).join(",");
    return `${name}{${inner}}`;
}

function escapeLabel(value: string): string {
    return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}
