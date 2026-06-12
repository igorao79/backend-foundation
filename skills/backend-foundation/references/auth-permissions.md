# Auth: JWT, middleware chains, granular permissions, TOTP/2FA, presets

Templates: `templates/auth.middleware.js`, `templates/permissions.helper.js`, `templates/crypto.helper.js`.

## JWT lifecycle

- **HS256 pinned** both in `jwt.sign` and `verify({ algorithms: ['HS256'] })` — blocks `alg=none` / RS→HS confusion.
- Secret ≥32 chars validated at module load (boot fails fast).
- `issuer`/`audience` set (defense-in-depth if the secret gets reused elsewhere).
- Every token gets a `jti = crypto.randomUUID()` and a DB row (`UserToken: user_id, jti, type, scope, expires_at, revoked_at, meta`) → enables audit, per-session revocation, `last_used_at` touch.

```js
export function extractToken(authHeader, cookieToken = null) {
    const m = typeof authHeader === 'string' ? authHeader.match(/^Bearer (.+)$/) : null;
    return (m && m[1]) || cookieToken || null;   // Bearer first, cookie fallback
}

export async function authenticate(req, res, next) {
    const token = extractToken(req.headers.authorization, req.cookies?.token);
    if (!token) throw ApiError.Unauthorized('Unauthorized');
    const payload = verifyToken(token);
    if (payload.jti && await isTokenRevoked(payload.jti)) throw ApiError.Unauthorized('Unauthorized');
    req.userId = payload.userId || null;
    req.tokenJti = payload.jti || null;
    if (payload.jti) touchToken(payload.jti).catch(() => {});   // fire-and-forget last_used_at
    next();
}
```

Logout = `revokeToken(req.tokenJti)` (soft-delete `revoked_at`). Tokens without a DB row count as not revoked (legacy-compatible).

## Middleware chain factory

```js
export function buildPanelMiddleware(panel, ...extra) {
    return [authenticate, enforceAccountStatus(panel), ...extra, requireRole(panel)];
}
export const adminMiddleware    = buildPanelMiddleware('admin', auditMutations, enforce2faSetup);
export const merchantMiddleware = buildPanelMiddleware('merchant');
```

Mounted once: `app.use('/admin', adminRateLimit, ...adminMiddleware-as-array-or-spread, adminRouter)`. Useful extras:
- `auditMutations` — on POST/PUT/PATCH/DELETE attach `res.on('finish', ...)` writing an audit row (`action = "<METHOD> <req.baseUrl><req.route?.path>"` with UUIDs normalized to `:id`; route is matched by finish-time).
- `enforce2faSetup` — admins without `otp_enabled` may only GET or hit `/2fa/setup|verify`; all other mutations → 403 `OTP_REQUIRED_SETUP`.
- IP allowlist gate (VPN) if needed.

Role model: independent boolean flags on the user (`is_admin`, `is_merchant`, `is_superadmin`) — one account can hold several and pass multiple panels.

## Two-level granular permissions

Storage:
- `User.permissions` (JSONB `{ 'admin.users.view': true, ... }`) — **global** rights, used by the admin panel.
- `ProjectMember.permissions` (JSONB) — **per-tenant** bindings (cabinet teams).
- `User.is_superadmin` — full bypass.

One middleware serves both:

```js
export function requirePermission(permission) {
    return async (req, res, next) => {
        const user = await loadUser(req);
        if (user.is_superadmin) { req.member = { permissions: {}, role: 'superadmin' }; return next(); }
        if (req.isAdmin) {
            if (hasGranular(user.permissions, permission)) return next();
            const m = isProjectScoped(permission) ? await loadMembership(user, req) : null;
            if (m && hasGranular(m.permissions, permission)) { req.member = m; return next(); }
            throw ApiError.Forbidden(`Missing permission: ${permission}`);
        }
        const m = await loadMembership(user, req);                 // tenant users: membership only
        if (!m) throw projectIdOf(req) ? ApiError.Forbidden('No access') : ApiError.BadRequest('Project ID required');
        if (!hasGranular(m.permissions, permission)) throw ApiError.Forbidden(`Missing permission: ${permission}`);
        req.member = m; next();
    };
}
```

`isProjectScoped(perm)` = namespace routing: `admin.*` / `account.*` → global only; everything else may come from a membership.

**Implied views**: holding any mutator implies the matching `*.view`:

```js
export function hasGranular(perms, permission) {
    if (!perms) return false;
    if (perms[permission] === true) return true;
    for (const m of (VIEW_IMPLIED_BY[permission] || [])) if (perms[m] === true) return true;
    return false;
}
// VIEW_IMPLIED_BY = { 'wallets.view': ['wallets.create.manual', 'wallets.archive', ...], ... }
```

Catalog lives in ONE file: `PERMISSIONS` (string array), `PERMISSION_LABELS`, `allPermissions()`, `allProjectPermissions()`, `VIEW_IMPLIED_BY`. Adding a permission there is enough — `requirePermission` and the admin permission editor pick it up. Mirror a trimmed copy to the frontend if needed.

## Permission presets — snapshot semantics

`PermissionPreset { project_id|null, name, permissions JSONB }`. Applying a preset:

1. **Snapshot**: `JSON.parse(JSON.stringify(preset.permissions))` — later preset edits do NOT propagate to assignees.
2. **Overwrite, not merge**: `target.permissions = snapshot; target.changed('permissions', true)`.
3. **Anti-escalation**: a non-superadmin cannot grant any permission they don't hold themselves (`PERMISSION_ESCALATION`), and cannot apply to self.
4. **Sanitize on create/update**: whitelist keys against the catalog, coerce values to boolean.
5. The apply route is gated by `requireOtp(...)` — 2FA-confirmed.

## TOTP / 2FA

Flow: `POST /2fa/setup` → `speakeasy.generateSecret()`, stash pending secret in an in-memory map (TTL 10 min; multi-replica needs sticky sessions or Redis) → return base32 + QR data-URL. `POST /2fa/verify` → verify against pending → persist `otp_secret`, set `otp_enabled`.

All verification funnels through one function:

```js
export async function verifyOtpOrThrow(user, token) {
    if (!user?.otp_secret) throw ApiError.Unauthorized('TOTP not initialised', 'OTP_REQUIRED_SETUP');
    await checkLockout(user.id);                                  // 5 fails / 15 min → OTP_LOCKED
    if (!speakeasy.totp.verify({ secret: user.otp_secret, encoding: 'base32', token: String(token), window: 1 })) {
        await recordFailure(user.id);
        throw ApiError.Forbidden('Invalid 2FA code', 'OTP_INVALID');
    }
    await clearFailures(user.id);
    return true;
}
```

`requireOtp(actionLabel)` middleware reads the code from `req.body.otp_token` / `x-otp-token` header / query, verifies, then `delete req.body.otp_token` before the handler.

Error-code contract with frontends (keep these exact): `OTP_REQUIRED_SETUP`, `OTP_REQUIRED`, `OTP_INVALID`, `OTP_LOCKED`. The frontend pattern: parent form owns data; on submit it opens a TOTP modal; `OTP_INVALID`/`OTP_REQUIRED` are re-thrown to the modal inline; other errors close the modal and toast.

## Login hardening

- Lockout counters by email AND by IP via `makeCounter` (see rate-limiting reference).
- Username-enumeration defense: precomputed `DUMMY_HASH = bcrypt.hashSync('dummy-password', 10)`; on unknown email run `bcrypt.compare(input, DUMMY_HASH)` anyway so timing is constant.
- The frontend 401 interceptor must NOT redirect on the login endpoint itself (reload loop on bad creds).
