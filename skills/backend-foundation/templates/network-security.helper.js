// Network security: proxy-aware client IP + SSRF guard for outbound URLs.
// This is the SINGLE source of truth for "what IP is the client" and "is this URL safe to call".
// Wire api.limiter.js's getClientIP to this file; call resolveAndAssertPublic() before every
// outbound webhook/callback fetch, and safeOutboundUrl() when validating user-supplied URLs.
import { promises as dns } from 'node:dns';
import ApiError from './api.error.js';

const TRUSTED_PROXY_HOPS = Math.max(1, parseInt(process.env.TRUSTED_PROXY_HOPS || '1', 10) || 1);
const CLIENT_IP_HEADER = (process.env.CLIENT_IP_HEADER || '').trim().toLowerCase();   // e.g. 'cf-connecting-ip'
const TRUSTED_PROXY_CIDRS = parseCidrs(process.env.TRUSTED_PROXY_CIDRS || '');
const ALLOW_PRIVATE_OUTBOUND = () => String(process.env.ALLOW_PRIVATE_OUTBOUND).toLowerCase() === 'true'; // dev/test escape hatch
const ALLOW_HTTP_OUTBOUND = () => String(process.env.ALLOW_HTTP_OUTBOUND).toLowerCase() === 'true';

const BLOCKED_FAMILIES = {
    loopback:  'host resolves to loopback',
    private:   'host resolves to a private network (RFC1918 / unique-local)',
    linkLocal: 'host resolves to link-local',
    metadata:  'host resolves to a cloud metadata endpoint',
    multicast: 'host resolves to a multicast address',
    reserved:  'host is reserved / non-routable',
};
const FORBIDDEN_SCHEMES = new Set(['javascript:', 'data:', 'vbscript:', 'file:', 'blob:', 'about:', 'ftp:', 'gopher:']);

// ── CIDR / IP parsing ───────────────────────────────────────────────────────
function parseCidrs(raw) {
    const out = [];
    for (const s of String(raw).split(',').map(x => x.trim()).filter(Boolean)) {
        const [addr, bitsRaw] = s.split('/');
        const bits = parseInt(bitsRaw, 10);
        if (!addr || !Number.isFinite(bits)) continue;
        if (addr.includes(':')) {
            const v6 = parseIPv6(addr);
            if (v6 == null || bits < 0 || bits > 128) continue;
            const mask = bits === 0 ? 0n : ((1n << BigInt(bits)) - 1n) << BigInt(128 - bits);
            out.push({ kind: 6, base: v6 & mask, mask });
        } else {
            const v4 = parseIPv4(addr);
            if (v4 == null || bits < 0 || bits > 32) continue;
            const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
            out.push({ kind: 4, base: (v4 & mask) >>> 0, mask });
        }
    }
    return out;
}
function parseIPv4(ip) {
    const parts = ip.split('.');
    if (parts.length !== 4) return null;
    let n = 0;
    for (const p of parts) {
        const o = Number(p);
        if (!Number.isInteger(o) || o < 0 || o > 255) return null;
        n = (n * 256 + o) >>> 0;
    }
    return n;
}
function parseIPv6(ip) {
    const groups = ip.split(':');
    if (groups.length !== 8) return null;          // expand :: before calling if you need compressed form
    let n = 0n;
    for (const g of groups) {
        if (!/^[0-9a-fA-F]{1,4}$/.test(g)) return null;
        n = (n << 16n) | BigInt(parseInt(g, 16));
    }
    return n;
}
function ipInCidrs(ip, cidrs) {
    if (!ip || cidrs.length === 0) return false;
    if (ip.includes(':')) {
        const n = parseIPv6(ip);
        return n != null && cidrs.some((c) => c.kind === 6 && (n & c.mask) === c.base);
    }
    const n = parseIPv4(ip);
    return n != null && cidrs.some((c) => c.kind === 4 && ((n & c.mask) >>> 0) === c.base);
}

