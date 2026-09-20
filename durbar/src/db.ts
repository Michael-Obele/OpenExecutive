/**
 * SQLite access via `bun:sqlite` — no external driver, no ORM.
 *
 * The reference implementation reached for ChromaDB plus a local ONNX embedding
 * model to do retrieval over a few dozen Markdown files, which cost ~3.8 GB of
 * torch/CUDA in the image. SQLite's FTS5 covers that corpus in the same file as
 * the relational data, so retrieval and state share one artefact to back up.
 */

import { Database } from 'bun:sqlite';
import { MIGRATIONS } from './schema.ts';

export type Db = Database;

/** Opens a database and brings it up to the current schema version. */
export function openDb(path = ':memory:'): Db {
  const db = new Database(path, { create: true });
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  migrate(db);
  return db;
}

/**
 * Applies any migration whose id is not yet recorded.
 *
 * Every statement is `IF NOT EXISTS`, so re-running is harmless; the recorded
 * ids exist to make *intent* visible (which migrations have run) rather than to
 * guard correctness. The whole thing runs in one transaction so a failure part
 * way through cannot leave a half-built schema behind.
 */
export function migrate(db: Db): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);

  const applied = new Set(
    db
      .query<{ id: number }, []>('SELECT id FROM schema_migrations')
      .all()
      .map((row) => row.id),
  );

  for (const migration of MIGRATIONS) {
    if (applied.has(migration.id)) continue;

    const run = db.transaction(() => {
      for (const statement of migration.statements) db.exec(statement);
      db.run(
        'INSERT INTO schema_migrations (id, name, applied_at) VALUES (?, ?, ?)',
        [migration.id, migration.name, new Date().toISOString()],
      );
    });
    run();
  }
}

if (import.meta.main) {
  const path = process.env['DURBAR_DB_PATH'] ?? './durbar.db';
  const db = openDb(path);
  const tables = db
    .query<{ name: string }, []>(
      `SELECT name FROM sqlite_master WHERE type='table'
       AND name NOT LIKE 'sqlite_%' ORDER BY name`,
    )
    .all()
    .map((row) => row.name);
  console.log(`initialised ${path}`);
  console.log(`tables (${tables.length}): ${tables.join(', ')}`);
  db.close();
}
