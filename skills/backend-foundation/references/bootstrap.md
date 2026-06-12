# Bootstrap: server.js composition, two-phase main(), crons, graceful shutdown, env

Templates: `templates/env.js`, `templates/crons.js`.

## server.js — assembly order

```js
import './env.js';                       // FIRST import: dotenv cascade + fail-fast validation
// ... other imports
const app = express();
app.set('trust proxy', TRUSTED_PROXY_HOPS);

app.use(requestContextMiddleware({ logger }));   // request id / context (optional)
app.use(express.json());
app.use(cookieParser());
app.use(respondMiddleware);                      // res.ok()/res.okPage()
app.use(cors({ origin: (origin, cb) => (!origin || allowed.includes(origin)) ? cb(null, true) : cb(new Error('CORS')), credentials: true }));

// mounts — protection chain visible at each mount; test/sandbox routers BEFORE their prod prefix, non-prod only
if (NODE_ENV !== 'production' || ENABLE_TEST_ROUTER === 'true') app.use('/api/v1/test', testRouter);
app.use('/api/v1',  apiRateLimit, apiLoggerMiddleware, signatureMiddleware, apiRouter);
app.use('/auth',    authRouter);
app.use('/admin',   adminRateLimit, adminMiddleware, adminRouter);

app.get('/health', asyncHealthHandler);          // checks DB reachability, returns key freshness info
app.get('/metrics', metricsHandler());
app.all(/(.*)/, (req, res) => res.status(404).json({ success: false, error: { message: 'Not found', code: 'NOT_FOUND', errors: [] } }));
app.use(errorMiddleware);                        // LAST
```

## Crash handlers (top of file)

```js
let _exiting = false;
const _terminate = (label, reason) => {
    logger.error(`[${label}] reason:`, reason);
    if (reason instanceof Error && reason.stack) logger.error(`[${label}] stack:`, reason.stack);
    if (_exiting) return; _exiting = true;
    setTimeout(() => process.exit(1), 100).unref();   // give logs a tick to flush
};
process.on('unhandledRejection', (r) => _terminate('UnhandledRejection', r));
process.on('uncaughtException',  (e) => _terminate('UncaughtException', e));
```

## Two-phase startup

**Phase 1 (before listen)** — everything HTTP correctness depends on:
1. DB connect + migrations + sync (importing `db.js` does this)
2. `ensureBaseRows()` — idempotent singleton rows
3. runtime config overrides from DB (`systemConfigService.loadPersisted()`)
4. `app.listen(port, host)` → log a grep-able "Server is running"

**Phase 2 (after listen, in `main().then(...)`)** — background machinery:
1. `await startWorkers()` — BullMQ consumers
2. **Single-instance gating** for cluster mode: `const isPrimary = (process.env.NODE_APP_INSTANCE ?? '0') === (process.env.MONITOR_INSTANCE ?? '0')` — crons, monitors, reconciliation intervals, bots start only on the primary replica; others log "skipping".
3. `startCrons()`, periodic reconciliation `setInterval`s, external listeners/bots — each behind its own env kill-switch (`DISABLE_MONITORS`, `BOT_SEPARATE_PROCESS`, …).

`main().catch((err) => { logger.error(err); process.exit(1); })`.

## Crons factory

```js
function startCron(name, everyMs, tickFn, { runOnBoot = false } = {}) {
    let ticking = false;                             // overlap guard: slow tick? skip, don't stack
    const run = async () => {
        if (ticking) return;
        ticking = true;
        try { await tickFn(); }
        catch (err) { logger.error(`[Cron] ${name} failed`, err); }   // never throw — timer stays alive
        finally { ticking = false; }
    };
    if (runOnBoot) run();
    return setInterval(run, everyMs);
}

let timers = [];
export function startCrons() {
    timers = [
        startCron('rates',  20_000, () => ratesService.refresh(), { runOnBoot: true }),
        startCron('expiry', 60_000, () => invoiceService.expireStale()),
    ];
}
export function stopCrons() { for (const t of timers) clearInterval(t); timers = []; }
```

## Graceful shutdown

```js
let shuttingDown = false;
async function shutdown(signal) {
    if (shuttingDown) return; shuttingDown = true;
    logger.info(`[shutdown] ${signal} received`);
    const forceExit = setTimeout(() => { logger.error('[shutdown] timeout 25s — forcing exit'); process.exit(1); }, 25_000);
    forceExit.unref();
    try { await new Promise((r) => server.close(() => r())); } catch (e) { logger.error('[shutdown] server.close:', e.message); }
    try { stopCrons(); }            catch (e) { logger.error(e.message); }
    try { await stopWorkers(); }    catch (e) { logger.error(e.message); }
    try { await closeQueues(); }    catch (e) { logger.error(e.message); }
    try { await sequelize.close(); } catch (e) { logger.error(e.message); }
    clearTimeout(forceExit);
    process.exit(0);
}
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT',  () => shutdown('SIGINT'));
```

Order matters: stop accepting connections → timers → workers → queues → DB. Every step individually try/caught; a 25 s force-exit backstop.

## env.js — fail-fast config

```js
dotenv.config({ path: `.env.${NODE_ENV}.local` });   // priority cascade
dotenv.config({ path: `.env.${NODE_ENV}` });
dotenv.config({ path: '.env' });

function validateConfig() {
    const errors = [];
    if (!process.env.JWT_SECRET || process.env.JWT_SECRET.length < 32) errors.push('JWT_SECRET ≥32 chars required');
    if (!process.env.ENCRYPTION_KEY || process.env.ENCRYPTION_KEY.length < 32) errors.push('ENCRYPTION_KEY ≥32 chars required');
    if (!process.env.DATABASE_USER) errors.push('DATABASE_USER is required');
    for (const name of ['DATABASE_PORT', 'DB_POOL_MAX', 'REDIS_PORT']) {     // optional ints: reject only if SET and invalid
        const raw = process.env[name];
        if (raw !== undefined && raw !== '' && !/^-?\d+$/.test(raw.trim())) errors.push(`${name} must be an integer (got "${raw}")`);
    }
    if (errors.length) throw new Error(`[config] invalid configuration:\n  - ${errors.join('\n  - ')}`);
    console.log('[config] validated');               // grep-able runbook marker
}
validateConfig();                                    // runs at import time
```

Pattern: collect ALL errors then throw once; non-fatal issues get `console.warn`; secrets enforce a minimum length (a short key = weak crypto, fail loudly).

**Ops gotcha worth documenting in every project**: pm2 caches `process.env` from first start and dotenv does not override already-set vars — editing `.env` alone changes nothing. Apply env changes with: `set -a; . ./.env; set +a; pm2 restart app --update-env`.

## Logger

JSON lines in production (for log shippers), pretty pass-through in dev (`LOG_FORMAT` overrides). Recursive redaction of sensitive keys (`/password|passwd|secret|token|private[_-]?key|authorization|cookie|hmac|mnemonic/i` → `[redacted]`, depth-capped), Errors serialized to `{name,message,stack}`, injectable sink for tests, `verbose()` behind `LOG_VERBOSE=true`. See `templates/logger.helper.js`.
