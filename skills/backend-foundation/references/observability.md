# Observability & outbound safety: request context, /metrics, /health, SSRF guard

Templates: `templates/metrics.helper.js`, `templates/network-security.helper.js`. These make every backend introspectable (who called what, how slow, is it up) and safe when it calls *out* (webhooks/callbacks can't be turned into SSRF).

## Request context — one id, one log line per request

`requestContextMiddleware()` is mounted **first**, before any router (it's the `requestContextMiddleware` referenced in `bootstrap.md`'s assembly order). For every request it:

1. Accepts an inbound `X-Request-Id` (validated/bounded) or generates a UUID; exposes it as `req.id` / `req.request_id` and echoes `X-Request-Id` on the response.
2. On `res.finish`, records metrics and emits **one** structured log line: `{ request_id, method, path, status, duration_ms }`.

The id is the correlation thread: pass it to downstream services (`X-Request-Id` header on outbound calls), include it in enqueued job payloads, and stamp it on error alerts so a Telegram/Slack alert links back to the exact request. `error.middleware.js`'s notify hook should include `req.id`.

Path is **normalized** before it becomes a metric label (`/users/123` → `/users/:id`, uuids → `:id`) so label cardinality stays bounded — unbounded labels are the classic way to melt a Prometheus instance.

## Metrics — Prometheus text on GET /metrics

`httpMetrics` is a process-local registry; `metricsHandler()` renders it in Prometheus 0.0.4 text format. Out of the box you get:

- `<prefix>_http_requests_total{method,path,status}` — counter
- `<prefix>_http_request_duration_ms{count,sum,max}` — summary

`<prefix>` comes from `METRICS_PREFIX` (default `app`). Register extra gauges with `httpMetrics.setGauge(name, fn, help)` for things worth alerting on: queue depth, open circuit breakers, DB pool in-use, pending-withdrawal count. A throwing gauge can never break the scrape (guarded).

Mounting: `app.get('/metrics', metricsHandler())`. In multi-process/cluster mode each replica exposes its own counters — scrape per-instance and aggregate in Prometheus, or gate `/metrics` to an internal network. Don't try to globally synchronize counters in-process.

## Health — GET /health

A liveness/readiness endpoint that actually checks dependencies, not just `return 200`:

```js
app.get('/health', asyncHandler(async () => {
    await sequelize.authenticate();                 // DB reachable
    // optional: await redis.ping(); queue depth sane; encryption-key fingerprint matches
    return { status: 'ok', uptime_s: Math.round(process.uptime()) };
}));
```

Keep it cheap and unauthenticated (load balancers hit it constantly), but make it fail when a hard dependency is down so orchestrators stop routing to a broken replica. Distinguish liveness (process up) from readiness (deps up) if your platform supports both.

## Outbound safety — SSRF guard

Any time the backend fetches a **user/tenant-controlled URL** (webhook, callback, avatar fetch, link preview, redirect target) it can be tricked into hitting internal services — cloud metadata (`169.254.169.254`), `localhost`, RFC1918 hosts. `network-security.helper.js` is the defense:

- **`safeOutboundUrl(url, { fieldName, allowedHost })`** — call at **write time** when a tenant saves a webhook URL. Rejects forbidden schemes (`file:`, `javascript:`, …), embedded credentials, non-https, and literal private/loopback/link-local hosts. `allowedHost` optionally pins the URL to a verified domain + subdomains.
- **`resolveAndAssertPublic(url)`** — call at **send time**, immediately before every outbound fetch in the worker. It re-resolves DNS and asserts *every* answer is public, defeating **DNS rebinding** (a host that validated at write time but now resolves to `127.0.0.1`). Throws `ApiError` (`OUTBOUND_BLOCKED` / `DNS_FAIL`) on any rejection.

Both honor `ALLOW_PRIVATE_OUTBOUND=true` / `ALLOW_HTTP_OUTBOUND=true` as explicit dev/test escape hatches — never set in production. The callback worker in `queues-workers.md` calls `resolveAndAssertPublic` before each delivery; wire it there.

## getClientIP — the one true client IP

`network-security.helper.js` also exports `getClientIP(req)` — the **single** proxy-aware source of client IP used by rate limiters, login lockouts, and audit logs. It honors (in order) a configured `CLIENT_IP_HEADER` (e.g. `cf-connecting-ip`), a `TRUSTED_PROXY_CIDRS` allowlist (walk the XFF chain right-to-left, first untrusted hop = client), or a fixed `TRUSTED_PROXY_HOPS` count, falling back to the socket address. Never read `X-Forwarded-For` ad hoc anywhere else — a spoofable IP defeats every limiter and lockout keyed on it.
