// HMAC signature middleware for a public machine API.
// Headers: X-Api-Key (tenant id) + X-Signature (HMAC-SHA256 of canonical JSON body).
// GET signs the empty string; mutations also carry _timestamp + Redis-backed replay protection (fail-closed).
import ApiError from './api.error.js';
import { verifySignature } from './crypto.helper.js';
import { DB } from '../db.js';
// import { redis } from '../queues/connection.js';  // any ioredis instance

const SKEW_MS = 60_000;

export function makeSignatureMiddleware({ redis, tenantModel = 'Project' }) {
    return async function signatureMiddleware(req, res, next) {
        try {
            const apiKey = req.headers['x-api-key'];
            const signature = req.headers['x-signature'];
            if (!apiKey) throw ApiError.Unauthorized('Missing API key', 'MISSING_API_KEY');
            if (!signature) throw ApiError.Unauthorized('Missing signature', 'MISSING_SIGNATURE');

            // Lookup + status filter in ONE query; disabled/blocked tenants get the same generic error.
            const tenant = await DB[tenantModel].findOne({ where: { api_key: apiKey, status: 'active' } });
            if (!tenant) throw ApiError.Unauthorized('Invalid API key or tenant disabled', 'INVALID_API_KEY');

            const payload = req.method === 'GET' ? '' : req.body;
            if (!verifySignature(tenant.secret_key, payload, signature)) {
                throw ApiError.Unauthorized('Invalid signature', 'INVALID_SIGNATURE');
            }

            if (req.method === 'GET') { req.tenant = tenant; return next(); }

            // Replay protection for mutations: timestamp skew + one-time signature marker.
            const ts = payload?._timestamp;
            if (ts === undefined || ts === null) throw ApiError.Unauthorized('Missing _timestamp', 'MISSING_TIMESTAMP');
            const tsNum = parseInt(ts, 10);
            if (!Number.isFinite(tsNum)) throw ApiError.Unauthorized('Invalid _timestamp', 'INVALID_TIMESTAMP');
            if (Math.abs(Date.now() - tsNum) > SKEW_MS) throw ApiError.Unauthorized('Timestamp out of range', 'TIMESTAMP_SKEW');

            let ok;
            try {
                ok = await redis.set(`sig:seen:${signature}`, '1', 'PX', SKEW_MS * 2, 'NX');
            } catch {
                // Fail CLOSED: if the replay store is down we refuse, not allow.
                throw ApiError.ServiceUnavailable('Replay store unavailable', 'REPLAY_STORE_UNAVAILABLE');
            }
            if (ok !== 'OK') throw ApiError.Unauthorized('Signature already used (replay rejected)', 'SIGNATURE_REPLAY');

            req.tenant = tenant;
            next();
        } catch (err) { next(err); }
    };
}
