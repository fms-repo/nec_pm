// Standalone migration runner for the PostgreSQL database in DATABASE_URL. Applies any pending
// db/migrations/*.sql files (each once, in its own transaction) and exits. Never seeds data, so
// it is safe to run against production.
//
// Usage (from the app's root folder):
//   npm run migrate              -- apply pending migrations
//   npm run migrate -- --status  -- list migrations and whether each is applied; changes nothing
const db = require('./index');
const { status } = require('./migrate');

async function printStatus() {
  const { rows, missingFiles } = await status(db.pool);
  console.log('Migrations:');
  for (const r of rows) {
    console.log(`  ${r.appliedAt ? `applied ${r.appliedAt}` : 'PENDING            '}  ${r.name}${r.changed ? '  (edited after it was applied!)' : ''}`);
  }
  for (const name of missingFiles) console.log(`  applied, but the file is missing: ${name}`);
  const pending = rows.filter(r => !r.appliedAt).length;
  console.log(pending ? `${pending} pending — run: npm run migrate` : 'Database is up to date.');
}

async function main() {
  if (process.argv.includes('--status')) return printStatus();
  console.log('Applying migrations to PostgreSQL ...');
  const { applied } = await db.init();
  console.log(applied.length ? `Done — ${applied.length} migration(s) applied.` : 'Nothing to do — database is up to date.');
  const { n } = await db.prepare('SELECT COUNT(*) AS n FROM projects').get();
  console.log(`  projects: ${n} rows (existing data is never changed by this command unless a migration says so)`);
}

main()
  .catch(e => { console.error('Migration failed:', e.message); process.exitCode = 1; })
  .finally(() => db.close());
