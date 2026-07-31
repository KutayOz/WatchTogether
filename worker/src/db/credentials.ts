export interface CredentialRow {
  credential_id: string;
  user_id: string;
  public_key: string;
  counter: number;
  transports: string | null;
  aaguid: string | null;
  backup_eligible: number;
  backed_up: number;
  label: string;
  registered_at: number;
  last_used_at: number | null;
}

export interface NewCredential {
  credentialId: string;
  userId: string;
  publicKey: string;
  counter: number;
  transports: string[] | undefined;
  aaguid: string | undefined;
  backupEligible: boolean;
  backedUp: boolean;
  label: string;
}

/**
 * Build the credential insert as a prepared statement so the caller can batch
 * it with the user insert — D1's batch is a single transaction, so a user can
 * never be created without their first passkey.
 */
export function insertCredentialStatement(db: D1Database, credential: NewCredential) {
  return db
    .prepare(
      `INSERT INTO passkey_credentials
         (credential_id, user_id, public_key, counter, transports, aaguid,
          backup_eligible, backed_up, label, registered_at)
       VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)`,
    )
    .bind(
      credential.credentialId,
      credential.userId,
      credential.publicKey,
      credential.counter,
      credential.transports ? JSON.stringify(credential.transports) : null,
      credential.aaguid ?? null,
      credential.backupEligible ? 1 : 0,
      credential.backedUp ? 1 : 0,
      credential.label,
      Date.now(),
    );
}

export async function insertCredential(db: D1Database, credential: NewCredential): Promise<void> {
  await insertCredentialStatement(db, credential).run();
}

/**
 * Look up by credential id.
 *
 * The primary key does the work — in Mongo this field lived in an unindexed
 * array embedded on the user document, so every login scanned the collection.
 */
export function getCredentialById(
  db: D1Database,
  credentialId: string,
): Promise<CredentialRow | null> {
  return db
    .prepare("SELECT * FROM passkey_credentials WHERE credential_id = ?")
    .bind(credentialId)
    .first<CredentialRow>();
}

export async function listCredentials(
  db: D1Database,
  userId: string,
): Promise<CredentialRow[]> {
  const { results } = await db
    .prepare("SELECT * FROM passkey_credentials WHERE user_id = ? ORDER BY registered_at")
    .bind(userId)
    .all<CredentialRow>();
  return results;
}

/** Advance the signature counter. Fresh counter values are clone evidence. */
export async function updateCredentialCounter(
  db: D1Database,
  credentialId: string,
  counter: number,
): Promise<void> {
  await db
    .prepare(
      "UPDATE passkey_credentials SET counter = ?, last_used_at = ? WHERE credential_id = ?",
    )
    .bind(counter, Date.now(), credentialId)
    .run();
}

/**
 * Delete one credential, refusing to remove a user's last.
 *
 * With passwords gone there is no fallback: deleting the final passkey would
 * lock the account out permanently with no recovery path.
 */
export async function deleteCredential(
  db: D1Database,
  userId: string,
  credentialId: string,
): Promise<"deleted" | "not_found" | "last_credential"> {
  const owned = await listCredentials(db, userId);
  if (!owned.some((credential) => credential.credential_id === credentialId)) return "not_found";
  if (owned.length <= 1) return "last_credential";

  await db
    .prepare("DELETE FROM passkey_credentials WHERE credential_id = ? AND user_id = ?")
    .bind(credentialId, userId)
    .run();

  return "deleted";
}

export function parseTransports(row: CredentialRow): string[] | undefined {
  if (!row.transports) return undefined;
  try {
    const parsed = JSON.parse(row.transports);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}
