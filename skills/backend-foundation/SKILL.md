---
name: backend-foundation
description: Production-grade Node.js backend foundation (Express + Sequelize/Postgres + BullMQ/Redis). Use this skill whenever the user starts a new backend, scaffolds an API service, adds a major subsystem to an existing backend (auth, permissions, public HMAC API, rate limiting, job queues/workers, DB migrations, money/ledger accounting), or asks to structure/refactor a backend "properly". It provides battle-tested patterns and ready code templates for bounded-context (contour) layout, ApiError + response envelope, validation, JWT auth middleware chains, granular permissions with TOTP/2FA, HMAC-signed public APIs with replay protection, rate limiters, idempotent boot migrations, double-entry ledger, uniform BullMQ workers with circuit breakers, crons, and graceful shutdown. Prefer these patterns over inventing new ones, even for small additions.
---

# Backend Foundation

A complete architecture for a production Node.js backend, extracted from a live crypto payment gateway. Two kinds of material:

- `templates/` — generalized, copy-ready ES-module source files. Copy them into the new project (adjusting import paths), don't retype them.
- `references/` — deep documentation per subsystem with full code, the reasoning behind each decision, and what to customize.

The stack assumed: **Express + Sequelize (Postgres) + BullMQ (Redis)**, ES modules, Node's built-in test runner. If the project uses a different stack, keep the *patterns* (envelope, ApiError, contours, CAS updates, idempotency keys) and adapt the code.

## Non-negotiable conventions

These keep every backend built on this foundation uniform and junior-readable:

1. **Errors**: only `ApiError` static factories (`ApiError.NotFound('...', 'CODE')`). Never `new ApiError(...)` outside the class file, never raw `throw new Error` in request paths. Every error carries a machine `code`.
2. **Responses**: one envelope. Success `{ ok: true, result, meta? }` via `res.ok()` / `created()` / `paginated()`; errors `{ success: false, error: { message, code, errors } }` from the central error middleware. Route handlers **return data**, they never call `res.json()` directly — `asyncHandler` does the wrapping.
3. **Services are classes**: `export class XService {}` + `export const xService = new XService()`. Services take prepared DTO fields (never `req`), throw `ApiError`, return plain objects. Private helpers use `#method()`.
4. **One router per panel/surface**, protection chain applied **once at the mount** in `server.js`: `app.use('/admin', adminRateLimit, adminMiddleware, adminRouter)`. Sub-routers contain only granular permission gates + validation + delegation.
5. **Contours (bounded contexts)**: `src/` is organized by domain, not by file type. Files are contour-prefixed: `admin.users.service.js`, `gateway.signature.middleware.js`. Composition-root files (`server.js`, `db.js`, `env.js`, `crons.js`, `models/`, `queues/`, `workers/`) live at the backend **root**, not in `src/`.
6. **Fewer files**: a file used by exactly one consumer gets folded into that consumer. God-files are acceptable; tiny single-use helpers are not. Keep files separate only when they are public API boundaries, security/permission contracts, or used by 2+ contours.
7. **Money**: `DECIMAL(28,8)` columns, Decimal.js for arithmetic, accumulation done in SQL (`CAST(:amount AS numeric)`), never JS floats. Every accounting event is idempotent on `(ref_type, ref_id)`.
8. **Each contour has an `_info.md`** — a short map: purpose (1 line), file list with one-line descriptions, key contracts/anti-patterns. Plus a master `src/_info.md`.

## Scaffolding a new backend — order of operations

