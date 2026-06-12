# Database: Sequelize setup, models, idempotent boot migrations, test infra

Templates: `templates/migrations.runner.js`, `templates/tests.setup.js`.

## db.js — connection & sync strategy

```js
const sequelize = new Sequelize(dbname, user, pass, {
    host, port, dialect: 'postgres',
    pool: { max: intEnv('DB_POOL_MAX', 80), min: 0, acquire: 10000, idle: 60000 },
    dialectOptions: { decimalNumbers: true /* DECIMAL precision! */, ssl: ... },
    benchmark: NODE_ENV !== 'production',
    logging: (sql, timing) => { if (typeof timing === 'number' && timing > 1000) logger.warn(`[SLOW QUERY ${timing}ms] ${sql.slice(0, 500)}`); },
});
```

**Destructive-sync guard** — wrap `sequelize.sync` so `{force:true}` only ever runs on disposable DBs:

```js
const _originalSync = sequelize.sync.bind(sequelize);
sequelize.sync = async function (options = {}) {
    const isDisposable = dbName.includes('_test') || dbName.includes('_stress');
    if (options.force && !isDisposable) throw new Error('sync({force:true}) is blocked on production database');
    return _originalSync(options);
};
```

**Sync per environment**:
- `*_test` / `*_stress` DB → `sync({ force: true })` (deterministic rebuild)
- development → `runStartupMigrations()` then `sync({ alter: true })`
- production → `runStartupMigrations()` then plain `sync()` wrapped in try/catch (one failing index must not crash boot)

**Model loading** — static imports of every model factory (avoids circular-import hell), then a registry + associations pass:

```js
import mf_User from './models/User.js';
// ... all factories
const DB = {};
for (const factory of [mf_User, /* ... */]) { const m = factory(sequelize, DataTypes); DB[m.name] = m; }
Object.values(DB).forEach((m) => m.associate?.(DB));
export { sequelize, DB };
```

## Model conventions

Factory pattern, one file per model:

```js
export default (sequelize, DataTypes) => {
    const Invoice = sequelize.define('Invoice', {
        id:        { type: DataTypes.UUID, defaultValue: DataTypes.UUIDV4, primaryKey: true },
        tenant_id: { type: DataTypes.UUID, allowNull: false, references: { model: 'Tenants', key: 'id' } },
        amount:    { type: DataTypes.DECIMAL(28, 8), allowNull: false },
        status:    { type: DataTypes.ENUM('pending', 'success', 'expired', 'failed'), defaultValue: 'pending' },
        meta:      { type: DataTypes.JSONB, allowNull: false, defaultValue: {} },
    }, {
        tableName: 'Invoices', timestamps: true,
        indexes: [{ fields: ['status'] }, { fields: ['tenant_id', 'status', 'createdAt'] }],
    });
    Invoice.associate = (models) => { Invoice.belongsTo(models.Tenant, { foreignKey: 'tenant_id', as: 'tenant' }); };
    return Invoice;
};
```

Rules: UUID PKs everywhere; `DECIMAL(28,8)` for money (never FLOAT); JSONB for flexible maps (permissions, meta) instead of schema creep; DB-level ENUMs for small fixed sets; indexes declared inline; denormalize a hot FK (e.g. `tenant_id` on ledger rows) when it kills joins in aggregates; immutable tables set `updatedAt: false`. Instance/static helpers (e.g. `User.hashPassword`, `user.checkPassword`, the constant-time `fakeCheckPassword`) live on the model.

## Idempotent boot migrations (no migration CLI)

Migrations are plain SQL strings in two arrays, run on every boot by `runStartupMigrations()`:

- **`MIGRATIONS_BASELINE`** — runs ONCE, cached behind a flag row in `SystemConfigs` (key like `db_baseline_2026_06_06`). Failures here are **fatal** (broken baseline = broken schema).
- **`MIGRATIONS_POST_BASELINE`** — runs EVERY boot; each statement idempotent; failures **logged but non-fatal** (restart is always safe).

Statement idioms:

```sql
-- column
ALTER TABLE "Invoices" ADD COLUMN IF NOT EXISTS "is_flagged" BOOLEAN NOT NULL DEFAULT false;

-- enum type
DO $$ BEGIN
   CREATE TYPE "enum_Invoices_status" AS ENUM ('pending','success','expired','failed');
EXCEPTION WHEN duplicate_object THEN null; END $$;

-- one-shot backfill guarded by information_schema
DO $$ BEGIN
    IF NOT EXISTS (SELECT 1 FROM information_schema.columns
                   WHERE table_name='Users' AND column_name='is_admin') THEN
        ALTER TABLE "Users" ADD COLUMN "is_admin" BOOLEAN NOT NULL DEFAULT true;
        UPDATE "Users" SET "is_admin" = false WHERE "is_merchant" = true;
    END IF;
END $$;

-- seed rows
INSERT INTO ... ON CONFLICT ("key") DO NOTHING;

-- partial unique index
CREATE UNIQUE INDEX IF NOT EXISTS "one_active_per_user"
    ON "Wallets" ("tenant_id","user_id","chain") WHERE "is_archived" = false;
```

Periodically fold accumulated post-baseline statements into a new baseline with a new flag key. Note: on a bloated DB, boot `sync({alter})` can take 60–95 s — document that as normal in the runbook.

## Encryption-key fingerprint check (boot)

Store `keyFingerprint()` in `SystemConfigs('encryption_key_fingerprint')` on first boot; on every boot compare. Mismatch → `process.exit(1)` unless `ALLOW_ENCRYPTION_KEY_CHANGE=true` (which logs how many encrypted rows are at risk and updates the fingerprint). This catches "someone edited ENCRYPTION_KEY in .env" before it bricks data.

## Base rows bootstrap

`ensure-base-rows.js` idempotently creates singleton/config rows (per-chain settings, the rates row, etc.) — `findOne → create if missing`, with explicit log lines. Deliberately does NOT create a superadmin (manual seed script only).

## Test infrastructure

- Node's built-in runner: `node --test --test-isolation=process`.
- Tests connect to a **separate `*_test` database**; a guard in setup refuses to run otherwise:

```js
if (!String(process.env.DATABASE_TABLE).includes('_test'))
    throw new Error('Tests must run against a *_test database');
```

- The disposable-DB detection in `db.js` makes boot do `sync({force:true})` once per process — every test process starts from a clean schema.
- Isolation inside a process: unique tags per fixture (`const tag = \`${Date.now()}-${counter++}\``) instead of truncating between tests; or `TRUNCATE "Table" CASCADE` helpers when full cleanup is needed.
- Fixtures are plain `DB.Model.create()` helpers (`makeTenantWithPool(k)`), no heavyweight factories.
- Concurrency tests use `Promise.allSettled` over N parallel service calls and assert exact winner/loser counts plus DB end-state — this is how CAS/locking code is verified.
