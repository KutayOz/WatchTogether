/**
 * Applies the migration SQL to a test database.
 *
 * Deliberately parses the .sql file rather than duplicating the schema in a
 * fixture — a drifting copy would let tests pass against a shape production
 * does not have. D1's `exec` is line-oriented and chokes on the comment blocks
 * in the migration, so statements are stripped and split here.
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