1. **Composition root first**. Copy `templates/env.js` (env loading + fail-fast validation), `templates/api.error.js`, `templates/logger.helper.js`, `templates/http.helper.js`, `templates/error.middleware.js`, `templates/validators.js`, `templates/metrics.helper.js` (request-id context + `/metrics`), `templates/network-security.helper.js` (`getClientIP` + SSRF guard). Wire a minimal `server.js` per `references/bootstrap.md`: env import first, `requestContextMiddleware` then `respondMiddleware`, routers, `/health` + `/metrics`, 404 catch-all, `errorMiddleware` last, then `main()` with two-phase startup and graceful shutdown. See `references/observability.md`.
2. **Database**. Follow `references/database.md`: `db.js` with static model imports + factory pattern, environment-aware sync (force on `*_test` DBs only — with the destructive-sync guard), and the two-phase idempotent migration runner (baseline behind a flag + post-baseline every boot, non-fatal).
3. **Auth** (if the service has users): `references/auth-permissions.md`. JWT helper (HS256 pinned, jti + DB-backed revocation), `buildPanelMiddleware(panel, ...extra)` chains, granular permissions engine (`hasGranular` + `VIEW_IMPLIED_BY`), TOTP with lockout counters, presets with snapshot semantics and anti-escalation.
4. **Public machine API** (if needed): `references/hmac-gateway.md`. HMAC-SHA256 over canonically sorted JSON, timing-safe verify, timestamp skew + Redis SETNX replay protection (fail-closed), sandbox test router mounted before prod.
5. **Rate limiting**: `references/rate-limiting.md`. The `Limiter` class with per-surface named limiters keyed by API-key / user-id / IP, plus `makeCounter` for login/OTP lockouts, plus per-tenant DB-backed throttles (advisory lock + concurrent cap + sliding window).
6. **Queues & workers** (if async work exists): `references/queues-workers.md`. `defineQueue`/`closeQueues` connection layer, one `*.queue.js` per queue + `index.js` barrel, central `worker-config.js`, uniform worker factory, idempotent jobIds, custom backoff schedules, circuit breaker for outbound webhooks.
7. **Ledger** (if the service moves money): `references/ledger.md`. Boxes + signed entries, `createTransaction(entries)` atomic multi-leg posting, `(ref_type, ref_id)` idempotency, per-domain entry builders.
8. **Tests**: `references/database.md` § test infra. Separate `*_test` DB enforced by a guard, `sync({force:true})` per process, unique tags for isolation.

After scaffolding, create `_info.md` files for each contour you made.

## Adding to an EXISTING backend

Identify which contour the change belongs to (or create one). Read the matching reference file before writing code, and reuse the templates' helpers instead of duplicating them. When unsure where a file lives: routers/middleware/services for a domain → that contour in `src/`; process-lifecycle or ORM/queue wiring → backend root.

## Normalizing an existing backend into this shape

When the user asks to "refactor properly", "bring it up to standard", or "make it like the foundation" — i.e. converge a project that already exists onto these conventions — **read `references/normalization.md` first**. It is a staged, behavior-preserving playbook, not a rewrite. The essentials:

1. **Audit before editing.** Produce a gap table (`area | current | target | risk | effort`) and let the user pick scope. Never silently start a multi-file refactor.
2. **Adopt in low-risk order**: composition root (env/logger/crash handlers) → error+envelope layer → validation → rate-limit + network security → auth → contour reorg → idempotency/ledger/queues → `_info.md`. Each step is an independently shippable, revertable commit.
3. **Normalize seams, not logic.** Changing how errors/responses/files are *shaped* is in scope; changing what a route *computes* or the JSON a client sees is a contract change — flag it, get sign-off, keep it in a separate diff.
4. **Helpers before layout.** Add the cross-cutting templates before moving files into contours, or you'll move code twice. Split god-files by moving functions, not rewriting them.
5. **Money & idempotency retrofits are dangerous** — floats-on-money, missing webhook dedup, read-modify-write races each need before/after invariant snapshots and the verification gate. One subsystem at a time.

## Reference index — read before implementing the matching subsystem

