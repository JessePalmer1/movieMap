/**
 * Applies pending SQL migrations from db/migrations/, in filename order.
 *
 * db/schema.sql only runs when Postgres initialises an empty data volume, so
 * once the catalogue exists, schema changes have to arrive this way — a reset
 * would mean re-fetching 2000 films from Wikidata and 2000 plot summaries from
 * Wikipedia.
 *
 * Keep db/schema.sql in step with the migrations so a fresh clone still gets
 * the right shape in one go.
 *
 * Run: npm run db:migrate [-- --dry-run]
 */

import "./_env";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { flag } from "./_env";
import { getPool, query, transaction } from "../src/lib/db";

const MIGRATIONS_DIR = resolve(process.cwd(), "db/migrations");

async function main() {
  const dryRun = flag("dry-run");

  await query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      filename   text PRIMARY KEY,
      applied_at timestamptz NOT NULL DEFAULT now()
    )
  `);

  const applied = new Set(
    (await query<{ filename: string }>(`SELECT filename FROM schema_migrations`)).map(
      (r) => r.filename,
    ),
  );

  let files: string[];
  try {
    files = readdirSync(MIGRATIONS_DIR).filter((f) => f.endsWith(".sql")).sort();
  } catch {
    console.log(`No migrations directory at ${MIGRATIONS_DIR}. Nothing to do.`);
    await getPool().end();
    return;
  }

  const pending = files.filter((f) => !applied.has(f));
  if (pending.length === 0) {
    console.log(`Up to date — ${applied.size} migration(s) already applied.`);
    await getPool().end();
    return;
  }

  console.log(`${pending.length} pending migration(s):\n`);
  for (const filename of pending) {
    const sql = readFileSync(join(MIGRATIONS_DIR, filename), "utf8");
    if (dryRun) {
      console.log(`  ${filename} (dry run, not applied)`);
      continue;
    }
    // Each migration is one transaction: it either lands whole or not at all.
    await transaction(async (client) => {
      await client.query(sql);
      await client.query(`INSERT INTO schema_migrations (filename) VALUES ($1)`, [filename]);
    });
    console.log(`  applied ${filename}`);
  }

  await getPool().end();
}

main().catch((error) => {
  console.error("\n", (error as Error).message);
  process.exit(1);
});
