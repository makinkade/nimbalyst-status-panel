import type { AccountAdapter } from './providerAdapters';
import { ageReading, missing, type AccountUsage, type Reading, type ReadingScope } from './statusModel';

interface Entry {
  adapterId: string;
  controller: AbortController;
  result?: Reading<AccountUsage>;
  finishedAt?: number;
  work?: Promise<Reading<AccountUsage>>;
}

/**
 * GET-223: cache ownership includes the auth epoch. Unknown owners also need a
 * consumer lease, so they cannot become a global "current account" cache. This
 * cache is memory-only; credentials and private auth change detectors never
 * enter its keys. Disposing a view detaches it rather than aborting another
 * consumer's shared request. Only an ownership invalidation cancels shared work.
 */
export class AccountUsageCache {
  private entries = new Map<string, Entry>();

  read(adapter: AccountAdapter, scope: ReadingScope, lease: string, force = false): Promise<Reading<AccountUsage>> {
    const key = JSON.stringify([adapter.id, scope.provider, scope.accountId ?? null,
      scope.workspacePath, scope.configSource ?? null, scope.association ?? 'unbound', lease]);
    let entry = this.entries.get(key);
    if (entry?.work) return entry.work;
    if (!force && entry?.result && entry.finishedAt !== undefined &&
      Date.now() - entry.finishedAt < adapter.intervalMs) return Promise.resolve(ageReading(entry.result));
    if (!entry) {
      entry = { adapterId: adapter.id, controller: new AbortController() };
      this.entries.set(key, entry);
    }
    const current = entry;
    const work = Promise.resolve().then(() => adapter.collect(scope, current.controller.signal))
      .catch((): Reading<AccountUsage> => missing('unavailable', adapter.id, scope, 'Account usage could not be refreshed'))
      .then((reading) => {
        // An auth change may have replaced/deleted this exact cache entry.
        if (this.entries.get(key) !== current || current.controller.signal.aborted) {
          return missing<AccountUsage>('unavailable', adapter.id, scope, 'Reading cancelled');
        }
        if (reading.scope.kind !== scope.kind || reading.scope.provider !== scope.provider || reading.scope.workspacePath !== scope.workspacePath ||
          (reading.scope.accountId ?? null) !== (scope.accountId ?? null) ||
          reading.scope.configSource !== scope.configSource || reading.scope.association !== scope.association) {
          reading = missing('unavailable', adapter.id, scope, 'The reading belongs to a different account scope');
        }
        if (reading.state === 'unavailable' && current.result?.value) {
          reading = { ...current.result, state: 'stale', value: current.result.value, reason: reading.reason };
        }
        current.result = reading;
        current.finishedAt = Date.now();
        return reading;
      })
      .finally(() => { if (this.entries.get(key) === current) current.work = undefined; });
    current.work = work;
    return work;
  }

  clear(adapterId?: string): void {
    for (const [key, entry] of this.entries) {
      if (adapterId && entry.adapterId !== adapterId) continue;
      entry.controller.abort();
      this.entries.delete(key);
    }
  }
}
