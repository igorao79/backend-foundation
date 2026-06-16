// Observability: request-id propagation, per-request structured log line, Prometheus /metrics.
// Mount requestContextMiddleware() FIRST (before routers) so req.id exists everywhere downstream.
// Expose metricsHandler() on GET /metrics (scrape it from Prometheus / an agent).
import { randomUUID } from 'node:crypto';
import { logger as defaultLogger } from './logger.helper.js';

const PREFIX = (process.env.METRICS_PREFIX || 'app').replace(/[^a-zA-Z0-9_]/g, '_');
const REQUEST_ID_HEADER = 'x-request-id';

function cleanRequestId(value) {
    const raw = Array.isArray(value) ? value[0] : value;
    if (typeof raw !== 'string') return null;
    const trimmed = raw.trim();
    return /^[a-zA-Z0-9._:-]{1,128}$/.test(trimmed) ? trimmed : null;   // accept caller's id, but bound it
}

// Collapse high-cardinality path segments (ids, uuids) so label cardinality stays bounded.
function normalizePath(req) {
    const raw = req.route?.path || req.path || req.originalUrl || req.url || '/';
    return String(raw).split('?')[0]
        .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}/gi, ':id')
        .replace(/\/\d+(?=\/|$)/g, '/:id')
        .slice(0, 160) || '/';
}

const labelsKey = (labels) => JSON.stringify(labels);
const escapeLabel = (v) => String(v).replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/\n/g, '\\n');
const formatLabels = (labels) => Object.entries(labels).map(([k, v]) => `${k}="${escapeLabel(v)}"`).join(',');

export function createHttpMetrics() {
    const requests = new Map();    // key → { labels, value }
    const durations = new Map();   // key → { labels, count, sum, max }
    return {
        recordHttpRequest({ method, path, status, durationMs }) {
            const labels = { method, path, status: String(status) };
            const key = labelsKey(labels);
            requests.set(key, { labels, value: (requests.get(key)?.value || 0) + 1 });
            const d = durations.get(key) || { labels, count: 0, sum: 0, max: 0 };
            d.count += 1; d.sum += durationMs; d.max = Math.max(d.max, durationMs);
            durations.set(key, d);
        },
        // Optional: register extra gauges (queue depth, open circuits, ...) via this hook.
        gauges: new Map(),         // name → () => number  (or { help, fn })
        setGauge(name, fn, help = '') { this.gauges.set(name, { fn, help }); },
        snapshot() {
            let total = 0;
            for (const row of requests.values()) total += row.value;
            return { http_requests_total: total };
        },
        toPrometheus() {
            const lines = [
                `# HELP ${PREFIX}_http_requests_total Total HTTP requests.`,
                `# TYPE ${PREFIX}_http_requests_total counter`,
            ];
            for (const { labels, value } of requests.values())
                lines.push(`${PREFIX}_http_requests_total{${formatLabels(labels)}} ${value}`);
            lines.push(
                `# HELP ${PREFIX}_http_request_duration_ms HTTP request duration in milliseconds.`,
                `# TYPE ${PREFIX}_http_request_duration_ms summary`,
            );
            for (const { labels, count, sum, max } of durations.values()) {
                const l = formatLabels(labels);
                lines.push(`${PREFIX}_http_request_duration_ms_count{${l}} ${count}`);
                lines.push(`${PREFIX}_http_request_duration_ms_sum{${l}} ${sum}`);
                lines.push(`${PREFIX}_http_request_duration_ms_max{${l}} ${max}`);
            }
            for (const [name, { fn, help }] of this.gauges) {
                try {
                    const value = Number(fn());
                    if (!Number.isFinite(value)) continue;
                    if (help) lines.push(`# HELP ${PREFIX}_${name} ${help}`);
                    lines.push(`# TYPE ${PREFIX}_${name} gauge`, `${PREFIX}_${name} ${value}`);
                } catch { /* a broken gauge must never break the scrape */ }
            }
            return `${lines.join('\n')}\n`;
        },
    };
}

export const httpMetrics = createHttpMetrics();

/** Assigns/propagates a request id, sets X-Request-Id, and on finish records metrics + one structured log line. */
export function requestContextMiddleware({
    logger = defaultLogger,
    metrics = httpMetrics,
    now = () => Date.now(),
    idGenerator = randomUUID,
} = {}) {
    return (req, res, next) => {
        const startedAt = now();
        const requestId = cleanRequestId(req.headers?.[REQUEST_ID_HEADER]) || idGenerator();
        req.id = requestId;
        req.request_id = requestId;
        res.setHeader('X-Request-Id', requestId);
        res.on('finish', () => {
            const durationMs = Math.max(0, now() - startedAt);
            const path = normalizePath(req);
            const status = res.statusCode || 0;
            metrics.recordHttpRequest({ method: req.method, path, status, durationMs });
            logger.info({ request_id: requestId, method: req.method, path, status, duration_ms: durationMs }, 'http.request');
        });
        next();
    };
}

export function metricsHandler(metrics = httpMetrics) {
    return (req, res) => {
        res.setHeader('Content-Type', 'text/plain; version=0.0.4; charset=utf-8');
        res.end(metrics.toPrometheus());
    };
}
