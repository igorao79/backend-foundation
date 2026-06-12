// JWT auth + panel middleware chains + TOTP verification.
// Adapt the DB adapter section (loadUser, UserToken model) to your models.
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import speakeasy from 'speakeasy';
import ApiError from './api.error.js';
import { makeCounter } from './api.limiter.js';

const JWT_SECRET = process.env.JWT_SECRET;
const JWT_TTL = process.env.JWT_TTL || '8h';
const JWT_ISSUER = process.env.JWT_ISSUER || 'app';
const JWT_AUDIENCE = process.env.JWT_AUDIENCE || 'app-panel';
if (!JWT_SECRET || JWT_SECRET.length < 32) throw new Error('JWT_SECRET must be at least 32 characters');

function ttlToMs(ttl) {
    const m = String(ttl).match(/^(\d+)([smhd])$/);
    if (!m) return 8 * 3600 * 1000;
    return Number(m[1]) * { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000 }[m[2]];
}

// ---- DB adapter: wire these to your models ----
import { DB } from '../db.js';
const loadUser = (req) => DB.User.findByPk(req.userId);
// UserToken: { user_id, jti, type, scope JSONB, expires_at, revoked_at, last_used_at, meta JSONB }

// ---- token lifecycle ----
export function signToken(userId, { jti, ttl = JWT_TTL, scope = [] } = {}) {
    return jwt.sign({ userId, jti, scope }, JWT_SECRET, {
        algorithm: 'HS256', expiresIn: ttl, issuer: JWT_ISSUER, audience: JWT_AUDIENCE,
    });
}

export function verifyToken(token) {
    try {
        return jwt.verify(token, JWT_SECRET, { algorithms: ['HS256'], issuer: JWT_ISSUER, audience: JWT_AUDIENCE });
    } catch {
        throw ApiError.Unauthorized('Unauthorized');
    }
}

export function extractToken(authHeader, cookieToken = null) {
    const m = typeof authHeader === 'string' ? authHeader.match(/^Bearer (.+)$/) : null;
    return (m && m[1]) || cookieToken || null;
}

export async function issueToken(userId, opts = {}) {
    const jti = crypto.randomUUID();
    const ttl = opts.ttl || JWT_TTL;
    const token = signToken(userId, { jti, ttl, scope: opts.scope ?? [] });
    const record = await DB.UserToken.create({
        user_id: userId, jti, type: opts.type || 'panel', scope: opts.scope ?? [],
        expires_at: new Date(Date.now() + ttlToMs(ttl)), meta: opts.meta || {},
    });
    return { token, record };
}

export const revokeToken = (jti, revokedBy = null) =>
    DB.UserToken.update({ revoked_at: new Date(), revoked_by: revokedBy }, { where: { jti } });

export async function isTokenRevoked(jti) {
    const row = await DB.UserToken.findOne({ where: { jti }, attributes: ['revoked_at'] });
    return !!row?.revoked_at; // token without a DB row counts as not revoked (legacy-compatible)
}

export const touchToken = (jti) =>
    DB.UserToken.update({ last_used_at: new Date() }, { where: { jti } });

// ---- middleware ----
export async function authenticate(req, res, next) {
    try {
        const token = extractToken(req.headers.authorization, req.cookies?.token);
        if (!token) throw ApiError.Unauthorized('Unauthorized');
        const payload = verifyToken(token);
        if (payload.jti && await isTokenRevoked(payload.jti)) throw ApiError.Unauthorized('Unauthorized');
        req.userId = payload.userId || null;
        req.tokenJti = payload.jti || null;
        if (payload.jti) touchToken(payload.jti).catch(() => {});
        next();
    } catch (err) { next(err); }
}

export const enforceAccountStatus = (panel) => async (req, res, next) => {
    try {
        const user = await loadUser(req);
        if (!user || user.blocked) throw ApiError.Unauthorized('Unauthorized');
        if (panel === 'admin' && user.admin_access_revoked) throw ApiError.Unauthorized('Unauthorized');
        next();
    } catch (err) { next(err); }
};

export const requireRole = (panel) => async (req, res, next) => {
    try {
        const user = await loadUser(req);
        const ok = panel === 'admin' ? user?.is_admin : panel === 'merchant' ? user?.is_merchant : false;
        if (!ok) throw ApiError.Forbidden('Access denied');
        if (panel === 'admin') req.isAdmin = true;
        next();
    } catch (err) { next(err); }
};

/** Build a panel protection chain. Mount once: app.use('/admin', rateLimit, ...adminMiddleware, adminRouter) */
export function buildPanelMiddleware(panel, ...extra) {
    return [authenticate, enforceAccountStatus(panel), ...extra, requireRole(panel)];
}

// ---- TOTP / 2FA ----
const otpCounter = makeCounter({ prefix: 'otp:fail:', ttlSec: 900, maxFails: 5, lockedCode: 'OTP_LOCKED', lockedMsg: '2FA temporarily locked, try again later' });

export async function verifyOtpOrThrow(user, token) {
    if (!user || !user.id || !user.otp_secret) throw ApiError.Unauthorized('TOTP not initialised', 'OTP_REQUIRED_SETUP');
    await otpCounter.check(user.id);
    const ok = speakeasy.totp.verify({ secret: user.otp_secret, encoding: 'base32', token: String(token), window: 1 });
    if (!ok) {
        await otpCounter.record(user.id);
        throw ApiError.Forbidden('Invalid 2FA code', 'OTP_INVALID');
    }
    await otpCounter.clear(user.id);
    return true;
}

/** Route-level 2FA gate: requires otp_token in body / x-otp-token header / query. */
export const requireOtp = (actionLabel = 'this action') => async (req, res, next) => {
    try {
        const user = await loadUser(req);
        if (!user?.otp_enabled) throw ApiError.Forbidden('OTP_REQUIRED_SETUP', 'OTP_REQUIRED_SETUP');
        const token = req.body?.otp_token || req.headers['x-otp-token'] || req.query?.otp_token;
        if (!token) throw ApiError.BadRequest(`2FA code required for ${actionLabel}`, [], 'OTP_REQUIRED');
        await verifyOtpOrThrow(user, token);
        if (req.body && 'otp_token' in req.body) delete req.body.otp_token;
        next();
    } catch (err) { next(err); }
};

/** Admins without 2FA may only GET or hit /2fa/setup|verify. */
export async function enforce2faSetup(req, res, next) {
    try {
        const user = await loadUser(req);
        if (!user || !user.is_admin || user.otp_enabled) return next();
        if (req.method === 'GET') return next();
        const p = req.path || '';
        if (p.endsWith('/2fa/setup') || p.endsWith('/2fa/verify')) return next();
        throw ApiError.Forbidden('Enable 2FA before performing this action', 'OTP_REQUIRED_SETUP');
    } catch (err) { next(err); }
}
