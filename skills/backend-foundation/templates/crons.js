// Cron factory: overlap guard + silent errors + centralized start/stop.
// Run startCrons() only on the primary replica (single-instance gating).
import { logger } from './src/core/logger.helper.js';

function startCron(name, everyMs, tickFn, { runOnBoot = false } = {}) {
    let ticking = false; // a slow tick is skipped, never stacked
    const run = async () => {
        if (ticking) return;
        ticking = true;
        try {
            await tickFn();
        } catch (err) {
            logger.error(`[Cron] ${name} failed`, err); // never throw — keep the timer alive
        } finally {
            ticking = false;
        }
    };
    if (runOnBoot) run();
    return setInterval(run, everyMs);
}

let timers = [];

export function startCrons() {
    timers = [
        // startCron('rates',  20_000, () => ratesService.refresh(), { runOnBoot: true }),
        // startCron('expiry', 60_000, () => invoiceService.expireStale()),
    ];
    logger.info('[Crons] started');
}

export function stopCrons() {
    for (const t of timers) clearInterval(t);
    timers = [];
}
