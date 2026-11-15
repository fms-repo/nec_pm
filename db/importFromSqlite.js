// One-time copy of the old SQLite database (data/water-rehab.db) into PostgreSQL.
//
// Usage (from the app's root folder, with DATABASE_URL set):
//   npm run import-sqlite                      -- imports data/water-rehab.db
//   npm run import-sqlite -- path/to/file.db   -- imports another SQLite file
//   add --replace to wipe a PostgreSQL database that already has data before importing
//
// The SQLite file is never modified: a snapshot is taken with VACUUM INTO (which also picks
// up anything still in the -wal file), the legacy SQLite migrations bring that snapshot up
// to the final SQLite schema, and it is then copied table by table — keeping every id, so
// document numbers, links and uploaded-file folders (uploads/<project id>/) stay valid.
// Everything is written in one transaction: on any error nothing is imported.
const path = require('path');
const fs = require('fs');
const os = require('os');
const { DatabaseSync } = require('node:sqlite');
const db = require('./index');

// Parents before children, so every foreign key already exists when a row is inserted.
const TABLE_ORDER = [
  'governorates', 'project_types', 'contractors', 'business_units', 'team_members',
  'projects', 'risks', 'issues', 'milestones', 'programme_trend',
  'project_events', 'project_materials', 'project_crews',
  'invoices', 'invoice_items', 'project_documents', 'completion_certificates', 'vowd_statements',
  'change_requests', 'change_analyses', 'change_decisions',
  'project_members', 'project_governorates', 'project_subcontractors',
  'project_external_parties', 'project_resource_groups', 'project_resource_group_entries'
];
const INT_TYPES = new Set(['integer', 'bigint', 'smallint']);
const FLOAT_TYPES = new Set(['double precision', 'real', 'numeric']);

class ImportError extends Error {}
function fail(message) {
  throw new ImportError(message);
}

function snapshotSqlite(sourcePath) {
  const snapPath = path.join(os.tmpdir(), `water-rehab-import-${process.pid}-${Date.now()}.db`);
  const src = new DatabaseSync(sourcePath, { readOnly: true });
  src.exec(`VACUUM INTO '${snapPath.replace(/'/g, "''")}'`);
  src.close();
  const snap = new DatabaseSync(snapPath);
  snap.exec('PRAGMA foreign_keys = ON');
  snap.transaction = function (fn) {
    return function (...args) {
      snap.exec('BEGIN');
      try { const r = fn(...args); snap.exec('COMMIT'); return r; } catch (e) { snap.exec('ROLLBACK'); throw e; }
    };
  };
  // Same steps the SQLite version of the app ran on every start, so an older file imports too.
  snap.exec(fs.readFileSync(path.join(__dirname, 'sqlite-legacy', 'schema.sql'), 'utf8'));
  require('./sqlite-legacy/migrate')(snap);
  return { snap, snapPath };
}

// Converts one SQLite value to what the PostgreSQL column accepts, or throws.
function coerce(value, col, table) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') value = Number(value);
  if (INT_TYPES.has(col.data_type)) {
    const n = typeof value === 'number' ? value : (String(value).trim() === '' ? NaN : Number(value));
    if (!Number.isInteger(n)) {
      if (String(value).trim() === '' && col.is_nullable === 'YES') return null;
      throw new Error(`${table}.${col.column_name} holds "${value}", which is not a whole number`);
    }
    return n;
  }
  if (FLOAT_TYPES.has(col.data_type)) {
    const n = typeof value === 'number' ? value : (String(value).trim() === '' ? NaN : Number(value));
    if (!Number.isFinite(n)) {
      if (String(value).trim() === '' && col.is_nullable === 'YES') return null;
      throw new Error(`${table}.${col.column_name} holds "${value}", which is not a number`);
    }
    return n;
  }
  if (value instanceof Uint8Array) throw new Error(`${table}.${col.column_name} holds binary data, which this app never stores`);
  return String(value);
}

