// Creates the next migration file: db/migrations/<today>-<nnn>-<description>.sql
//   npm run migration:new -- add-project-region
const fs = require('fs');
const path = require('path');
const { MIGRATIONS_DIR } = require('./migrate');

const slug = process.argv.slice(2).join('-').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
if (!slug) {
  console.error('Give the migration a short description, e.g.: npm run migration:new -- add-project-region');
  process.exit(1);
}
const d = new Date();
const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
// Global running number, so files always sort in the order they were created.
const last = fs.readdirSync(MIGRATIONS_DIR).filter(f => f.endsWith('.sql'))
  .map(f => parseInt((/^\d{4}-\d{2}-\d{2}-(\d{3})-/.exec(f) || [])[1], 10)).filter(Number.isFinite);
const seq = String((last.length ? Math.max(...last) : 0) + 1).padStart(3, '0');
const name = `${today}-${seq}-${slug}.sql`;
fs.writeFileSync(path.join(MIGRATIONS_DIR, name), `-- Migration ${today}-${seq}: ${slug.replace(/-/g, ' ')}
-- Runs once, inside a transaction (if any statement fails, none of it is applied).
-- Example: ALTER TABLE projects ADD COLUMN IF NOT EXISTS region TEXT;

`);
console.log(`Created db/migrations/${name}`);
