# Normalization: bringing an existing backend into this shape

Use this when the user points the skill at an **existing** backend and asks to "bring it up to standard", "refactor it properly", "make it like the foundation", or when scaffolding a subsystem into a codebase that already has its own conventions. The goal is to converge the project onto the conventions in `architecture.md` **without a big-bang rewrite** — each step lands as an independently shippable, behavior-preserving change.

Golden rule: **normalize the seams, not the business logic.** You are changing *how* code is shaped (errors, envelope, contours, file naming, idempotency), never *what* it computes. If a step changes an output a client sees, it is a feature change — flag it, don't smuggle it in.

## 0. Assess before touching anything

Produce a short written audit first (the user should see it before edits). Walk the repo and answer:

1. **Stack** — Express? Sequelize/Prisma/Knex/raw? BullMQ/Bull/none? Redis? ESM or CJS? TypeScript? (read `package.json` + a couple of source files). The patterns are portable; the *templates* assume Express + Sequelize + BullMQ + ESM. On a different stack, keep the patterns and adapt.
2. **Entry point & lifecycle** — where the server starts, how middleware is ordered, whether there's graceful shutdown / crash handlers / env validation.
3. **Error surface** — how errors are thrown and rendered today. Grep for `res.status(`, `res.json(`, `throw new Error`, `catch (e)`. Count how many distinct response shapes exist. This is almost always the highest-leverage fix.
4. **Layout** — by-type (`controllers/ models/ routes/ services/`) or by-domain? Are there god-files? Circular imports?
5. **Auth** — JWT? sessions? where is it verified, is it revocable, is there 2FA, are permissions a boolean role or granular?
6. **Money** — any floats on money? (`grep` for `parseFloat`, `Number(`, `* 100`, `toFixed` near amounts). Floats on money is a **stop-and-flag** finding.
7. **Idempotency & races** — do webhook handlers / payment paths dedupe? Any `findOrCreate`, unique constraints, advisory locks, CAS updates?
8. **Tests** — runner, do they hit a real DB, is there a `*_test` guard?

Output a gap table: `area | current | target | risk | effort`. Then propose an ordering (next section) and let the user pick scope. Never silently start a 30-file refactor.

## 1. Order of operations (lowest risk → highest)

Adopt foundation pieces in this order. Each is a separate commit/PR and is safe to stop after.

1. **Composition root, additively.** Drop in `templates/env.js` (fail-fast config) and `templates/logger.helper.js`. Add crash handlers and graceful shutdown from `bootstrap.md` if missing. These are purely additive — no behavior change, immediate safety win.
2. **Error + envelope layer.** Add `api.error.js`, `http.helper.js` (`respondMiddleware` + `asyncHandler`), `error.middleware.js`. Mount `respondMiddleware` early and `errorMiddleware` **last**. Now *new* code can use the envelope while old routes keep working — see migration recipe below. This is the spine; do it before contour moves.
3. **Validation.** Add `validators.js` (`validate` + `vCommon`). Convert routes to declare validation on the route as you touch them.
4. **Rate limiting + network security.** Add `network-security.helper.js` (gives you the one true `getClientIP` + SSRF guard) and `api.limiter.js`. Mount limiters at the surfaces.
5. **Auth normalization.** Only if the project has auth debt. Move to revocable JWT (jti), `buildPanelMiddleware` chains, granular permissions. This is invasive — its own milestone.
6. **Contour reorganization.** Now move files into bounded contexts and rename to `<contour>.<thing>.<kind>.js`. Do this *after* the cross-cutting helpers exist, because the moves are pure path churn and the helpers are what make the moved code uniform.
7. **Idempotency / ledger / queues.** Domain-specific hardening (idempotency keys, double-entry ledger, BullMQ workers, circuit breakers, SSRF on outbound). Highest value, highest care — one subsystem at a time, each with the verification gate below.
8. **`_info.md` per contour** once the layout settles.

## 2. Migrating the error/envelope layer without breaking clients

You cannot flip every route at once. Bridge it:

