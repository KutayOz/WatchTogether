/**
 * How many ways into an account there are.
 *
 * One place, because the rule it serves — you may not remove your last way in —
 * is enforced from two directions (deleteCredential for passkeys,
 * deletePasswordCredential for the password) and would drift the moment each
 * side counted for itself.
 *
 * Until passwords existed this was just `listCredentials().length`, and
 * credentials.ts said as much: with no fallback, deleting the final passkey
 * locked the account out permanently. There is a fallback now, so the question
 * is no longer "how many passkeys" but "how many credentials of any kind".
 */
export interface SignInMethods {
  passkeys: number;
  hasPassword: boolean;
  total: number;
}

export async function countSignInMethods(
  db: D1Database,
  userId: string,
): Promise<SignInMethods> {
  // Two correlated subqueries rather than two round trips: both are point
  // lookups on indexed columns and this sits on the credential-deletion path.
  const row = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM passkey_credentials  WHERE user_id = ?1) AS passkeys,
              (SELECT COUNT(*) FROM password_credentials WHERE user_id = ?1) AS passwords`,
    )
    .bind(userId)
    .first<{ passkeys: number; passwords: number }>();

  const passkeys = row?.passkeys ?? 0;
  const passwords = row?.passwords ?? 0;

  return { passkeys, hasPassword: passwords > 0, total: passkeys + passwords };
}
