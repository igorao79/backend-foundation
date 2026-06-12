// Test infrastructure for Node's built-in runner (node --test --test-isolation=process).
// HARD GUARD: refuses to run unless the DB name contains _test.
// db.js detects *_test and boots with sync({force:true}) — clean schema per process.
import { DB, sequelize } from '../db.js';

const dbName = String(process.env.DATABASE_TABLE || '');
if (!dbName.includes('_test')) {
    throw new Error(`Tests must run against a *_test database (DATABASE_TABLE="${dbName}")`);
}

export async function initTestDB() {
    // importing db.js already connected + force-synced; this is the await-point for it
    await sequelize.authenticate();
    return DB;
}

export async function cleanTables(tableNames) {
    for (const name of tableNames) {
        await sequelize.query(`TRUNCATE "${name}" CASCADE`).catch(() => {});
    }
}

export async function closeTestDB() {
    await sequelize.close();
}

// ---- fixtures: unique tags per call avoid collisions WITHOUT truncating between tests ----
let counter = 0;
export const uniqueTag = () => `${Date.now()}-${counter++}`;

export async function createTestUser(attrs = {}) {
    const tag = uniqueTag();
    return DB.User.create({
        email: attrs.email || `test-${tag}@example.com`,
        password_hash: attrs.password_hash || 'dummy',
        name: attrs.name || `Test ${tag}`,
        ...attrs,
    });
}

// Concurrency-test recipe (verifies CAS/locking code):
//   const results = await Promise.allSettled(Array.from({ length: N }, () => service.claim(...)));
//   assert.equal(results.filter(r => r.status === 'fulfilled').length, K);   // exactly K winners
//   assert.equal(new Set(winnerIds).size, K);                                // all unique
//   // + assert DB end-state matches
