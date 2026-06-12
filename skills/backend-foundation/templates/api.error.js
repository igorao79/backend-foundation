// ApiError — the ONLY error type thrown in request paths.
// Rule: `new ApiError(...)` is forbidden outside this file; use the static factories.
export default class ApiError extends Error {
    status; errors; code;

    constructor(status, message, errors = [], code = null) {
        super(message);
        this.status = status;
        this.errors = errors;
        this.code = code;
    }

    /** Dynamic status (410 Gone, rewrapping caught errors, etc.) */
    static of(status, message, code = null, errors = []) {
        return new ApiError(status, message, errors, code);
    }

    static BadRequest(message, errors = [], code) {
        return new ApiError(400, message, errors, code || (errors?.length ? 'VALIDATION_ERROR' : 'BAD_REQUEST'));
    }
    static Unauthorized(message = 'Unauthorized', code) {
        return new ApiError(401, message, [], code || 'UNAUTHORIZED');
    }
    static Forbidden(message, code) {
        return new ApiError(403, message, [], code || 'FORBIDDEN');
    }
    static NotFound(message, code) {
        return new ApiError(404, message, [], code || 'NOT_FOUND');
    }
    static Conflict(message, code) {
        return new ApiError(409, message, [], code || 'CONFLICT');
    }
    static TooManyRequests(message, code) {
        return new ApiError(429, message, [], code || 'TOO_MANY_REQUESTS');
    }
    static Internal(message, code) {
        return new ApiError(500, message, [], code || 'INTERNAL');
    }
    static ServiceUnavailable(message, code) {
        return new ApiError(503, message, [], code || 'SERVICE_UNAVAILABLE');
    }
}

export { ApiError };
