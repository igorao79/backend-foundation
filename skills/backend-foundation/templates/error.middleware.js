// Central error serializer. Mount LAST in server.js: app.use(errorMiddleware).
// 5xx details are hidden from clients; alert hooks never block the response.
import ApiError from './api.error.js';
import { logger } from './logger.helper.js';

let _notifyHook = null;
/** Optional: register an async alert sink (Telegram/Slack/email). Called via setImmediate; errors swallowed. */
export function setErrorNotifier(fn) { _notifyHook = fn; }

export function errorMiddleware(err, req, res, next) { // eslint-disable-line no-unused-vars
    const isApi = err instanceof ApiError;
    const status = isApi ? err.status : 500;
    const code = isApi ? (err.code || 'ERROR') : 'INTERNAL';

    logger.error(`[API] ${req.method} ${req.originalUrl} → ${status} ${code}: ${err.message}`);
    if (!isApi || status >= 500) logger.error(err.stack || err);

    if (_notifyHook && (!isApi || status >= 500)) {
        setImmediate(() => {
            Promise.resolve(_notifyHook({
                method: req.method, url: req.originalUrl,
                message: err.message, code, status,
                trace: err.stack, user_id: req.userId || null,
            })).catch(() => {});
        });
    }

    if (isApi) {
        return res.status(status).json({
            success: false,
            error: { message: err.message, code, errors: err.errors || [] },
        });
    }
    return res.status(500).json({
        success: false,
        error: { message: 'Internal server error', code: 'INTERNAL', errors: [] },
    });
}

export const errorHandler = errorMiddleware;
