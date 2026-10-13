/**
 * DB-level guarantee that one LINE account links to at most one user. The schema attribute
 * can't express this (Strapi's `unique` is only checked by the document service, and the
 * LINE controller writes through strapi.db.query), so the index is created on every boot —
 * idempotent, and re-created if a schema sync ever drops it. NULLs (unlinked users) are
 * allowed multiple times in both SQLite and Postgres.
 */
export const LINE_USER_ID_INDEX = 'up_users_line_user_id_unique';

export async function ensureLineUserIdUniqueIndex(strapi: any) {
  try {
    await strapi.db.connection.raw(
      `CREATE UNIQUE INDEX IF NOT EXISTS ${LINE_USER_ID_INDEX} ON up_users (line_user_id)`
    );
  } catch (e) {
    // e.g. existing duplicates — keep the app running; the controller still checks before writing
    strapi.log.error(`[LINE] could not create ${LINE_USER_ID_INDEX}: ${e.message}`);
  }
}

/** The index rejected a write (Postgres reports the index name, SQLite the column) */
export function isLineUserIdConflict(e: any): boolean {
  return e?.constraint === LINE_USER_ID_INDEX || /line_user_id/.test(e?.message || '');
}
