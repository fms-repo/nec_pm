// Versioned schema migrations. Every db/migrations/*.sql file runs once, in filename order,
// inside its own transaction, and is recorded in the schema_migrations table — so a
// half-applied migration is impossible and a production database always knows exactly
// which changes it has. Runs on every server start (db.init) and via `npm run migrate`.
//
// Adding a schema change: `npm run migration:new -- short-description` creates the next
// numbered file; write the SQL there. Never edit a migration that has already been applied
// anywhere — add a new one instead (an edited file is reported as "changed", not re-run).
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const MIGRATIONS_DIR = path.join(__dirname, 'migrations');

function migrationFiles() {
  return fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql')).sort();
}

// Line endings are normalized so a file checked out/unzipped on another OS keeps its checksum.
function readMigration(name) {
  const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, name), 'utf8');
  const checksum = crypto.createHash('sha256').update(sql.replace(/\r\n/g, '\n')).digest('hex');
  return { sql, checksum };
}

async function ensureTable(client) {
  await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    name        TEXT PRIMARY KEY,
    checksum    TEXT NOT NULL,
    applied_at  TEXT NOT NULL DEFAULT to_char(now() AT TIME ZONE 'UTC', 'YYYY-MM-DD HH24:MI:SS')
  )`);
}

// Applies every pending migration. Returns { applied: [names], changed: [names] }.
async function migrate(pool, { log = console.log } = {}) {
  const client = await pool.connect();
  // Session-level lock: if two app processes start at once, the second waits here and then
  // finds nothing left to apply.
  await client.query('SELECT pg_advisory_lock(hashtext($1))', ['schema-migrations']);
  try {
    await ensureTable(client);
    const done = new Map((await client.query('SELECT name, checksum FROM schema_migrations')).rows.map(r => [r.name, r.checksum]));
    const applied = [], changed = [];
    for (const name of migrationFiles()) {
      const { sql, checksum } = readMigration(name);
      if (done.has(name)) {
        if (done.get(name) !== checksum) changed.push(name);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
        await client.query('COMMIT');
      } catch (e) {
        await client.query('ROLLBACK').catch(() => {});
        throw new Error(`Migration ${name} failed and was rolled back: ${e.message}`);
      }
      applied.push(name);
      log(`  applied migration ${name}`);
    }
    for (const name of changed) {
      log(`  WARNING: migration ${name} was edited after it was applied — the change was NOT run. Put schema changes in a new migration file.`);
    }
    return { applied, changed };
  } finally {
    await client.query('SELECT pg_advisory_unlock(hashtext($1))', ['schema-migrations']).catch(() => {});
    client.release();
  }
}

// Lists every migration file with whether/when it was applied, without changing anything.
async function status(pool) {
  const client = await pool.connect();
  try {
    await ensureTable(client);
    const done = new Map((await client.query('SELECT name, checksum, applied_at FROM schema_migrations')).rows.map(r => [r.name, r]));
    const files = migrationFiles();
    const rows = files.map(name => {
      const rec = done.get(name);
      return { name, appliedAt: rec ? rec.applied_at : null, changed: !!rec && rec.checksum !== readMigration(name).checksum };
    });
    const missingFiles = [...done.keys()].filter(n => !files.includes(n)).sort();
    return { rows, missingFiles };
  } finally {
    client.release();
  }
}

module.exports = { migrate, status, MIGRATIONS_DIR };