// ── address family classification (null = public/routable) ───────────────────
function ipv4Family(addr) {
    const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(addr);
    if (!m) return null;
    const [, a, b, c, d] = m.map(Number);
    if ([a, b, c, d].some((n) => n < 0 || n > 255)) return null;
    if (a === 169 && b === 254 && c === 169 && d === 254) return 'metadata'; // 169.254.169.254 cloud metadata
    if (a === 127) return 'loopback';
    if (a === 10) return 'private';
    if (a === 172 && b >= 16 && b <= 31) return 'private';
    if (a === 192 && b === 168) return 'private';
    if (a === 169 && b === 254) return 'linkLocal';
    if (a === 0) return 'reserved';
    if (a >= 224 && a <= 239) return 'multicast';
    if (a >= 240) return 'reserved';
    return null;
}
function ipv6Family(addr) {
    const lower = addr.toLowerCase();
    if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return 'loopback';
    if (lower.startsWith('::ffff:')) {                          // IPv4-mapped
        const tail = lower.slice(7);
        const fromDotted = ipv4Family(tail);
        if (fromDotted) return fromDotted;
        const groups = tail.split(':');
        if (groups.length === 2) {
            const high = parseInt(groups[0] || '0', 16);
            const low = parseInt(groups[1] || '0', 16);
            if (Number.isFinite(high) && Number.isFinite(low))
                return ipv4Family(`${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`);
        }
        return null;
    }
    if (lower.startsWith('fc') || lower.startsWith('fd')) return 'private';   // unique-local
    if (lower.startsWith('fe80:')) return 'linkLocal';
    if (lower.startsWith('ff')) return 'multicast';
    if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return 'reserved';
    return null;
}
const stripIpv6Brackets = (host) => host?.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
const literalFamily = (host) => { const bare = stripIpv6Brackets(host); return ipv4Family(bare) || ipv6Family(bare); };

// ── client IP (proxy aware) ──────────────────────────────────────────────────
export function normalizeIP(ip) {
    if (!ip) return null;
    ip = String(ip).trim();
    if (ip.startsWith('::ffff:')) return ip.slice(7);
    if (ip === '::1') return '127.0.0.1';
    return ip || null;
}

/** The one true client-IP source. Honors CLIENT_IP_HEADER → trusted CIDRs → fixed hop count → socket. */
export function getClientIP(req) {
    if (!req) return null;
    if (CLIENT_IP_HEADER) {
        const v = req.headers?.[CLIENT_IP_HEADER];
        const ip = normalizeIP(Array.isArray(v) ? v[0] : v);
        if (ip) return ip;
    }
    const raw = req.headers?.['x-forwarded-for'];
    if (raw) {
        const chain = String(raw).split(',').map(normalizeIP).filter(Boolean);
        if (TRUSTED_PROXY_CIDRS.length > 0) {                  // walk right→left, first untrusted hop is the client
            for (let i = chain.length - 1; i >= 0; i--) if (!ipInCidrs(chain[i], TRUSTED_PROXY_CIDRS)) return chain[i];
        } else {
            const idx = chain.length - TRUSTED_PROXY_HOPS;
            if (idx >= 0 && chain[idx]) return chain[idx];
        }
    }
    return normalizeIP(req.ip || req.socket?.remoteAddress || req.connection?.remoteAddress || null);
}

// ── outbound SSRF guard ──────────────────────────────────────────────────────
/** Cheap sync check on the literal host (no DNS). Use for fast validation; resolveAndAssertPublic is authoritative. */
export function isSafeOutboundUrl(rawUrl) {
    if (!rawUrl || typeof rawUrl !== 'string') return false;
    let parsed;
    try { parsed = new URL(rawUrl); } catch { return false; }
    if (parsed.protocol !== 'https:' && !(ALLOW_HTTP_OUTBOUND() && parsed.protocol === 'http:')) return false;
    if (!parsed.hostname) return false;
    const fam = literalFamily(parsed.hostname);
    return !(fam && !ALLOW_PRIVATE_OUTBOUND());
}

/**
 * Authoritative SSRF guard: resolve the host via DNS and assert EVERY answer is public.
 * Call this immediately before each outbound fetch (re-resolves to defeat DNS-rebinding).
 * Throws ApiError on any rejection. Returns { ip } of the first resolved address.
 */
