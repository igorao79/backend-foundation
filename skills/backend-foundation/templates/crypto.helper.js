// AES-256-GCM field encryption + HMAC-SHA256 request signing + key generators.
// Set APP_KDF_SALT (or edit the constant) per project — do not share salts across apps.
import crypto from 'node:crypto';

const ALGORITHM = 'aes-256-gcm';
const IV_LENGTH = 16;
const TAG_LENGTH = 16;
const SCRYPT_OPTS = { N: 1 << 17, r: 8, p: 1, maxmem: 256 * 1024 * 1024 };
const KDF_SALT = process.env.APP_KDF_SALT || 'change-me-per-app-salt';

let _cachedSecret = null;
let _cachedKey = null;

function getKey() {
    const secret = process.env.ENCRYPTION_KEY;
    if (!secret || secret.length < 32) throw new Error('ENCRYPTION_KEY must be at least 32 characters');
    if (_cachedSecret === secret && _cachedKey) return _cachedKey;
    _cachedKey = crypto.scryptSync(secret, KDF_SALT, 32, SCRYPT_OPTS);
    _cachedSecret = secret;
    return _cachedKey;
}

/** Deterministic fingerprint of the derived key — store in DB at first boot, compare on every boot. */
export function keyFingerprint() {
    return crypto.createHmac('sha256', getKey()).update('encryption-key-fingerprint-v1').digest('hex');
}

/** Returns "iv:tag:ciphertext" (hex). */
export function encrypt(text) {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, getKey(), iv);
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return iv.toString('hex') + ':' + cipher.getAuthTag().toString('hex') + ':' + encrypted;
}

export function decrypt(ciphertext) {
    if (typeof ciphertext !== 'string') throw new Error('decrypt: ciphertext must be a string');
    const parts = ciphertext.split(':');
    if (parts.length !== 3 || !parts[0] || !parts[1] || !parts[2]) {
        throw new Error('decrypt: malformed ciphertext (expected iv:tag:ciphertext)');
    }
    const iv = Buffer.from(parts[0], 'hex');
    const tag = Buffer.from(parts[1], 'hex');
    if (iv.length !== IV_LENGTH || tag.length !== TAG_LENGTH) throw new Error('decrypt: invalid iv/tag length');
    const decipher = crypto.createDecipheriv(ALGORITHM, getKey(), iv);
    decipher.setAuthTag(tag);
    let decrypted = decipher.update(parts[2], 'hex', 'utf8');
    return decrypted + decipher.final('utf8');
}

// ---- HMAC request signing (canonical JSON: recursive key sort) ----

function sortObject(obj) {
    if (typeof obj !== 'object' || obj === null) return obj;
    if (Array.isArray(obj)) return obj.map(sortObject);
    return Object.keys(obj).sort().reduce((acc, key) => ({ ...acc, [key]: sortObject(obj[key]) }), {});
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
            Buffer.from(signature, 'hex'),
        );
    } catch {
        return false;
    }
}

export const generateApiKey = () => crypto.randomBytes(16).toString('hex');    // 32 hex chars
export const generateSecretKey = () => crypto.randomBytes(32).toString('hex'); // 64 hex chars

/** Test hook. */
export function _resetKeyCache() { _cachedSecret = null; _cachedKey = null; }
