import init from "../../migrations/0001_init.sql?raw";
import passwords from "../../migrations/0002_password_credentials.sql?raw";

/**
 * Every migration, in order.
 *
 * Tests do not run `wrangler d1 migrations apply` — they build the schema in
 * process. Listing the files here rather than in each test file is what stops
 * a new migration from being invisible to four suites and applied by the
 * fifth: adding 0003 is one line, in one place.
 */
const MIGRATIONS = [init, passwords];

/**
 * Every table, child-first.
 *
 * DROP order matters less than completeness — a table missing from this list
 * survives the reset and makes the next CREATE fail with "table already
 * exists", in whichever suite happens to run second.
 */
const TABLES = [
  "password_reset_tokens",
  "password_credentials",
  "admin_audit_log",
  "revoked_tokens",
  "invitation_links",
  "passkey_credentials",
  "users",
];

/**
 * Applies the migration SQL to a test database.
 *
 * Deliberately parses the .sql file rather than duplicating the schema in a
 * fixture — a drifting copy would let tests pass against a shape production
 * does not have. D1's `exec` is line-oriented and chokes on the comment blocks
 * in the migration, so statements are stripped and split here.
 *
 * Comments are stripped before the split, so a `;` inside a `--` comment is
 * harmless. One inside a string literal would not be — keep migrations to
 * plain DDL.
 */
export async function applySchema(db: D1Database, sql: string): Promise<void> {
  const statements = sql
    .split("\n")
    .map((line) => line.replace(/--.*$/, ""))
    .join("\n")
    .split(";")
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  await db.batch(statements.map((statement) => db.prepare(statement)));
}

/** Drop everything and rebuild from the real migrations. Call in `beforeEach`. */
export async function resetDatabase(db: D1Database): Promise<void> {
  await db.batch(TABLES.map((table) => db.prepare(`DROP TABLE IF EXISTS ${table}`)));
  for (const sql of MIGRATIONS) await applySchema(db, sql);
}
