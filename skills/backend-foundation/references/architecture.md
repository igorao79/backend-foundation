# Architecture: contours (bounded contexts), naming, composition root

## Layout

`src/` is organized **by domain (contour)**, not by file type. Composition-root / lifecycle files live at the backend **root**:

```
backend/
├─ server.js              ← Express app + main() + graceful shutdown
├─ env.js                 ← dotenv cascade + fail-fast validation (imported FIRST)
├─ db.js                  ← Sequelize init, static model imports, sync strategy
├─ db-migrations.js       ← MIGRATIONS_BASELINE + MIGRATIONS_POST_BASELINE arrays
├─ crons.js               ← startCrons()/stopCrons()
├─ ensure-base-rows.js    ← idempotent seed of singleton rows
├─ models/                ← Sequelize model factories (+ _info.md)
├─ queues/                ← BullMQ queue definitions (connection.js, *.queue.js, index.js)
├─ workers/               ← BullMQ consumers (worker-config.js, *.worker.js, index.js)
├─ scripts/               ← one-off manual utilities
└─ src/
   ├─ _info.md            ← master map of all contours
   ├─ api.error.js        ← cross-cutting infra only at src/ root
   ├─ api.limiter.js
   ├─ error.middleware.js
   ├─ crypto.helper.js    ← (signing-encryption)
   ├─ core/               ← shared kernel: http.helper, validators, logger, network-security,
   │                        system-config, rates/TTL-caches — the ONLY place reading process.env directly
   ├─ auth/               ← JWT, 2FA, login/logout, panel middleware chains
   ├─ admin/              ← admin panel API (router + middleware + services/)
   ├─ merchant/           ← merchant panel API (isolated from admin/)
   ├─ gateway/            ← public HMAC API surface + its money orchestration
   └─ <domain>/           ← any other domain contour
```

**Why root, not src/?** `db.js` imports all models; `server.js`/`workers/` are process-level. Domain code must not import process-lifecycle files; keeping them out of `src/` makes that boundary physical. Deploys also touch these files (env, migrations), so ops concerns stay in one visible layer.

## Naming

- Files: `<contour>.<feature>.<type>.js` → `admin.users.service.js`, `gateway.signature.middleware.js`, `merchant.projects.router.js`.
- `core/` files have no prefix (domain-agnostic): `http.helper.js`, `logger.helper.js`.
- Special routers: `<contour>.public.router.js` (unauthenticated), `<contour>.sandbox.router.js`/`<contour>.test.router.js` (non-prod mocks).
- Services: `export class UsersService {}` + `export const usersService = new UsersService()`. One file = one class + one singleton.
- Optional barrel one level up (`admin.service.js` re-exports all singletons from `services/`).

## Router assembly + protection chains

One main router per panel/surface. The protection chain is applied **once at the mount** in `server.js`:

```js
app.use('/api/v1',  apiRateLimit, apiLoggerMiddleware, signatureMiddleware, apiRouter);
app.use('/auth',    authRouter);                                   // public
app.use('/admin',   adminRateLimit, adminMiddleware, adminRouter); // gated
app.use('/merchant', merchantMiddleware, merchantRouter);          // gated
```

The panel router is an *assembler* — it mounts feature sub-routers and path-scoped permission gates, never repeats auth:

```js
// admin.router.js
router.use(accountRouter);
router.use('/accounting', requirePerm('admin.accounting.view'), accountingRouter);
router.use('/projects',   requirePerm('project.view'),          projectsRouter);

// merchant.router.js — base gate once, then everything under it
router.use('/projects/:id', vCommon.idParam('id'), validate);
router.use('/projects/:id', requirePermission('project.view'));
router.use('/projects/:id', projectsRouter);
```

Sub-routers hold only: granular permission checks beyond the base gate, route validation, delegation to services.

Public exceptions (register, sandbox) are mounted **before** the gated mount so the prefix wins.

## Panel isolation (firewall between contours)

Panels do not import each other's services. `merchant/` does not import from `admin/` — each re-implements its thin permission middleware and project CRUD against its own contract. Both MAY use neutral shared helpers (`core/`, `crypto.helper.js`, `auth.token.helper.js`). This keeps each panel independently changeable and testable.

## Folding rule (fewer files)

A file imported by exactly ONE consumer gets folded into that consumer. Keep a file separate only when it is:
1. a public API boundary (router, main middleware),
2. a contract/spec (permission catalog, validation rules, HMAC boundary),
3. used by 2+ contours,
4. genuinely complex (100+ lines, distinct responsibility).

God-files are acceptable; sprawl of 20-line helpers is not.

## `_info.md` format

Every contour (and `models/`, `workers/`, `scripts/`) carries an `_info.md`:

```markdown
# `<contour>/` — <purpose in 1 line>

<2-3 sentences: what this context owns, what it explicitly does NOT own>

## Files
- `<file>.js` — <one-line purpose / exported singleton>

## Key details
- <contract, boundary, or anti-pattern worth knowing>
```

Plus a master `src/_info.md` listing all contours and the root-vs-src rule. Keep these current whenever files move — they are the navigation layer for both humans and AI agents.