| File | Covers |
|---|---|
| `references/architecture.md` | Contour layout, naming, `_info.md` format, composition root, folding rules, router assembly |
| `references/http-validation.md` | ApiError, envelope/asyncHandler, error middleware, express-validator namespaces, pagination |
| `references/auth-permissions.md` | JWT lifecycle, middleware chains, two-level permissions, TOTP/2FA, lockouts, presets |
| `references/hmac-gateway.md` | HMAC signing, signature middleware, replay protection, idempotent order_id, sandbox router |
| `references/rate-limiting.md` | Limiter class, lockout counters, per-tenant invoice throttles |
| `references/queues-workers.md` | BullMQ connection/queue/worker layers, retries, circuit breaker, webhook delivery |
| `references/database.md` | Sequelize setup, model conventions, idempotent migrations, encryption-key fingerprint, test infra |
| `references/ledger.md` | Double-entry accounting core, boxes, entry builders, precision rules |
| `references/bootstrap.md` | server.js composition, two-phase main(), crons factory, graceful shutdown, env validation |
| `references/observability.md` | Request-id context, Prometheus `/metrics`, `/health`, SSRF guard, `getClientIP` |
| `references/normalization.md` | Playbook to refactor an EXISTING backend into this shape — audit, ordering, god-file splits, pitfalls |

## Template index — copy, then adjust imports/env names

| Template | Purpose |
|---|---|
| `templates/api.error.js` | ApiError with static factories |
| `templates/http.helper.js` | respondMiddleware, asyncHandler, created/paginated, parsePagination |
| `templates/error.middleware.js` | Central error → envelope serializer (with optional notify hook) |
| `templates/validators.js` | `validate` terminator + `vCommon` primitives |
| `templates/logger.helper.js` | JSON/pretty logger with recursive secret redaction |
| `templates/api.limiter.js` | Limiter class + makeCounter lockouts |
| `templates/crypto.helper.js` | AES-256-GCM encrypt/decrypt, HMAC signPayload/verifySignature, key generators |
| `templates/auth.middleware.js` | authenticate, requireRole, buildPanelMiddleware, requireOtp, verifyOtpOrThrow |
| `templates/permissions.helper.js` | hasGranular, VIEW_IMPLIED_BY, requirePermission factory |
| `templates/signature.middleware.js` | HMAC gateway middleware with replay protection |
| `templates/queues.connection.js` | makeConnection, defineQueue, queuePrefix, closeQueues |
| `templates/worker.factory.js` | Uniform worker factory + CircuitBreaker class |
| `templates/crons.js` | startCron factory (overlap guard, silent errors), start/stopCrons |
| `templates/migrations.runner.js` | Two-phase idempotent boot migrations |
| `templates/env.js` | dotenv cascade + fail-fast config validation |
| `templates/accounting.core.js` | Ledger kernel: boxes + createTransaction(entries) |
| `templates/network-security.helper.js` | Proxy-aware `getClientIP` + SSRF guard (`resolveAndAssertPublic`, `safeOutboundUrl`) |
| `templates/metrics.helper.js` | `requestContextMiddleware` (request id + per-request log), Prometheus `httpMetrics`, `metricsHandler` |
| `templates/tests.setup.js` | Test-DB guard, cleanTables, unique-tag fixtures |

## Quick example — a complete new endpoint, the canonical way

```js
// src/billing/billing.router.js
import { Router } from 'express';
import { asyncHandler, created, paginated, parsePagination } from '../core/http.helper.js';
import { validate, vCommon } from '../core/validators.js';
import { requirePermission } from '../core/permissions.helper.js';
import { invoicesService } from './billing.invoices.service.js';

const router = Router();

router.get('/invoices',
    vCommon.strOpt('status', 64), vCommon.dateOpt('from'), validate,
    requirePermission('invoices.view'),
    asyncHandler(async (req) => {
        const { page, limit, offset } = parsePagination(req, { def: 50, max: 200 });
        const { rows, count } = await invoicesService.list({ status: req.query.status, offset, limit });
        return paginated(rows, { page, limit, total: count, pages: Math.ceil(count / limit) || 1 });
    }));

router.post('/invoices',
    requirePermission('invoices.create'),
    asyncHandler(async (req) => created(await invoicesService.create({ amount: req.body.amount }))));

export { router as billingRouter };
```

The handler never touches `res`; validation is declared on the route; the service throws `ApiError`; the envelope is uniform. Every endpoint in the codebase should look like this.
