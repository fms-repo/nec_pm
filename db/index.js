// PostgreSQL access layer (node-postgres). Keeps the familiar `db.prepare(sql).get/all/run`
// shape the app was written against, but every call is async and returns a Promise:
//   await db.prepare('SELECT * FROM projects WHERE id = ?').get(id)
// SQL is written with `?` positional or `@name` named placeholders (an object argument);
// both are rewritten to Postgres' $1, $2, ... once per statement.
//
// Connection: DATABASE_URL (e.g. postgres://user:pass@localhost:5432/nec_dashboard), read from
// the environment or from a .env file in the app's root folder.
const path = require('path');
const { AsyncLocalStorage } = require('async_hooks');
const { Pool, types } = require('pg');

try { process.loadEnvFile(path.join(__dirname, '..', '.env')); } catch (e) { /* no .env file — use the real environment */ }

if (!process.env.DATABASE_URL) {
  console.error('DATABASE_URL is not set. Add it to the environment or to a .env file, e.g.\n' +
    '  DATABASE_URL=postgres://user:password@localhost:5432/nec_dashboard');
  process.exit(1);
}

// COUNT(*) / SUM(integer) come back as int8 and AVG as numeric, which pg returns as strings
// by default (to avoid precision loss past 2^53). Every value this app stores fits a JS number.
types.setTypeParser(20, v => parseInt(v, 10));   // int8
types.setTypeParser(1700, v => parseFloat(v));   // numeric

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.PG_POOL_MAX) || 10,
  // Keep connections warm between page loads so a login after a quiet spell doesn't have to
  // open a burst of brand-new connections at once.
  idleTimeoutMillis: 30000,
  // Fail fast (and retry, below) instead of waiting forever for a free/new connection.
  connectionTimeoutMillis: 10000,
  keepAlive: true
});
pool.on('error', err => console.error(new Date().toISOString(), 'PostgreSQL pool error:', err.code || '', err.message));

// Errors that mean "the database connection is momentarily unavailable", not "this query is
// wrong": too many clients, server starting/stopping, connection dropped/refused/timed out.
const TRANSIENT_PG_CODES = new Set(['53300', '57P01', '57P02', '57P03', '08000', '08001', '08003', '08004', '08006']);
const TRANSIENT_NET_CODES = new Set(['ECONNRESET', 'ECONNREFUSED', 'ETIMEDOUT', 'EPIPE', 'EAI_AGAIN']);
function isTransientError(err) {
  if (!err) return false;
  if (TRANSIENT_PG_CODES.has(err.code) || TRANSIENT_NET_CODES.has(err.code)) return true;
  return /Connection terminated|timeout exceeded when trying to connect|connection timeout/i.test(err.message || '');
}
const MAX_ATTEMPTS = 4;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const backoff = attempt => 150 * 2 ** (attempt - 1) + Math.floor(Math.random() * 100);

async function connectWithRetry() {
  for (let attempt = 1; ; attempt++) {
    try {
      return await pool.connect();
    } catch (err) {
      if (attempt >= MAX_ATTEMPTS || !isTransientError(err)) throw err;
      console.warn(new Date().toISOString(), `PostgreSQL connect failed (${err.code || err.message}), retry ${attempt}/${MAX_ATTEMPTS - 1}`);
      await sleep(backoff(attempt));
    }
  }
}

// The client of the transaction currently running (if any) — so helpers called from inside
// db.transaction() automatically take part in it without the client being passed around.
const txStore = new AsyncLocalStorage();

// Outside a transaction, a query whose connection couldn't be acquired is retried. A SELECT
// whose connection drops mid-query is retried too; anything that writes is not (the server may
// already have applied it), so it surfaces the error instead of risking doing it twice.
async function runQuery(text, values) {
  const tx = txStore.getStore();
  if (tx) return tx.query(text, values);
  const readOnly = /^\s*SELECT\b/i.test(text);
  for (let attempt = 1; ; attempt++) {
    const client = await connectWithRetry();
    try {
      const result = await client.query(text, values);
      client.release();
      return result;
    } catch (err) {
      const transient = isTransientError(err);
      client.release(transient ? err : undefined); // a broken connection is discarded, not reused
      if (!transient || !readOnly || attempt >= MAX_ATTEMPTS) throw err;
      console.warn(new Date().toISOString(), `PostgreSQL query failed (${err.code || err.message}), retry ${attempt}/${MAX_ATTEMPTS - 1}`);
      await sleep(backoff(attempt));
    }
  }
}

