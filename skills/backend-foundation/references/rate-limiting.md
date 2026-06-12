# Rate limiting: Limiter class, lockout counters, layered throttles

Template: `templates/api.limiter.js`.

Three layers, different jobs:
1. **express-rate-limit named limiters** — cheap per-route flood control (this file).
2. **makeCounter lockouts** — stateful "5 fails → locked 15 min" for login/OTP (this file).
3. **Per-tenant DB throttles** — business limits inside transactions (see `hmac-gateway.md`).

## Limiter class

One class, `_create()` core, named instances per surface:

```js
class Limiter {
    _create({ windowMs, max, message, key }) {
        return rateLimit({
            windowMs, max,
            keyGenerator: key,
            skip: skipLocal,                       // bypass only TRUE loopback (no XFF/CF headers present)
            handler: (req, res) => res.status(429)
                .set('Retry-After', String(Math.ceil(windowMs / 1000)))
                .json(message),                    // same envelope as errorMiddleware
            standardHeaders: true, legacyHeaders: false,
            validate: { xForwardedForHeader: false, ip: false },   // we do our own IP detection
        });
    }
    api()   { return this._create({ windowMs: 60_000, max: intEnv('API_RATE_LIMIT_PER_MIN', 600),  key: (req) => req.headers['x-api-key'] || getClientIP(req), message: limitMsg('API rate limit exceeded') }); }
    admin() { return this._create({ windowMs: 60_000, max: intEnv('ADMIN_RATE_LIMIT_PER_MIN', 3000), key: (req) => req.userId || getClientIP(req), message: limitMsg('Too many requests') }); }
    auth()  { return this._create({ windowMs: 60_000, max: intEnv('AUTH_RATE_LIMIT_PER_MIN', 20),   key: getClientIP, message: limitMsg('Too many auth attempts') }); }
    heavy() { return this._create({ windowMs: 60_000, max: intEnv('HEAVY_ACTION_RATE_LIMIT_PER_MIN', 12), key: (req) => req.userId || getClientIP(req), message: limitMsg('Heavy action limit') }); }
}
```

Sizing intuition: public API by API key (~10 rps); panel by user id, generous (a dashboard page load can fire ~12 calls); auth by IP, tight; "heavy" for endpoints that fan out to expensive RPC/external calls.

Key choices:
- **Key by tenant identity where it exists** (API key, user id), IP only as fallback / for unauthenticated routes.
- `getClientIP(req)` is one shared function honoring `trust proxy` config (`TRUSTED_PROXY_HOPS` or CIDR allowlist) — never read `X-Forwarded-For` ad hoc.
- The 429 body uses the SAME error envelope as everything else: `{ success:false, error:{ message, code:'TOO_MANY_REQUESTS', errors:[] } }`, plus `Retry-After` seconds.
- All windows/maxima overridable via env so prod can be tuned without deploys.

Applied at the mount (`app.use('/admin', adminRateLimit, ...)`) or per hot route (`router.post('/login', authRateLimit, ...)`).

## makeCounter — lockout counters

```js
export function makeCounter({ prefix = '', ttlSec, maxFails, lockedCode, lockedMsg }) {
    const store = new Map();                       // key → { fails, expiresAt }
    const sweep = () => { /* drop expired */ };
    return {
        async check(key)  { sweep(); const s = store.get(prefix + key);
                            if (s && s.fails >= maxFails) throw ApiError.TooManyRequests(lockedMsg, lockedCode); },
        async record(key) { sweep(); const s = store.get(prefix + key) || { fails: 0, expiresAt: Date.now() + ttlSec * 1000 };
                            s.fails += 1; store.set(prefix + key, s); },
        async clear(key)  { store.delete(prefix + key); },
    };
}
const otpCounter   = makeCounter({ prefix: 'otp:fail:',   ttlSec: 900, maxFails: 5, lockedCode: 'OTP_LOCKED',   lockedMsg: '2FA locked, try later' });
const loginCounter = makeCounter({ prefix: 'login:fail:', ttlSec: 900, maxFails: 5, lockedCode: 'LOGIN_LOCKED', lockedMsg: 'Too many login attempts' });
```

Usage shape: `check(key)` before the attempt; `record(key)` on failure; `clear(key)` on success. Count by email AND by IP separately for login.

Deliberately in-memory: login/OTP frequency is tiny, per-replica lockout is acceptable, and it removes a Redis dependency from the auth path. If you scale to many replicas and need a global lockout, swap the Map for Redis behind the same interface.
