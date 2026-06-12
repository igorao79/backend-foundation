// Two-phase idempotent boot migrations — no migration CLI, safe to restart repeatedly.
// BASELINE runs once (flag-cached in SystemConfigs), failures FATAL.
// POST_BASELINE runs every boot, statements idempotent, failures logged but NON-fatal.
import { logger } from './src/core/logger.helper.js';

export const MIGRATIONS_BASELINE = [
    // Full schema bootstrap / heavy one-time statements. All guarded with IF NOT EXISTS anyway.
];

export const MIGRATIONS_POST_BASELINE = [
    // Idiom 1: column
    // `ALTER TABLE "Invoices" ADD COLUMN IF NOT EXISTS "is_flagged" BOOLEAN NOT NULL DEFAULT false`,

    // Idiom 2: enum type
    // `DO $$ BEGIN
    //     CREATE TYPE "enum_Invoices_status" AS ENUM ('pending','success','expired','failed');
    //  EXCEPTION WHEN duplicate_object THEN null; END $$`,

    // Idiom 3: one-shot backfill guarded by information_schema
    // `DO $$ BEGIN
    //     IF NOT EXISTS (SELECT 1 FROM information_schema.columns
    //                    WHERE table_name='Users' AND column_name='is_admin') THEN
    //         ALTER TABLE "Users" ADD COLUMN "is_admin" BOOLEAN NOT NULL DEFAULT true;
    //         UPDATE "Users" SET "is_admin" = false WHERE "is_merchant" = true;
    //     END IF;
    //  END $$`,

    // Idiom 4: seed — `INSERT ... ON CONFLICT ("key") DO NOTHING`
    // Idiom 5: index — `CREATE UNIQUE INDEX IF NOT EXISTS ... WHERE ...`
];

// Bump the date when you fold post-baseline statements into a new baseline.
const BASELINE_FLAG = 'db_baseline_2026_01_01';

export async function runStartupMigrations(sequelize) {
    await sequelize.query(`
        CREATE TABLE IF NOT EXISTS "SystemConfigs" (
            "key" VARCHAR(255) PRIMARY KEY,
            "value" TEXT,
            "createdAt" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            "updatedAt" TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`);

    const [[flagRow]] = await sequelize.query(
        `SELECT 1 FROM "SystemConfigs" WHERE "key" = :k LIMIT 1`,
        { replacements: { k: BASELINE_FLAG } },
    );

    if (!flagRow) {
        logger.info('[startup-migration] applying baseline...');
        for (const sql of MIGRATIONS_BASELINE) {
            try {
                await sequelize.query(sql);
            } catch (err) {
                logger.error('[startup-migration] BASELINE failed (fatal):', sql.slice(0, 120), err.message);
                throw err;
            }
        }
        await sequelize.query(
            `INSERT INTO "SystemConfigs" ("key","value","createdAt","updatedAt")
             VALUES (:k, :v, NOW(), NOW()) ON CONFLICT ("key") DO NOTHING`,
            { replacements: { k: BASELINE_FLAG, v: new Date().toISOString() } },
        );
    }

    for (const sql of MIGRATIONS_POST_BASELINE) {
        try {
            await sequelize.query(sql);
        } catch (err) {
            logger.error('[startup-migration:post] failed (non-fatal):', sql.slice(0, 120), err.message);
        }
    }
}

/**
 * Destructive-sync guard — wrap sequelize.sync in db.js so {force:true} only runs on disposable DBs:
 *
 *   const _originalSync = sequelize.sync.bind(sequelize);
 *   sequelize.sync = async function (options = {}) {
 *       const isDisposable = dbName.includes('_test') || dbName.includes('_stress');
 *       if (options.force && !isDisposable) throw new Error('sync({force:true}) blocked on production DB');
 *       return _originalSync(options);
 *   };
 *
 * Sync strategy: *_test → sync({force:true}); development → runStartupMigrations + sync({alter:true});
 * production → runStartupMigrations + plain sync() in try/catch (one failing index must not crash boot).
 */
