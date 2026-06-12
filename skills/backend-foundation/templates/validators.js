// express-validator: one terminator middleware + reusable primitives.
// Each contour adds its own namespace object (vGateway, vAdmin, ...) next to vCommon.
import { validationResult, param, query, body } from 'express-validator';
import ApiError from './api.error.js';

export const validate = (req, res, next) => {
    const errors = validationResult(req);
    if (!errors.isEmpty()) {
        // Deliberately exclude `.value` — never leak passwords/secrets into responses or logs.
        const safe = errors.array().map(({ msg, path, location }) => ({ msg, path, location }));
        return next(ApiError.BadRequest('Validation failed', safe, 'VALIDATION_ERROR'));
    }
    next();
};

export const vCommon = {
    idParam: (name) => param(name).isString().bail().trim().notEmpty(),

    dateOpt: (name) => query(name).optional({ values: 'falsy' }).isString().bail()
        .custom((v) => {
            if (Number.isNaN(new Date(v).getTime())) throw new Error(`${name} must be a valid date`);
            return true;
        }),

    strOpt: (name, max = 256) => query(name).optional({ values: 'falsy' }).isString().trim().isLength({ max }),
    intOpt: (name, opts = {}) => query(name).optional({ values: 'falsy' }).isInt(opts),
    floatOpt: (name, opts = {}) => query(name).optional({ values: 'falsy' }).isFloat(opts),

    strBody: (name, max = 256) => body(name).isString().trim().notEmpty().isLength({ max }),
    amountBody: (name = 'amount') => body(name).isFloat({ min: 1e-8 }).toFloat(),
};

// Example of a contour namespace — keep domain validators grouped like this:
// export const vBilling = {
//     destinations: body('destinations').isArray({ min: 1 }),
//     destAmount:   body('destinations.*.amount').isFloat({ gt: 0 }).toFloat(),
//     crossField:   body().custom((_, { req }) => {
//         if (req.body?.type === 'static' && !req.body?.user_id) throw new Error('user_id is required for static type');
//         return true;
//     }),
// };