export async function resolveAndAssertPublic(rawUrl) {
    let parsed;
    try { parsed = new URL(rawUrl); }
    catch { throw ApiError.BadRequest(`Outbound URL is malformed: ${rawUrl}`, [], 'INVALID_URL'); }
    if (parsed.protocol !== 'https:' && !(ALLOW_HTTP_OUTBOUND() && parsed.protocol === 'http:'))
        throw ApiError.BadRequest(`Outbound URL must use https (got ${parsed.protocol}//)`, [], 'INVALID_URL_SCHEME');
    if (parsed.username || parsed.password)
        throw ApiError.BadRequest('Outbound URL must not embed credentials (user:pass@host)', [], 'INVALID_URL_USERINFO');

    const host = parsed.hostname;
    const literal = literalFamily(host);
    if (literal && !ALLOW_PRIVATE_OUTBOUND())
        throw ApiError.Forbidden(`Outbound URL refused: ${BLOCKED_FAMILIES[literal] || literal}`, 'OUTBOUND_BLOCKED');

    let records = [];
    try { records = await dns.lookup(host, { all: true, verbatim: true }); }
    catch (err) { throw ApiError.BadRequest(`Outbound URL host did not resolve: ${err.message}`, [], 'DNS_FAIL'); }
    if (!records.length) throw ApiError.BadRequest('Outbound URL host has no addresses', [], 'DNS_FAIL');
    for (const r of records) {
        const fam = literalFamily(r.address);
        if (fam && !ALLOW_PRIVATE_OUTBOUND())
            throw ApiError.Forbidden(`Outbound URL refused: ${host} -> ${r.address} (${BLOCKED_FAMILIES[fam] || fam})`, 'OUTBOUND_BLOCKED');
    }
    return { ip: records[0].address };
}

/**
 * Validate a user/tenant-supplied URL (webhook, callback, redirect target) at WRITE time.
 * Rejects dangerous schemes, embedded credentials, and non-public hosts. Returns the normalized URL.
 * Pass { allowedHost } to additionally pin the URL to a verified domain (and its subdomains).
 */
export function safeOutboundUrl(rawUrl, { fieldName = 'URL', allowedHost = null } = {}) {
    if (rawUrl == null || rawUrl === '') return null;
    if (typeof rawUrl !== 'string') throw ApiError.BadRequest(`${fieldName} must be a string`, [], 'INVALID_URL');
    const trimmed = rawUrl.trim();
    if (!trimmed) return null;

    const lower = trimmed.toLowerCase();
    for (const s of FORBIDDEN_SCHEMES)
        if (lower.startsWith(s)) throw ApiError.BadRequest(`${fieldName} uses a forbidden scheme (${s.slice(0, -1)})`, [], 'INVALID_URL_SCHEME');
    if (!/^[a-z][a-z0-9+.-]*:/i.test(trimmed))
        throw ApiError.BadRequest(`${fieldName} must be an absolute URL with a scheme`, [], 'INVALID_URL_SCHEME');

    let parsed;
    try { parsed = new URL(trimmed); }
    catch { throw ApiError.BadRequest(`${fieldName} is not a valid URL`, [], 'INVALID_URL'); }
    if (parsed.protocol !== 'https:' && !(ALLOW_HTTP_OUTBOUND() && parsed.protocol === 'http:'))
        throw ApiError.BadRequest(`${fieldName} must use https`, [], 'INVALID_URL_SCHEME');
    if (!parsed.hostname) throw ApiError.BadRequest(`${fieldName} is missing a host`, [], 'INVALID_URL');
    if (parsed.username || parsed.password)
        throw ApiError.BadRequest(`${fieldName} must not contain embedded credentials (user:pass@host)`, [], 'INVALID_URL_USERINFO');
    if (allowedHost) {
        const [h, r] = [parsed.hostname, allowedHost].map((x) => x.toLowerCase().replace(/\.$/, ''));
        if (h !== r && !h.endsWith('.' + r))
            throw ApiError.BadRequest(`${fieldName} host "${parsed.hostname}" does not match "${allowedHost}"`, [], 'URL_DOMAIN_MISMATCH');
    }
    if (!isSafeOutboundUrl(parsed.toString()))
        throw ApiError.BadRequest(`${fieldName} must point at a public https endpoint (not loopback / private / link-local)`, [], 'OUTBOUND_BLOCKED');
    return parsed.toString();
}
