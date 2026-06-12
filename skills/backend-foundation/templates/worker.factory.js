// Uniform BullMQ worker factory + CircuitBreaker for outbound deliveries (webhooks).
// Contract inside a processor: THROW on retryable failure (BullMQ retries with backoff),
// RETURN on success or recorded-permanent-failure (no retry).
import { Worker } from 'bullmq';
import { makeConnection, queuePrefix } from '../queues/connection.js';
import { logger } from '../src/core/logger.helper.js';

export const intEnv = (name, fallback) => parseInt(process.env[name] || String(fallback), 10);

// Central per-queue tuning. consumer = concurrency/limiter; producer = job defaults.
export const WORKER_CONFIG = {
    callbacks: {
        consumer: { concurrency: intEnv('CALLBACK_CONCURRENCY', 30), limiter: { max: 50, duration: 1000 } },
        producer: { attempts: 5, backoff: { type: 'custom' }, removeOnComplete: 100, removeOnFail: 500 },
        retryDelaysMs: [5_000, 30_000, 300_000, 1_800_000, 7_200_000], // 5s,30s,5m,30m,2h
    },
    // ...one entry per queue
};

/**
 * createWorker('callbacks', QUEUE.CALLBACKS, processor, { onFailed })
 * — wires connection, prefix, config and a custom backoff schedule uniformly.
 */
export function createWorker(configKey, queueName, processor, { onFailed } = {}) {
    const cfg = WORKER_CONFIG[configKey] || { consumer: {} };
    const delays = cfg.retryDelaysMs;
    const worker = new Worker(queueName, processor, {
        connection: makeConnection(),
        prefix: queuePrefix(),
        ...cfg.consumer,
        ...(delays ? {
            settings: {
                backoffStrategy: (attemptsMade, type, err) => delays[attemptsMade - 1] ?? delays.at(-1),
            },
        } : {}),
    });
    worker.on('failed', (job, err) => {
        logger.error(`[Worker:${configKey}] job ${job?.id} failed:`, err.message);
        if (onFailed) void Promise.resolve(onFailed(job, err)).catch(() => {});
    });
    return worker;
}

// Orchestration barrel (workers/index.js):
// let workers = [];
// export async function startWorkers() { workers = [startCallbackWorker(), ...]; logger.info('[Workers] started'); }
// export async function stopWorkers()  { for (const w of workers) await w?.close?.().catch(() => {}); }

/**
 * Circuit breaker keyed by URL/host — stop hammering a dead endpoint.
 * recordFailure() on every failure; after `failThreshold` consecutive failures the circuit opens
 * for `pauseMs`; circuitDelay() returns ms to defer (0 = closed). recordSuccess() resets.
 */
export class CircuitBreaker {
    #state = new Map(); // key → { fails, openedAt, lastTouched }

    constructor({ failThreshold = 10, pauseMs = 15 * 60_000, idleMs = 24 * 60 * 60_000 } = {}) {
        this.failThreshold = failThreshold;
        this.pauseMs = pauseMs;
        this.idleMs = idleMs;
    }

    #gc() {
        const now = Date.now();
        for (const [k, s] of this.#state) if (now - s.lastTouched > this.idleMs) this.#state.delete(k);
    }

    recordFailure(key) {
        this.#gc();
        const s = this.#state.get(key) || { fails: 0, openedAt: 0, lastTouched: 0 };
        s.fails += 1;
        s.lastTouched = Date.now();
        if (s.fails >= this.failThreshold && !s.openedAt) s.openedAt = Date.now();
        this.#state.set(key, s);
    }

    recordSuccess(key) {
        this.#state.delete(key);
    }

    /** ms to wait before next attempt; 0 = circuit closed. */
    circuitDelay(key) {
        const s = this.#state.get(key);
        if (!s || !s.openedAt) return 0;
        const elapsed = Date.now() - s.openedAt;
        if (elapsed >= this.pauseMs) { s.openedAt = 0; s.fails = 0; return 0; } // half-open
        return this.pauseMs - elapsed;
    }
}

// Webhook delivery recipe (see references/queues-workers.md):
// 1) job carries only logId; worker re-reads the CallbackLog row; if status !== 'pending' → return.
// 2) breaker.circuitDelay(url) > 0 → push next_attempt_at forward, return (defer, don't burn an attempt).
// 3) SSRF-guard the URL, send; 2xx → success+recordSuccess; permanent 4xx → failed, return;
//    5xx/network → recordFailure, schedule next_attempt_at from retryDelaysMs, save, THROW.
