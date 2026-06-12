# Queues & workers: BullMQ layers, retries, circuit breaker, webhook delivery

Templates: `templates/queues.connection.js`, `templates/worker.factory.js`.

Four layers, each its own file(s):
`queues/connection.js` (Redis + factories) → `queues/*.queue.js` (one per queue) → `workers/worker-config.js` (tuning) → `workers/*.worker.js` (consumers) — with `index.js` barrels on both sides.

## Connection layer

```js
const PREFIX = process.env.QUEUE_PREFIX || '';
export const QUEUE = { CALLBACKS: 'callbacks', NOTIFICATIONS: 'notifications', /* ... */ };

export function queuePrefix() { return PREFIX ? `bull:${PREFIX}` : 'bull'; }

export function makeConnection() {                 // fresh conn per queue/worker (BullMQ blocking ops)
    const conn = new IORedis({ host, port, password, maxRetriesPerRequest: null }); // null is REQUIRED by BullMQ
    conn.on('error', (err) => logger.error('[Redis] connection error:', err.message));
    _connections.add(conn);
    return conn;
}

export function defineQueue(name, defaultJobOptions) {
    return registerQueue(new Queue(name, { connection: makeConnection(), prefix: queuePrefix(), defaultJobOptions }));
}

export async function closeQueues() {              // graceful shutdown
    for (const q of _queues) await q.close().catch(() => {});
    for (const c of _connections) await c.quit().catch(() => {});
}
```

`QUEUE_PREFIX` gives env/tenant namespace isolation on a shared Redis (dev vs prod vs staging).

## One file per queue + barrel

```js
// queues/callbacks.queue.js
export const callbackQueue = defineQueue(QUEUE.CALLBACKS, { removeOnComplete: 100, removeOnFail: 500 });

const callbackJobId = (log) => `CallbackLog:${log.id}`;            // idempotent job id
export const enqueueCallbackJob = (log) =>
    callbackQueue.add('send', { logId: log.id }, { ...callbackJobOptions(log.max_attempts), jobId: callbackJobId(log) });
export async function reenqueueCallback(log) {                      // manual retry button
    try { await callbackQueue.remove(callbackJobId(log)); } catch {}
    await enqueueCallbackJob(log);
}
```

Cleanup conventions: high-volume queues keep last ~100 completed / ~500 failed for debugging; fire-and-forget queues `removeOnComplete: true`; audit-ish queues `removeOnComplete: { age: 3600 }`.

**Jobs carry IDs, not payloads** — the worker re-reads state from the DB. Combined with `jobId` dedup this makes enqueue idempotent and the DB row the source of truth.

## worker-config.js — central tuning

```js
export const CALLBACK_RETRY_DELAYS_MS  = [5_000, 30_000, 300_000, 1_800_000, 7_200_000]; // 5s,30s,5m,30m,2h
export const BROADCAST_RETRY_DELAYS_MS = [5_000, 15_000, 60_000];

export const WORKER_CONFIG = {
    callbacks: {
        consumer: { concurrency: intEnv('CALLBACK_CONCURRENCY', 30), limiter: { max: 50, duration: 1000 } },
        producer: { attempts: 5, backoff: { type: 'custom' }, removeOnComplete: 100, removeOnFail: 500 },
        retryDelaysMs: CALLBACK_RETRY_DELAYS_MS,
    },
    // ... one entry per queue
};
```

`consumer` = concurrency + rate limiter; `producer` = attempts/backoff/cleanup defaults; env overrides per deployment.

## Uniform worker shape

```js
const connection = makeConnection();
export function startXWorker() {
    const worker = new Worker(QUEUE.X, async (job) => {
        // 1) re-read state from DB by job.data.id; 2) guard (already done? → return)
        // 3) do the work; 4) THROW on retryable failure, RETURN on success/permanent-skip
    }, {
        connection, prefix: queuePrefix(), ...WORKER_CONFIG.x.consumer,
        settings: { backoffStrategy: (attemptsMade) => RETRY_DELAYS[attemptsMade] ?? RETRY_DELAYS.at(-1) },
    });
    worker.on('failed', (job, err) => void notifyAdmins({ worker: 'x', job, err }));   // fire-and-forget alert
    return worker;
}
```

Contract: `throw` = BullMQ retries with backoff; `return` = done (including "permanent failure, recorded in DB, don't retry"). Validate `job.data` shape at the top for irreversible actions (broadcasts, sends) — fail fast on malformed payloads.

Selective retry (e.g. on-chain broadcast): classify errors; `backoffStrategy: (attempts, type, err) => isRetryable(err) ? DELAYS[attempts-1] ?? DELAYS.at(-1) : 0`.

Orchestration barrels:

```js
// workers/index.js
export async function startWorkers() { workers = [startCallbackWorker(), startNotifyWorker(), ...]; }
export async function stopWorkers()  { for (const w of workers) await w?.close?.().catch(() => {}); }
```

## Webhook (callback) delivery — the advanced pattern

BullMQ retries alone aren't enough for webhooks; delivery state lives in a DB log row (`CallbackLog: url, payload, status, attempts, max_attempts, next_attempt_at, last_response_*`), and the worker layers on:

1. **Circuit breaker per URL** (in-memory `Map`): ≥10 consecutive failures opens the circuit for 15 min — defers jobs instead of hammering a dead endpoint; success closes it; idle entries GC'd after 24 h.
2. **SSRF guard**: `resolveAndAssertPublic(url)` (DNS resolve + reject loopback/private/link-local/metadata ranges) before every send.
3. **Response classification**: 2xx → `status='success'`, mark delivered, done. Permanent 4xx (400/401/403/404/410) → `status='failed'`, NO retry, job returns. 5xx/network → schedule `next_attempt_at` per delay table, save, `throw` so BullMQ retries.
4. **Attempt accounting** on the log row (`attempts`, `last_attempt_at`, response code/body excerpt) — operators see full history and can hit "retry" (→ `reenqueueCallback`).

Worker body guard: `if (!log || log.status !== 'pending') return;` — a job for an already-delivered/cancelled log exits silently.
