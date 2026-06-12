# Ledger: double-entry accounting core

Template: `templates/accounting.core.js`. Use this whenever the service tracks money/credits internally.

## Model

- **Box** = named multi-currency money container: `AccountingBox { name UNIQUE, type, balances JSONB {"USDT":"500.00",...}, balance_usd DECIMAL(28,8), last_activity_at }`. Canonical names are constants (`BOX_MERCHANT = 'merchant'`, `BOX_REVENUE = 'gateway_revenue'`, pool boxes per wallet mode, …).
- **Entry** = signed amount posted to one box: `AccountingTransaction { box_id, type in/out/transfer/exchange/adjustment, currency, amount ±DECIMAL, amount_usd ±DECIMAL (frozen at post time), connection_id (links legs), category, ref_type, ref_id, project_id (denormalized), note JSONB, comment, admin_id }`. `updatedAt: false` — entries are immutable.
- A domain event posts **multiple legs atomically** (e.g. a settled deposit = +pool, −merchant-liability, +revenue).

## Core invariants

1. **Idempotency on `(ref_type, ref_id, box_id, category)`** — posting the same domain event twice is a no-op (`findOrCreate`; if not created, skip the balance increment too). Public helper: `isAlreadyPosted(ref_type, ref_id)`.
2. **All-or-nothing**: `createTransaction(entries)` runs inside one `sequelize.transaction`.
3. **Precision**: amounts normalized via Decimal.js to strings, accumulation happens **in SQL**, never JS floats:

```sql
UPDATE "AccountingBoxes"
   SET "balances" = jsonb_set(COALESCE("balances",'{}'::jsonb), ARRAY[:currency],
                    to_jsonb(COALESCE(("balances"->>:currency)::numeric, 0) + CAST(:amount AS numeric)), true),
       "balance_usd" = "balance_usd" + CAST(:amount_usd AS numeric),
       "last_activity_at" = NOW(), "updatedAt" = NOW()
 WHERE "id" = :box_id
```

4. **Frozen USD**: `amount_usd` is computed at post time and never recomputed — a later rate change must not move historical books. `calcUsdEq(currency, amount, { strict })`: strict mode (default, write paths) throws when a rate is missing; non-strict (read-only diagnostics) logs and books 0.
5. **Auto-linking**: multi-leg calls without explicit `connection_id` get one shared generated UUID.
6. **Pre-post guard**: reject any entry with missing `box_id` or non-finite `amount`/`amount_usd` BEFORE the transaction opens.

## createTransaction shape

```js
await accountingCore.createTransaction([
    { box_id: poolBox.id,     type: 'in',  currency, amount: +native, amount_usd: +usd,
      ref_type: 'deposit', ref_id: deposit.id, category: 'deposit_settled', project_id, note: { tx_hash } },
    { box_id: merchantBox.id, type: 'out', currency: 'USD', amount: -credit, amount_usd: -credit,
      ref_type: 'deposit', ref_id: deposit.id, category: 'merchant_credit', project_id },
    { box_id: revenueBox.id,  type: 'in',  currency, amount: +cutNative, amount_usd: +cutUsd,
      ref_type: 'deposit', ref_id: deposit.id, category: 'commission_in', project_id },
]);
```

## Entry builders per domain

The kernel knows nothing about deposits/withdrawals. Each domain exports a builder (`buildDepositEntries(deposit)`, `buildWithdrawalEntries(request)`) that:
1. guards on final status (`!== 'success'` → null) and `isAlreadyPosted` → null,
2. computes the legs (Decimal.js for the splits),
3. `findOrCreateBox(...)` for each box (boxes auto-create; results cached in a Map),
4. returns the entries array; the caller posts via `createTransaction`.

## Derived virtual balances

Tenant-facing balance is a QUERY, not a stored counter:

```
balance = SUM(credits WHERE status='success') − SUM(debits WHERE status NOT IN ('rejected','cancelled'))
```

One helper owns this formula; nothing else rolls its own SUM. Rejecting a withdrawal automatically "restores" balance because the query excludes rejected rows — no compensating write needed.

## Reconciliation

A periodic (e.g. hourly, single-instance) `checkAnomalies({ threshold_usd, autoFix })` recomputes box balances from entries and compares to stored values; small drifts auto-fix with an `adjustment` entry, large ones alert for manual review. Capture box balances before/after every deploy — they must be identical.

## Frozen-amounts pattern (beyond the ledger)

Any value computed from mutable config (commission %, rates) that settlement will need later gets **frozen on the row at create time** (e.g. `expected_credit` on the invoice). Settlement reads the frozen value instead of recomputing — config changes between creation and settlement must not move money.
