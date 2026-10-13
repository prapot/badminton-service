/**
 * Realtime (Pusher) helpers.
 *
 * Channels:
 *  - `tournament-<documentId>`  event `changed`      → clients refetch; payload `{ scope: 'matches' | 'tournament' }`
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

/**
 * What clients should refetch:
 *  - `matches`    → only the match list (score entered, match created)
 *  - `tournament` → tournament + players (+ matches); also used when rankings may have changed
 */
export type ChangeScope = 'matches' | 'tournament';

// Coalesce bursts (e.g. creating a match touches teams, team players and the match itself,
// and draft/published tournament rows both fire lifecycles) into one event per tournament.
// The wider scope wins when a burst mixes both.
const DEBOUNCE_MS = 300;
const pending = new Map<string, { timer: NodeJS.Timeout; scope: ChangeScope }>();

export function notifyTournamentChanged(tournamentDocumentId: string | null | undefined, scope: ChangeScope = 'tournament') {
  if (!tournamentDocumentId || !getClient()) return;
  const existing = pending.get(tournamentDocumentId);
  if (existing) clearTimeout(existing.timer);
  const mergedScope: ChangeScope = existing?.scope === 'tournament' ? 'tournament' : scope;
  pending.set(tournamentDocumentId, {
    scope: mergedScope,
    timer: setTimeout(() => {
      pending.delete(tournamentDocumentId);
      getClient()
        ?.trigger(`tournament-${tournamentDocumentId}`, 'changed', { scope: mergedScope, at: Date.now() })
        .catch((err) => console.error('[realtime] tournament trigger failed:', err?.message || err));
    }, DEBOUNCE_MS),
  });
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
export function notifyTournamentOf(uid: string, where: Record<string, unknown> | undefined, scope: ChangeScope) {
  if (!where || !getClient()) return;
  setTimeout(() => {
    findTournamentDocumentIds(uid, where)
      .then((ids) => ids.forEach((id) => notifyTournamentChanged(id, scope)))
      .catch((err) => console.error('[realtime] resolve tournament failed:', err?.message || err));
  }, 50);
}

const MATCH_UID = 'api::match.match';

/**
 * Match create/score changes only touch the match list, except a match marked `done`,
 * which updates rankings shown with the tournament's players. Deletes and every other
 * model refresh the whole tournament.
 */
function scopeFor(uid: string, action: 'create' | 'update', result?: any): ChangeScope {
  if (uid !== MATCH_UID) return 'tournament';
  if (action === 'update' && result?.match_status === 'done') return 'tournament';
  return 'matches';
}

/**
 * DB lifecycle subscriber that emits `tournament-<id>:changed` whenever a row of the given
 * tournament-related models changes. Deletes look the tournament up before the row is gone.
 * Register it after other subscribers (e.g. ranking updates) so their writes are done first.
 */
export function subscribeTournamentRealtime(models: string[]) {
  const notifyDeleted = (event: any) =>
    (event.state.tournamentIds || []).forEach((id: string) => notifyTournamentChanged(id, 'tournament'));
  const lookupBeforeDelete = async (event: any) => {
    event.state.tournamentIds = await findTournamentDocumentIds(event.model.uid, event.params?.where).catch(() => []);
  };

  strapi.db.lifecycles.subscribe({
    models,
    afterCreate(event: any) {
      const uid = event.model.uid;
      notifyTournamentOf(uid, event.result?.id ? { id: event.result.id } : undefined, scopeFor(uid, 'create'));
    },
    afterUpdate(event: any) {
      const uid = event.model.uid;
      notifyTournamentOf(uid, event.result?.id ? { id: event.result.id } : event.params?.where, scopeFor(uid, 'update', event.result));
    },
    afterUpdateMany(event: any) {
      notifyTournamentOf(event.model.uid, event.params?.where, 'tournament');
    },
    beforeDelete: lookupBeforeDelete,
    afterDelete: notifyDeleted,
    beforeDeleteMany: lookupBeforeDelete,
    afterDeleteMany: notifyDeleted,
  });
}
