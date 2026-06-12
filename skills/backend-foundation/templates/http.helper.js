// Response envelope + asyncHandler + pagination.
// Mount respondMiddleware ONCE in server.js (before routers). Handlers return data; never call res.json().

export const respondMiddleware = (req, res, next) => {
    res.ok = (result, opts = {}) => {
        const body = { ok: true, result: result === undefined ? null : result };
        if (opts.meta !== undefined) body.meta = opts.meta;
        if (opts.notice !== undefined) body.notice = opts.notice;
        return res.json(body);
    };
    res.okPage = (items, meta, opts = {}) => {
        const body = { ok: true, result: items, meta };
        if (opts.notice !== undefined) body.notice = opts.notice;
        return res.json(body);
    };
    next();
};

const ENVELOPE = Symbol('http.envelope');
/** return created(data) from a handler → 201 { ok:true, result:data } */
export const created = (result) => ({ [ENVELOPE]: 'created', result });
/** return paginated(rows, meta) from a handler → 200 { ok:true, result:rows, meta } */
export const paginated = (items, meta) => ({ [ENVELOPE]: 'paginated', items, meta });

export const asyncHandler = (fn) => async (req, res, next) => {
    try {
        const out = await fn(req, res, next);
        if (res.headersSent || out === undefined) return;
        if (out !== null && typeof out === 'object') {
            if (out[ENVELOPE] === 'created') return res.status(201).ok(out.result);
            if (out[ENVELOPE] === 'paginated') return res.okPage(out.items, out.meta);
        }
        return res.ok(out);
    } catch (err) {
        next(err);
    }
};

export function parsePagination(req, { def = 50, max = 200 } = {}) {
    const page = Math.max(1, parseInt(req.query.page, 10) || 1);
    const limit = Math.min(max, Math.max(1, parseInt(req.query.limit, 10) || def));
    return { page, limit, offset: limit * (page - 1) };
}
