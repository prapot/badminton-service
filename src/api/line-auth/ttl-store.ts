/**
 * Small in-memory key/value store with expiry, for LINE sign-in state that must survive the
 * trip through the LINE app (the callback may open in a different browser than the one that
 * started — e.g. the LINE app's own browser on iOS — so it can't live in the browser).
 *
 * In-memory is enough because prod runs a single Strapi instance (ecosystem.config.js
 * `instances: 1`); a restart only drops sign-ins that are in flight. Use a shared store
 * (DB/Redis) if this ever runs on more than one instance.
 */
export function createTtlStore<T>(ttlMs: number, maxEntries = 10_000) {
  const entries = new Map<string, { value: T; expiresAt: number }>();

  const prune = () => {
    const now = Date.now();
    for (const [key, entry] of entries) {
      if (entry.expiresAt <= now) entries.delete(key);
    }
    // still full (flood of /start calls): drop the oldest — Map keeps insertion order
    while (entries.size >= maxEntries) {
      entries.delete(entries.keys().next().value as string);
    }
  };

  return {
    set(key: string, value: T) {
      prune();
      entries.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    /** Read without consuming */
    get(key: string): T | undefined {
      const entry = entries.get(key);
      if (!entry || entry.expiresAt <= Date.now()) return undefined;
      return entry.value;
    },
    /** Read once — the entry is removed */
    take(key: string): T | undefined {
      const value = this.get(key);
      entries.delete(key);
      return value;
    },
  };
}
