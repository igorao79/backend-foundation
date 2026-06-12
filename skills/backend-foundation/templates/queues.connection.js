// BullMQ connection layer: Redis connections, queue name constants, prefix isolation,
// defineQueue factory, and closeQueues for graceful shutdown.
import IORedis from 'ioredis';
import { Queue } from 'bullmq';
import { logger } from '../src/core/logger.helper.js';

const PREFIX = process.env.QUEUE_PREFIX || '';

// One constant per queue — the single naming registry.
export const QUEUE = {
    CALLBACKS: 'callbacks',
    NOTIFICATIONS: 'notifications',
    // ...add yours
};

/** Namespace isolation: dev/staging/prod can share a Redis, isolated by QUEUE_PREFIX. */
export function queuePrefix() {
    return PREFIX ? `bull:${PREFIX}` : 'bull';
}

const _connections = new Set();
const _queues = new Set();

/** Fresh connection per queue/worker — BullMQ requires maxRetriesPerRequest: null for blocking ops. */
export function makeConnection() {
    const conn = new IORedis({
        host: process.env.REDIS_HOST || 'localhost',
        port: parseInt(process.env.REDIS_PORT || '6379', 10),
        password: process.env.REDIS_PASSWORD || undefined,
        maxRetriesPerRequest: null,
    });
    conn.on('error', (err) => logger.error('[Redis] connection error:', err.message));
    _connections.add(conn);
    return conn;
}

export function registerQueue(q) {
    _queues.add(q);
    return q;
}

export function defineQueue(name, defaultJobOptions) {
    return registerQueue(new Queue(name, {
        connection: makeConnection(),
        prefix: queuePrefix(),
        defaultJobOptions,
    }));
}

export async function closeQueues() {
    for (const q of _queues) await q.close().catch(() => {});
    for (const c of _connections) await c.quit().catch(() => {});
}

// ---- per-queue files follow this template (one file per queue + an index.js barrel): ----
// export const callbackQueue = defineQueue(QUEUE.CALLBACKS, { removeOnComplete: 100, removeOnFail: 500 });
// const jobId = (log) => `CallbackLog:${log.id}`;                       // idempotent job id
// export const enqueueCallbackJob = (log) =>
//     callbackQueue.add('send', { logId: log.id }, { attempts: log.max_attempts || 5, backoff: { type: 'custom' }, jobId: jobId(log) });
// export async function reenqueueCallback(log) {                       // manual "retry" button
//     try { await callbackQueue.remove(jobId(log)); } catch {}
//     await enqueueCallbackJob(log);
// }
