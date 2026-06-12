// Env loading + fail-fast validation. MUST be the first import in server.js.
// Pattern: collect ALL errors, throw once; warn (don't fail) on suspicious-but-legal config.
import dotenv from 'dotenv';
import path from 'node:path';

const NODE_ENV = process.env.NODE_ENV || 'development';
const root = process.cwd();

// Priority cascade: most specific wins (dotenv does NOT override already-set vars).
dotenv.config({ path: path.join(root, `.env.${NODE_ENV}.local`) });
dotenv.config({ path: path.join(root, `.env.${NODE_ENV}`) });
dotenv.config({ path: path.join(root, '.env') });

function validateConfig() {
    const errors = [];

    // Secrets — a short key is weak crypto; fail loudly.
    for (const name of ['JWT_SECRET', 'ENCRYPTION_KEY']) {
        const v = process.env[name];
        if (!v || v.length < 32) errors.push(`${name} is required and must be at least 32 characters`);
    }

    // Required strings.
    for (const name of ['DATABASE_USER', 'DATABASE_TABLE']) {
        if (!process.env[name]) errors.push(`${name} is required`);
    }

    // Optional integers — reject only if SET and invalid (catches typos turning into NaN).
    for (const name of ['DATABASE_PORT', 'DB_POOL_MAX', 'REDIS_PORT', 'TRUSTED_PROXY_HOPS']) {
        const raw = process.env[name];
        if (raw === undefined || raw === '') continue;
        if (!/^-?\d+$/.test(raw.trim()) || !Number.isInteger(Number(raw))) {
            errors.push(`${name} must be a valid integer (got "${raw}")`);
        }
    }

    if (errors.length) throw new Error(`[config] invalid configuration:\n  - ${errors.join('\n  - ')}`);

    if (!process.env.DATABASE_PASS) console.warn('[config] DATABASE_PASS is empty — connecting without a DB password');
    console.log('[config] validated'); // grep-able runbook marker
}

validateConfig();
