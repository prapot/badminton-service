/**
 * Realtime (Pusher) helpers.
 *
 * Channels:
 *  - `tournament-<documentId>`  event `changed`      → clients refetch the tournament (no payload data)
 *  - `user-<userId>`            event `match-alert`  → "your match is up" popup for that player
 *
 * All triggers are fire-and-forget: a Pusher outage must never fail or slow down an API request.
 */
import Pusher from 'pusher';

let client: Pusher | null | undefined;

function getClient(): Pusher | null {
  if (client !== undefined) return client;
  const { PUSHER_APP_ID, PUSHER_KEY, PUSHER_SECRET, PUSHER_CLUSTER } = process.env;
  if (!PUSHER_APP_ID || !PUSHER_KEY || !PUSHER_SECRET || !PUSHER_CLUSTER) {
    console.warn('[realtime] PUSHER_* env not set — realtime events disabled');
    client = null;
    return client;
  }
  client = new Pusher({
    appId: PUSHER_APP_ID,
    key: PUSHER_KEY,
    secret: PUSHER_SECRET,
    cluster: PUSHER_CLUSTER,
    useTLS: true,
  });
  return client;
}

// Coalesce bursts (e.g. creating a match touches teams, team players and the match itself,
// and draft/published tournament rows both fire lifecycles) into one event per tournament.
const DEBOUNCE_MS = 300;
const pending = new Map<string, NodeJS.Timeout>();

export function notifyTournamentChanged(tournamentDocumentId: string | null | undefined) {
  if (!tournamentDocumentId || !getClient()) return;
  const existing = pending.get(tournamentDocumentId);
  if (existing) clearTimeout(existing);
  pending.set(
    tournamentDocumentId,
    setTimeout(() => {
      pending.delete(tournamentDocumentId);
      getClient()
        ?.trigger(`tournament-${tournamentDocumentId}`, 'changed', { at: Date.now() })
        .catch((err) => console.error('[realtime] tournament trigger failed:', err?.message || err));
    }, DEBOUNCE_MS)
  );
}

export interface MatchAlertPlayer {
  id: number;
  name: string;
}

export function notifyMatchAlert(matchId: number, teamA: MatchAlertPlayer[], teamB: MatchAlertPlayer[]) {
  const pusher = getClient();
  if (!pusher) return;
  // Guests have negative ids and no user channel.
  const userIds = [...teamA, ...teamB].map((p) => p.id).filter((id) => id > 0);
  if (userIds.length === 0) return;
  const data = { matchId, teamA, teamB };
  pusher
    .triggerBatch(userIds.map((id) => ({ channel: `user-${id}`, name: 'match-alert', data })))
    .catch((err) => console.error('[realtime] match-alert trigger failed:', err?.message || err));
}

/**
 * Find the tournament documentIds of the rows matching `where` in a tournament-related model.
 * Runs outside the caller's transaction.
 */
export async function findTournamentDocumentIds(uid: string, where: Record<string, unknown>): Promise<string[]> {
  if (!where) return [];
  if (uid === 'api::tournament.tournament') {
    const rows = (await strapi.db.query(uid as any).findMany({ where, select: ['documentId'] })) as any[];
    return [...new Set(rows.map((r) => r.documentId).filter(Boolean))];
  }
  const rows = (await strapi.db.query(uid as any).findMany({
    where,
    populate: { tournament_id: { select: ['documentId'] } },
  })) as any[];
  return [...new Set(rows.map((r) => r.tournament_id?.documentId).filter(Boolean))];
}

/** Deferred lookup + notify, so rows written inside a transaction are visible once it commits. */
export function notifyTournamentOf(uid: string, where: Record<string, unknown> | undefined) {
  if (!where || !getClient()) return;
  setTimeout(() => {
    findTournamentDocumentIds(uid, where)
      .then((ids) => ids.forEach(notifyTournamentChanged))
      .catch((err) => console.error('[realtime] resolve tournament failed:', err?.message || err));
  }, 50);
}

/**
 * DB lifecycle subscriber that emits `tournament-<id>:changed` whenever a row of the given
 * tournament-related models changes. Deletes look the tournament up before the row is gone.
 */
export function subscribeTournamentRealtime(models: string[]) {
  strapi.db.lifecycles.subscribe({
    models,
    afterCreate(event: any) {
      notifyTournamentOf(event.model.uid, event.result?.id ? { id: event.result.id } : undefined);
    },
    afterUpdate(event: any) {
      notifyTournamentOf(event.model.uid, event.result?.id ? { id: event.result.id } : event.params?.where);
    },
    afterUpdateMany(event: any) {
      notifyTournamentOf(event.model.uid, event.params?.where);
    },
    async beforeDelete(event: any) {
      event.state.tournamentIds = await findTournamentDocumentIds(event.model.uid, event.params?.where).catch(() => []);
    },
    afterDelete(event: any) {
      (event.state.tournamentIds || []).forEach(notifyTournamentChanged);
    },
    async beforeDeleteMany(event: any) {
      event.state.tournamentIds = await findTournamentDocumentIds(event.model.uid, event.params?.where).catch(() => []);
    },
    afterDeleteMany(event: any) {
      (event.state.tournamentIds || []).forEach(notifyTournamentChanged);
    },
  });
}
