import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const trigger = vi.fn(() => Promise.resolve());
vi.mock('pusher', () => ({
  default: vi.fn(function () {
    return { trigger, triggerBatch: vi.fn(() => Promise.resolve()) };
  }),
}));

const findMany = vi.fn();
let inTransaction = false;
(globalThis as any).strapi = {
  db: {
    inTransaction: () => inTransaction,
    query: () => ({ findMany }),
  },
};

process.env.PUSHER_APP_ID = 'app';
process.env.PUSHER_KEY = 'key';
process.env.PUSHER_SECRET = 'secret';
process.env.PUSHER_CLUSTER = 'ap1';

const { notifyTournamentOf } = await import('./realtime');

describe('notifyTournamentOf', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    inTransaction = false;
    trigger.mockClear();
    findMany.mockReset().mockResolvedValue([{ tournament_id: { documentId: 't1' } }]);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('looks the tournament up and pushes a changed event', async () => {
    notifyTournamentOf('api::match.match', { id: 1 }, 'matches');
    await vi.advanceTimersByTimeAsync(50); // lookup
    await vi.advanceTimersByTimeAsync(300); // debounce
    expect(findMany).toHaveBeenCalledTimes(1);
    expect(trigger).toHaveBeenCalledWith('tournament-t1', 'changed', expect.objectContaining({ scope: 'matches' }));
  });

  it('waits for the caller transaction to finish before querying', async () => {
    inTransaction = true;
    notifyTournamentOf('api::match.match', { id: 1 }, 'matches');
    await vi.advanceTimersByTimeAsync(500);
    // Querying now would join a transaction that is about to commit
    expect(findMany).not.toHaveBeenCalled();

    inTransaction = false;
    await vi.advanceTimersByTimeAsync(50);
    expect(findMany).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(300);
    expect(trigger).toHaveBeenCalledWith('tournament-t1', 'changed', expect.objectContaining({ scope: 'matches' }));
  });

  it('gives up on a transaction that never finishes', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    inTransaction = true;
    notifyTournamentOf('api::match.match', { id: 1 }, 'matches');
    await vi.advanceTimersByTimeAsync(31_000);
    expect(findMany).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalledWith('[realtime] resolve tournament skipped: transaction still open');
    const pending = vi.getTimerCount();
    expect(pending).toBe(0);
    error.mockRestore();
  });
});
