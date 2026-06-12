# Public HMAC API: signing, signature middleware, replay protection, sandbox

Templates: `templates/crypto.helper.js`, `templates/signature.middleware.js`.

## Transport contract

- `X-Api-Key: <api_key>` — public tenant identifier (32 hex, `crypto.randomBytes(16)`).
- `X-Signature: <hex>` — HMAC-SHA256 of the canonical JSON body, keyed by the tenant's `secret_key` (64 hex, `crypto.randomBytes(32)`).
- GET requests sign the empty string `''`; mutations sign `req.body`.
- Mutations carry `_timestamp` (ms epoch) inside the body for replay protection.

## Canonical JSON + signing

```js
function sortObject(obj) {                       // recursive key sort = canonical form
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(sortObject);
    return Object.keys(obj).sort().reduce((acc, k) => ({ ...acc, [k]: sortObject(obj[k]) }), {});
}
export const signPayload = (secretKey, payload) => crypto
    .createHmac('sha256', Buffer.from(secretKey, 'utf8'))
    .update(JSON.stringify(sortObject(payload)), 'utf8')
    .digest('hex');

export function verifySignature(secretKey, payload, signature) {
    if (!signature || !secretKey) return false;
    try {
        return crypto.timingSafeEqual(
            Buffer.from(signPayload(secretKey, payload), 'hex'),
            Buffer.from(signature, 'hex'));
    } catch { return false; }
}
```

Any external client MUST mirror `sortObject` exactly. Document this in the OpenAPI spec.

## Signature middleware — full check order

1. Missing headers → 401 `MISSING_API_KEY` / `MISSING_SIGNATURE`.
2. Tenant lookup AND status filter in one query: `findOne({ where: { api_key, status: 'active' } })` → 401 `INVALID_API_KEY` (disabled/blocked tenants get the same generic error — no state leak).
3. `verifySignature(tenant.secret_key, req.method === 'GET' ? '' : req.body, sig)` → 401 `INVALID_SIGNATURE`.
4. GET → done (`req.tenant = tenant; next()`); no replay check needed for reads.
5. Mutations: `_timestamp` present/numeric (`MISSING_TIMESTAMP`/`INVALID_TIMESTAMP`), skew `|now - ts| ≤ 60s` (`TIMESTAMP_SKEW`).
6. Replay: Redis `SET sig:seen:<signature> 1 PX 120000 NX` — not-OK → 401 `SIGNATURE_REPLAY`. Redis down → **fail closed**, 503 `REPLAY_STORE_UNAVAILABLE`. TTL = 2× allowed skew.
7. `req.tenant = tenant; next()`.

## Idempotency by client order_id

Checked BEFORE throttles (a replay must succeed even when limits are hit):

```js
if (order_id) {
    const existing = await DB.Deposit.findOne({ where: { tenant_id, order_id } });
    if (existing) {
        if (paramsDiffer(existing, input)) logger.warn(`idempotent replay with differing fields`);
        return serialize(existing);          // return the original, never error
    }
}
```

Race between two concurrent first-requests: unique index on `(tenant_id, order_id)`; catch `SequelizeUniqueConstraintError` in the create path, re-fetch the winner, return it, and release any resources the loser had grabbed.

## Per-tenant throttles (DB-configured)

Two independent gates inside the create transaction, serialized by a Postgres advisory lock:

```js
await sequelize.query('SELECT pg_advisory_xact_lock(hashtextextended(:tid, 2))',
    { replacements: { tid: String(tenant.id) }, transaction: txn });

// gate 1: concurrent cap — open rows
const pending = await DB.Invoice.count({ where: { tenant_id, status: 'pending', expiredAt: { [Op.gt]: new Date() } }, transaction: txn });
if (pending >= maxPending) throw ApiError.TooManyRequests(`Too many open invoices (${pending}/${maxPending})`, 'INVOICE_LIMIT_PENDING');

// gate 2: sliding window — creations in last N minutes
const recent = await DB.Invoice.count({ where: { tenant_id, createdAt: { [Op.gte]: since } }, transaction: txn });
if (recent >= rateCount) throw ApiError.TooManyRequests(`Rate limit: ${recent}/${rateCount}`, 'INVOICE_LIMIT_RATE');
```

Limits live as nullable columns on the tenant row (`NULL` disables a gate) — per-tenant tuning without deploys.

## Sandbox/test router

Mounted **before** the prod router so its prefix wins, and only off-prod:

```js
if (process.env.NODE_ENV !== 'production' || process.env.ENABLE_TEST_ROUTER === 'true') {
    app.use('/api/v1/test', testRouter);
}
app.use('/api/v1', apiRateLimit, signatureMiddleware, apiRouter);
```

Inside, a guard requires keys prefixed `test_`; endpoints return deterministic mocks without DB writes and skip HMAC (so merchants can integrate before their signing code works). A webhook-trigger endpoint may look up the REAL tenant (key minus the `test_` prefix) and POST to its callback URL with a sentinel signature `TEST_SIGNATURE_DO_NOT_VERIFY`.

## Encryption at rest (AES-256-GCM)

For secrets stored in DB (keys, credentials): `encrypt`/`decrypt` with format `iv:tag:ciphertext` (hex), scrypt KDF (`N=2^17, r=8, p=1`) from `ENCRYPTION_KEY` (≥32 chars) with an app-specific salt, in-memory derived-key cache. `decrypt` validates the 3-part format BEFORE `Buffer.from` (no crash on corrupted DB fields); GCM auth tag catches tampering.

Boot-time key check: store `keyFingerprint()` (HMAC of derived key over a fixed label) in a SystemConfig row; on mismatch refuse to start unless `ALLOW_ENCRYPTION_KEY_CHANGE=true` — prevents silently bricking every encrypted row after an env mistake.
