// Structured logger: JSON lines in production, pretty console in dev.
// Recursively redacts sensitive keys. Injectable sink for tests.
const SENSITIVE_KEY_RE = /(password|passwd|secret|token|private[_-]?key|authorization|cookie|hmac|mnemonic)/i;
const DEFAULT_JSON = process.env.LOG_FORMAT === 'json'
    || (process.env.NODE_ENV === 'production' && process.env.LOG_FORMAT !== 'pretty');
const VERBOSE = process.env.LOG_VERBOSE === 'true';

const isPlainObject = (v) => v !== null && typeof v === 'object' && (v.constructor === Object || v.constructor === undefined);

function redact(value, depth = 0) {
    if (depth > 6) return '[max-depth]';
    if (value instanceof Error) return { name: value.name, message: value.message, stack: value.stack };
    if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
    if (!isPlainObject(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([k, v]) =>
        [k, SENSITIVE_KEY_RE.test(k) ? '[redacted]' : redact(v, depth + 1)]));
}

export class Logger {
    constructor({ json = DEFAULT_JSON, sink = console, now = () => new Date().toISOString(), pid = process.pid, verbose = VERBOSE } = {}) {
        this.json = json; this.sink = sink; this.now = now; this.pid = pid; this.verboseEnabled = verbose;
    }

    #write(level, method, args) {
        if (this.json) {
            const fields = isPlainObject(args[0]) ? redact(args[0]) : {};
            const rest = isPlainObject(args[0]) ? args.slice(1) : args;
            const msg = rest.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : JSON.stringify(redact(a)))).join(' ');
            this.sink[method](JSON.stringify({ ts: this.now(), level, pid: this.pid, ...fields, msg }));
        } else {
            this.sink[method](...args);
        }
    }

    info(...args) { this.#write('info', 'log', args); }
    warn(...args) { this.#write('warn', 'warn', args); }
    error(...args) { this.#write('error', 'error', args); }
    verbose(...args) { if (this.verboseEnabled) this.#write('debug', 'log', args); }
}

export const logger = new Logger();
