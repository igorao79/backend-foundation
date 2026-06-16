// Rate limiting: Limiter class (express-rate-limit) + makeCounter lockouts.
// Adjust named limiters / env names per project. getClientIP must be your single proxy-aware IP source.
import { rateLimit } from 'express-rate-limit';
import ApiError from './api.error.js';
import { getClientIP } from './network-security.helper.js';   // single proxy-aware IP source

const intEnv = (name, fallback) => parseInt(process.env[name] || String(fallback), 10);

// Bypass only TRUE loopback — not requests that arrived through a proxy.
const skipLocal = (req) => {
    const ip = req.socket?.remoteAddress;
    const proxied = req.headers['x-forwarded-for'] || req.headers['cf-connecting-ip'];
    return !proxied && (ip === '127.0.0.1' || ip === '::1' || ip === '::ffff:127.0.0.1');
};

const limitMsg = (message) => ({ success: false, error: { message, code: 'TOO_MANY_REQUESTS', errors: [] } });

class Limiter {
    _create({ windowMs, max, message, key }) {
        return rateLimit({
            windowMs, max,
            keyGenerator: key,
            skip: skipLocal,
            handler: (req, res) => res.status(429)
                .set('Retry-After', String(Math.ceil(windowMs / 1000)))
                .json(message),
            standardHeaders: true,
            legacyHeaders: false,
            validate: { xForwardedForHeader: false, ip: false },
        });
    }

    api()   { return this._create({ windowMs: 60_000, max: intEnv('API_RATE_LIMIT_PER_MIN', 600), key: (req) => req.headers['x-api-key'] || getClientIP(req), message: limitMsg('API rate limit exceeded') }); }
    admin() { return this._create({ windowMs: 60_000, max: intEnv('ADMIN_RATE_LIMIT_PER_MIN', 3000), key: (req) => String(req.userId || getClientIP(req)), message: limitMsg('Too many requests') }); }
    auth()  { return this._create({ windowMs: 60_000, max: intEnv('AUTH_RATE_LIMIT_PER_MIN', 20), key: getClientIP, message: limitMsg('Too many auth attempts, try again later') }); }
    heavy() { return this._create({ windowMs: 60_000, max: intEnv('HEAVY_ACTION_RATE_LIMIT_PER_MIN', 12), key: (req) => String(req.userId || getClientIP(req)), message: limitMsg('Too many heavy operations') }); }
}

const limiter = new Limiter();
export const apiRateLimit = limiter.api();
export const adminRateLimit = limiter.admin();
export const authRateLimit = limiter.auth();
export const heavyActionRateLimit = limiter.heavy();

/**
 * Stateful lockout counter (login/OTP): check() before attempt, record() on failure, clear() on success.
 * In-memory per replica by design — swap the Map for Redis behind the same interface if you need global lockout.
 */
export function makeCounter({ prefix = '', ttlSec, maxFails, lockedCode, lockedMsg }) {
    const store = new Map(); // key → { fails, expiresAt }
    const sweep = () => {
        const now = Date.now();
        for (const [k, v] of store) if (v.expiresAt <= now) store.delete(k);
    };
    return {
        async check(key) {
            sweep();
            const s = store.get(prefix + key);
            if (s && s.fails >= maxFails) throw ApiError.TooManyRequests(lockedMsg, lockedCode);
        },
        async record(key) {
            sweep();
            const s = store.get(prefix + key) || { fails: 0, expiresAt: Date.now() + ttlSec * 1000 };
            s.fails += 1;
            store.set(prefix + key, s);
        },
        async clear(key) { store.delete(prefix + key); },
        _resetMemStore() { store.clear(); }, // test hook
    };
}