- Mount `errorMiddleware` last **immediately** — it already passes through anything that isn't an `ApiError` with the old shape if you keep the legacy fallback, or you standardize the error shape in one shot if clients can take it (confirm with the user — changing error JSON is a contract change).
- Add `asyncHandler` and convert routes **opportunistically**: every route you touch for any reason gets converted (return data, throw `ApiError`, drop manual `res.json`). Track progress with `grep -rc 'res.json' src/`.
- Replace `throw new Error('x')` in request paths with `ApiError.*` as you go. A bare `throw` now becomes a clean 500 with a code instead of a stack leak.
- Do **not** rewrite a route's logic while converting its envelope. One concern per diff.

## 3. Splitting a god-file

Common in legacy backends (a 3000-line `service.js` or `routes.js`). Mechanical, low-risk recipe:

1. Identify natural seams (feature groups, e.g. projects / wallets / withdrawals).
2. Create `<contour>.<feature>.service.js` per seam; **move** functions, don't rewrite them.
3. Wrap moved functions in the class-instance convention (`export class XService {}` + `export const xService = new XService()`) only if the surrounding code already uses it — otherwise keep them as exports and convert later. Consistency with the *new* target matters more than converting everything at once.
4. Fix imports; run tests / typecheck after each seam extraction (not at the end).
5. Watch for **circular imports** surfacing once split — break them by moving the shared type/constant to a leaf module, never by re-merging.

Folding rule still applies in reverse: don't over-split. A helper used by exactly one consumer stays with it (`architecture.md` §folding).

## 4. Stack adaptations (when it isn't Express+Sequelize+BullMQ+ESM)

- **CommonJS** — templates are ESM; convert `import`/`export` to `require`/`module.exports` on copy, or set `"type":"module"`. Don't mix.
- **TypeScript** — port the templates to `.ts`, add types at boundaries (DTOs, `ApiError`, envelope). The patterns are identical; you gain compile-time checks on the envelope.
- **Prisma / Knex / raw SQL** — keep the ledger's SQL-side accumulation (`CAST(:amount AS numeric)`) and idempotency-on-`(ref_type, ref_id)`; reimplement `createTransaction` inside your ORM's transaction primitive.
- **Fastify / Koa / Nest** — `asyncHandler` and the envelope map to the framework's reply/interceptor; `ApiError` + central error handler is universal. Mount order (context first, error last) is the same.
- **No queue** — if async work is done inline today, the worker pattern is your migration target for anything retryable (webhooks especially); introduce BullMQ behind the existing call site.

## 5. Idempotency & race retrofits (the dangerous ones)

These touch money/state correctness — apply with the verification gate, never blind:

- **Webhook/callback handlers**: add a unique idempotency key on the inbound event id; make the handler a no-op on replay. Add SSRF guard (`resolveAndAssertPublic`) to any outbound callback before retrofitting retries.
- **Payment/state transitions**: replace read-modify-write with CAS (`UPDATE ... WHERE status = 'pending'` and check `rowCount`) or an advisory lock. Add a partial unique index to make double-posting impossible at the DB level, then rely on `findOrCreate`.
- **Money**: migrate float columns to `DECIMAL(28,8)`; route arithmetic through Decimal.js; move accumulation into SQL. This needs a data migration with before/after balance snapshots — treat as its own project, flagged to the user.

## 6. Pitfalls

- **Big-bang rewrites.** Never. Every step here is independently revertable and shippable. If a change can't be, it's scoped wrong.
- **Changing response/error JSON silently.** That's a client-facing contract change — surface it explicitly and get sign-off.
- **Moving files and changing logic in the same commit.** Reviewers can't see the logic change under the path churn. Separate them.
- **Mounting a blanket permission gate on a whole router** (`router.use('/admin', requirePerm(...))`) — it 403s sub-routes that need a *different* perm. Gate per path. (See `auth-permissions.md`.)
- **Adopting contours before the helpers exist** — you'll move code twice. Helpers first, layout second.
- **Reformatting whole files** while editing — keep diffs minimal so review stays about the actual change. Match the file's existing style until a step explicitly normalizes it.

## 7. Verification gate (every step)

Before declaring a step done: tests pass (or you ran the affected path), the app boots, no new response shapes leaked to clients, and for money/idempotency steps you captured before/after invariants (balances, row counts). Report honestly — if a step is partial or a test was skipped, say so. See `verification-before-completion` discipline.
