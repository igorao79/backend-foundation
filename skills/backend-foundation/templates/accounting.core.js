// Ledger kernel: boxes + signed entries + atomic multi-leg posting.
// Models required:
//   AccountingBox         { name UNIQUE, type, balances JSONB, balance_usd DECIMAL(28,8), last_activity_at }
//   AccountingTransaction { box_id, type, currency, amount, amount_usd, connection_id, is_exchange,
//                           admin_id, comment, note JSONB, category, ref_type, ref_id, project_id,
//                           timestamps: createdAt only (updatedAt: false — entries are immutable) }
import { v4 as uuidv4 } from 'uuid';
import Decimal from 'decimal.js';
import { DB, sequelize } from '../db.js';
import { logger } from './logger.helper.js';

// Canonical box names — constants, never string literals at call sites.
export const BOX_MERCHANT = 'merchant';
export const BOX_REVENUE = 'revenue';

const _boxCache = new Map();
function _cacheBox(box) {
    if (box) _boxCache.set(box.name, { id: box.id, name: box.name, type: box.type });
    return box ? _boxCache.get(box.name) : box;
}

// Insert entry (idempotent on ref) + increment box balance IN SQL (DECIMAL precision, no JS floats).
async function _insertEntryAndIncrement(entry, t) {
    let row;
    if (entry.ref_id) {
        const [r, created] = await DB.AccountingTransaction.findOrCreate({
            where: { ref_type: entry.ref_type, ref_id: entry.ref_id, box_id: entry.box_id, category: entry.category },
            defaults: entry,
            transaction: t,
        });
        if (!created) return null; // already posted — skip the balance increment too
        row = r;
    } else {
        row = await DB.AccountingTransaction.create(entry, { transaction: t }); // manual ops always insert
    }

    await sequelize.query(`
        UPDATE "AccountingBoxes"
           SET "balances" = jsonb_set(COALESCE("balances",'{}'::jsonb), ARRAY[:currency],
                            to_jsonb(COALESCE(("balances"->>:currency)::numeric, 0) + CAST(:amount AS numeric)), true),
               "balance_usd" = "balance_usd" + CAST(:amount_usd AS numeric),
               "last_activity_at" = NOW(), "updatedAt" = NOW()
         WHERE "id" = :box_id
    `, {
        replacements: {
            box_id: row.box_id,
            currency: row.currency,
            amount: new Decimal(row.amount || 0).toFixed(8),
            amount_usd: new Decimal(row.amount_usd ?? 0).toFixed(8),
        },
        transaction: t,
    });
    return row;
}

class AccountingCore {
    async findOrCreateBox(name, { type = 'system' } = {}) {
        if (!name) throw new Error('[Accounting] findOrCreateBox: name required');
        if (_boxCache.has(name)) return _boxCache.get(name);
        const [box] = await DB.AccountingBox.findOrCreate({
            where: { name },
            defaults: { name, type, balances: {}, balance_usd: 0 },
        });
        return _cacheBox(box);
    }

    async isAlreadyPosted(ref_type, ref_id) {
        if (!ref_id) return false;
        const found = await DB.AccountingTransaction.findOne({ where: { ref_type, ref_id }, attributes: ['id'] });
        return !!found;
    }

    /**
     * USD equivalent at post time (FROZEN — never recomputed).
     * strict=true (write paths): throw if rate missing. strict=false (diagnostics): warn, book 0.
     * Wire `ratesLookup(currency, absAmount) → usdAmount` to your rates service.
     */
    async calcUsdEq(currency, amount, { strict = true, ratesLookup } = {}) {
        const n = parseFloat(amount);
        if (!Number.isFinite(n) || n === 0) return 0;
        if (currency === 'USD' || currency === 'USDT') return n;
        try {
            const usd = await ratesLookup(currency, Math.abs(n));
            if (!usd) throw new Error(`no rate for ${currency}`);
            return n < 0 ? -usd : usd;
        } catch (err) {
            if (strict) throw new Error(`[accounting] calcUsdEq failed for ${currency}: ${err.message}`);
            logger.warn(`[accounting] calcUsdEq: ${err.message} — booked as 0 (non-strict)`);
            return 0;
        }
    }

    /**
     * Post N entries atomically. Each: { box_id, type, currency, amount ±, amount_usd ±,
     * category, ref_type?, ref_id?, project_id?, note?, comment?, connection_id? }.
     * Multi-leg calls without connection_id get one shared generated UUID.
     */
    async createTransaction(entries, { admin_id = null } = {}) {
        if (!Array.isArray(entries) || entries.length === 0) {
            throw new Error('[Accounting] createTransaction: entries[] required');
        }
        const sharedConn = entries.length > 1 && !entries.some((e) => e.connection_id) ? uuidv4() : null;

        for (const [i, e] of entries.entries()) {
            if (!e.box_id) throw new Error(`[Accounting] entry[${i}] missing box_id`);
            if (!Number.isFinite(Number(e.amount ?? 0)) || !Number.isFinite(Number(e.amount_usd ?? 0))) {
                throw new Error(`[Accounting] entry[${i}] non-finite amount/amount_usd`);
            }
        }

        return sequelize.transaction(async (t) => {
            const inserted = [];
            for (const e of entries) {
                inserted.push(await _insertEntryAndIncrement({
                    id: uuidv4(),
                    box_id: e.box_id,
                    type: e.type,
                    currency: e.currency,
                    connection_id: e.connection_id || sharedConn || null,
                    is_exchange: !!e.is_exchange,
                    admin_id: e.admin_id || admin_id || null,
                    amount: parseFloat(new Decimal(e.amount || 0).toFixed(8)),
                    amount_usd: parseFloat(new Decimal(e.amount_usd ?? 0).toFixed(8)),
                    comment: e.comment || null,
                    note: e.note || null,
                    category: e.category || 'system',
                    ref_type: e.ref_type || null,
                    ref_id: e.ref_id || null,
                    project_id: e.project_id || null,
                }, t));
            }
            return inserted;
        });
    }
}

export const accountingCore = new AccountingCore();

// Per-domain entry builders live in their domains and follow this shape:
// export async function buildDepositEntries(deposit) {
//     if (!deposit || deposit.status !== 'success') return null;
//     if (await accountingCore.isAlreadyPosted('deposit', deposit.id)) return null;
//     const pool = await accountingCore.findOrCreateBox('wallets:invoice', { type: 'wallet_pool' });
//     const merchant = await accountingCore.findOrCreateBox(BOX_MERCHANT, { type: 'merchant' });
//     const revenue = await accountingCore.findOrCreateBox(BOX_REVENUE, { type: 'revenue' });
//     return [ { box_id: pool.id, type: 'in', ... }, { box_id: merchant.id, type: 'out', amount: -credit, ... }, ... ];
// }