// Tables whose primary key isn't an `id` column, so an INSERT can't RETURNING id.
const TABLES_WITHOUT_ID = new Set(['programme_trend', 'user_accounts', 'user_project_access', 'report_run_projects', 'report_deliveries', 'notification_reads', 'project_alert_state']);

// Rewrites ? / @name placeholders to $n, skipping anything inside '...' string literals.
function compile(sql) {
  let out = '', n = 0, inStr = false;
  const names = [];
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i];
    if (ch === "'") { inStr = !inStr; out += ch; continue; }
    if (!inStr && ch === '?') { out += '$' + (++n); continue; }
    if (!inStr && ch === '@' && /[A-Za-z_]/.test(sql[i + 1] || '')) {
      let j = i + 1;
      while (j < sql.length && /\w/.test(sql[j])) j++;
      const name = sql.slice(i + 1, j);
      let idx = names.indexOf(name);
      if (idx === -1) { names.push(name); idx = names.length - 1; }
      out += '$' + (idx + 1);
      i = j - 1;
      continue;
    }
    out += ch;
  }
  const insert = /^\s*INSERT\s+INTO\s+(\w+)/i.exec(out);
  const returningId = !!insert && !TABLES_WITHOUT_ID.has(insert[1].toLowerCase()) && !/\bRETURNING\b/i.test(out);
  return { text: returningId ? `${out} RETURNING id` : out, names, returningId };
}

function bindValues(stmt, args) {
  const values = stmt.names.length
    ? stmt.names.map(name => (args[0] || {})[name])
    : args;
  return values.map(v => (v === undefined ? null : v));
}

function prepare(sql) {
  const stmt = compile(sql);
  const query = (args) => runQuery(stmt.text, bindValues(stmt, args));
  return {
    async get(...args) { return (await query(args)).rows[0]; },
    async all(...args) { return (await query(args)).rows; },
    async run(...args) {
      const result = await query(args);
      return {
        changes: result.rowCount,
        lastInsertRowid: stmt.returningId && result.rows[0] ? result.rows[0].id : undefined
      };
    }
  };
}

// Runs raw SQL (may contain several statements; no parameters).
async function exec(sql) {
  await runQuery(sql);
}

// db.transaction(async (...args) => { ... }) returns an async function that runs the body in
// BEGIN/COMMIT on one pooled client, rolling back if it throws. Nested calls join the outer one.
function transaction(fn) {
  return async function (...args) {
    if (txStore.getStore()) return fn(...args);
    const client = await connectWithRetry();
    try {
      await client.query('BEGIN');
      const result = await txStore.run(client, () => fn(...args));
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      client.release();
    }
  };
}

// Runs fn with no transaction in scope, so its queries use their own pooled connection — for
// work fired off after a response (e.g. the audit log) that may still be inside the async
// context of a transaction whose client has already been committed and released.
function outsideTransaction(fn) {
  return txStore.exit(fn);
}

// Serializes transactions that take the same lock name until they commit/roll back. Used
// where a number is derived from the rows already there (project codes, per-project document
// sequences) — SQLite ran one request at a time, Postgres runs them concurrently.
async function lock(name) {
  if (!txStore.getStore()) throw new Error('db.lock() must be called inside db.transaction()');
  await txStore.getStore().query('SELECT pg_advisory_xact_lock(hashtext($1))', [name]);
}

// Brings the schema up to date by applying any pending db/migrations/*.sql (see migrate.js).
async function init(opts) {
  return require('./migrate').migrate(pool, opts);
}

async function close() {
  await pool.end();
}

module.exports = { prepare, exec, transaction, lock, outsideTransaction, init, close, pool, isTransientError };