async function main() {
  const args = process.argv.slice(2);
  const replace = args.includes('--replace');
  const sourceArg = args.find(a => !a.startsWith('--'));
  const sourcePath = path.resolve(sourceArg || path.join(__dirname, '..', 'data', 'water-rehab.db'));
  if (!fs.existsSync(sourcePath)) fail(`SQLite file not found: ${sourcePath}`);

  console.log(`Source (SQLite):   ${sourcePath}`);
  console.log(`Target (Postgres): ${process.env.DATABASE_URL.replace(/:\/\/([^:@/]+):[^@]*@/, '://$1:****@')}`);

  const { snap, snapPath } = snapshotSqlite(sourcePath);
  try {
    const sqliteTables = snap.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").all().map(r => r.name);
    const unknown = sqliteTables.filter(t => !TABLE_ORDER.includes(t));
    if (unknown.length) fail(`the SQLite file has tables this version doesn't know about: ${unknown.join(', ')}`);

    await db.init();

    const pgColumns = {};
    for (const r of await db.prepare(`SELECT table_name, column_name, data_type, is_nullable FROM information_schema.columns
        WHERE table_schema = current_schema() ORDER BY table_name, ordinal_position`).all()) {
      (pgColumns[r.table_name] ??= []).push(r);
    }

    // Refuse to import on top of existing data unless --replace was given.
    const nonEmpty = [];
    for (const t of TABLE_ORDER) {
      const { n } = await db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get();
      if (n > 0) nonEmpty.push(`${t} (${n})`);
    }
    if (nonEmpty.length && !replace) {
      fail(`the PostgreSQL database already has data in: ${nonEmpty.join(', ')}.\n` +
        'Run again with --replace to wipe it and import the SQLite data in its place.');
    }

    // Column check: every SQLite column must have somewhere to go.
    const plan = [];
    for (const t of TABLE_ORDER) {
      const targetCols = pgColumns[t];
      if (!targetCols) fail(`table ${t} is missing in PostgreSQL`);
      if (!sqliteTables.includes(t)) { plan.push({ table: t, cols: [], rows: [] }); continue; }
      const sourceCols = snap.prepare(`PRAGMA table_info(${t})`).all().map(c => c.name);
      const missing = sourceCols.filter(c => !targetCols.some(tc => tc.column_name === c));
      if (missing.length) fail(`PostgreSQL table ${t} has no column for SQLite column(s): ${missing.join(', ')}`);
      const cols = targetCols.filter(tc => sourceCols.includes(tc.column_name));
      const rows = snap.prepare(`SELECT ${cols.map(c => `"${c.column_name}"`).join(', ')} FROM ${t} ORDER BY ${cols.some(c => c.column_name === 'id') ? 'id' : 'rowid'}`).all();
      plan.push({ table: t, cols, rows });
    }

    // SQLite AUTOINCREMENT never reuses the id of a deleted row; carry its counters over so new
    // rows get exactly the ids the SQLite version would have given them.
    const sqliteSeq = {};
    if (snap.prepare("SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence'").get()) {
      for (const r of snap.prepare('SELECT name, seq FROM sqlite_sequence').all()) sqliteSeq[r.name] = Number(r.seq) || 0;
    }

    const client = await db.pool.connect();
    try {
      await client.query('BEGIN');
      if (nonEmpty.length) {
        console.log('\n--replace: clearing existing PostgreSQL data...');
        await client.query(`TRUNCATE ${TABLE_ORDER.join(', ')} RESTART IDENTITY CASCADE`);
      }
      console.log('');
      for (const { table, cols, rows } of plan) {
        const BATCH = 200;
        for (let i = 0; i < rows.length; i += BATCH) {
          const chunk = rows.slice(i, i + BATCH);
          const values = [];
          const tuples = chunk.map(row => '(' + cols.map(c => {
            values.push(coerce(row[c.column_name], c, table));
            return '$' + values.length;
          }).join(', ') + ')');
          await client.query(`INSERT INTO ${table} (${cols.map(c => c.column_name).join(', ')}) VALUES ${tuples.join(', ')}`, values);
        }
        // Identity columns: continue numbering after the highest id SQLite ever handed out.
        if (pgColumns[table].some(c => c.column_name === 'id')) {
          await client.query(`SELECT setval(pg_get_serial_sequence('${table}', 'id'), GREATEST(COALESCE((SELECT MAX(id) FROM ${table}), 0), $1::integer) + 1, false)`,
            [sqliteSeq[table] || 0]);
        }
        const { rows: [{ n }] } = await client.query(`SELECT COUNT(*) AS n FROM ${table}`);
        if (n !== rows.length) throw new Error(`${table}: expected ${rows.length} rows after import, found ${n}`);
        console.log(`  ${table.padEnd(32)} ${String(rows.length).padStart(6)} rows`);
      }
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK').catch(() => {});
      fail(`${e.message}\nNothing was written to PostgreSQL.`);
    } finally {
      client.release();
    }
    console.log('\nImport complete. Start the app with: npm start');
  } finally {
    snap.close();
    fs.rmSync(snapPath, { force: true });
    await db.close();
  }
}

main().catch(e => {
  console.error(`\nImport aborted: ${e instanceof ImportError ? e.message : (e.stack || e.message)}`);
  process.exitCode = 1;
});
