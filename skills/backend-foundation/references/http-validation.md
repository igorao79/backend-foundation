# HTTP layer: ApiError, envelope, asyncHandler, validation, pagination

Templates: `templates/api.error.js`, `templates/http.helper.js`, `templates/error.middleware.js`, `templates/validators.js`.

## ApiError — single error type

```js
export default class ApiError extends Error {
    status; errors; code;
    constructor(status, message, errors = [], code = null) { super(message); ... }
    static of(status, message, code = null, errors = []) { ... }   // dynamic status (410 etc.)
    static BadRequest(message, errors = [], code) { ... }          // auto-code VALIDATION_ERROR if errors[]
    static Unauthorized / Forbidden / NotFound / Conflict / TooManyRequests / Internal / ServiceUnavailable
}
export { ApiError };  // dual export — both import styles work
```

Rules:
- `new ApiError(...)` is allowed ONLY inside the class file; everywhere else use static factories.
- Always pass a machine `code` (second/third arg): `ApiError.NotFound('Deposit not found', 'DEPOSIT_NOT_FOUND')`. Codes are the contract with frontends, retry logic, and callbacks.
- `ApiError.of(status, ...)` for unusual statuses or rewrapping caught errors.

## Response envelope + asyncHandler

Success and error envelopes are distinct and produced in exactly two places:

```js
// success — respondMiddleware mounts res.ok()/res.okPage() once in server.js
{ ok: true, result, meta?, notice? }

// error — error.middleware.js only
{ success: false, error: { message, code, errors } }
```

`asyncHandler` lets handlers return data; a Symbol-marked wrapper picks the status:

```js
const ENVELOPE = Symbol('http.envelope');
export const created   = (result)      => ({ [ENVELOPE]: 'created',   result });
export const paginated = (items, meta) => ({ [ENVELOPE]: 'paginated', items, meta });

export const asyncHandler = (fn) => async (req, res, next) => {
    try {
        const out = await fn(req, res, next);
        if (res.headersSent || out === undefined) return;
        if (out !== null && typeof out === 'object') {
            if (out[ENVELOPE] === 'created')   return res.status(201).ok(out.result);
            if (out[ENVELOPE] === 'paginated') return res.okPage(out.items, out.meta);
        }
        return res.ok(out);
    } catch (err) { next(err); }
};
```

Handlers therefore: `return data` (200), `return created(data)` (201), `return paginated(rows, meta)`. Never `res.json()` in a handler.

## Central error middleware

Four-arg Express handler, mounted LAST:

```js
export function errorMiddleware(err, req, res, next) {
    const isApi  = err instanceof ApiError;
    const status = isApi ? err.status : 500;
    const code   = isApi ? (err.code || 'ERROR') : 'INTERNAL';
    logger.error(`[API] ${req.method} ${req.originalUrl} → ${status} ${code}: ${err.message}`);
    if (!isApi || status >= 500) logger.error(err.stack || err);
    // optional side-effect hook (alerting) — setImmediate so it never blocks the response
    if (isApi) return res.status(status).json({ success: false, error: { message: err.message, code, errors: err.errors || [] } });
    return res.status(500).json({ success: false, error: { message: 'Internal server error', code: 'INTERNAL', errors: [] } });
}
```

Key points: 5xx details are hidden from clients; stacks logged only for non-ApiError / 5xx; alert hooks (Telegram/Slack) go through `setImmediate(() => notify(...).catch(() => {}))`.

A 404 catch-all goes just before it: `app.all(/(.*)/, (req,res) => res.status(404).json({ success:false, error:{ message:'Not found', code:'NOT_FOUND', errors:[] } }))`.

## Validation (express-validator)

One terminator middleware + namespace objects per contour:

```js
export const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        // deliberately exclude .value — never leak passwords/secrets into responses/logs
        const safe = errors.array().map(({ msg, path, location }) => ({ msg, path, location }));
        return next(ApiError.BadRequest('Validation failed', safe, 'VALIDATION_ERROR'));
    }
    next();
};
```

`vCommon` holds domain-agnostic primitives (`idParam`, `dateOpt`, `strOpt(name, max)`, `intOpt`, `floatOpt`). Each contour defines its own namespace (`vGateway`, `vAdmin`, …) in the same file or its contour. Declared inline on the route so the chain is visible:

```js
router.post('/deposit/create', vGateway.amount, vGateway.currency, validate, asyncHandler(...));
router.put('/projects/:id', ...vAdmin.updateProjectFields, validate, asyncHandler(...));  // spread for big sets
```

Useful advanced shapes:
- cross-field: `body().custom((_, { req }) => { if (req.body?.type==='static' && !req.body?.user_id) throw new Error('user_id required'); return true; })`
- arrays: `body('destinations').isArray({min:1})`, `body('destinations.*.amount').isFloat({gt:0}).toFloat()`
- avoid async validators that hit the DB — do that in the service.

## Pagination

```js
export function parsePagination(req, { def = 50, max = 200 } = {}) {
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(max, Math.max(1, parseInt(req.query.limit, 10) || def));
    return { page, limit, offset: limit * (page - 1) };
}
```

Service does `findAndCountAll({ where, order, offset, limit })` and returns `paginated(rows, { page, limit, total: count, pages: Math.ceil(count/limit) || 1 })`.

## Controller/service rules

- Controllers/services receive prepared DTO fields, never `req`/`res`.
- Authorize before returning data (tenant scope checks like `if (row.project_id !== project.id) throw ApiError.NotFound(...)` — NotFound, not Forbidden, to avoid existence leaks).
- Serialize with field whitelists (`Object.fromEntries(FIELDS.map(k => [k, row[k]]))`) — never return raw ORM models on public surfaces.
