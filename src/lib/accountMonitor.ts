import { AccountUsageCache } from './accountUsageCache';
import type { AccountAdapter, AccountIdentity } from './providerAdapters';
import { missing, type AccountUsage, type Reading } from './statusModel';

/**
 * Owns one adapter's subscription and auth epoch. It can be restarted on a
 * selection boundary while retaining only its private auth change detector.
 * All callback continuations check the epoch, including late identity reads.
 */
export class AccountMonitor {
  private active = false;
  private generation = 0;
  private subscription = 0;
  private identity: AccountIdentity | undefined;
  private identityCheckedAt = -Infinity;
  private unsubscribe = () => {};
  private timer: ReturnType<typeof setInterval> | undefined;
  private work: Promise<void> | undefined;
  private publish: (reading: Reading<AccountUsage>) => void = () => {};
  private workspacePath = '';
  private onInvalidated: () => void = () => {};
  private retryTimer: ReturnType<typeof setTimeout> | undefined;
  private lease = '';

  constructor(private adapter: AccountAdapter, private cache: AccountUsageCache) {
    this.adapter = adapter.create?.() ?? adapter;
  }

  start(workspacePath: string, lease: string, publish: (reading: Reading<AccountUsage>) => void,
    onInvalidated: () => void = () => {}): void {
    this.stop();
    this.active = true;
    this.workspacePath = workspacePath;
    this.lease = lease;
    this.publish = publish;
    this.onInvalidated = onInvalidated;
    // Recheck at an actual scope boundary, never on the 5 s status tick.
    this.identityCheckedAt = -Infinity;
    const subscription = this.subscription;
    const subscribed = () => this.active && subscription === this.subscription;
    this.unsubscribe = this.adapter.subscribe?.(() => { if (subscribed()) void this.refresh(true); }, () => {
      if (!subscribed()) return;
      this.invalidate();
      this.identityCheckedAt = -Infinity;
      void this.refresh(true);
    }) ?? (() => {});
    this.timer = setInterval(() => void this.refresh(), this.adapter.intervalMs);
    void this.refresh();
  }

  private invalidate(): void {
    this.generation += 1;
    this.work = undefined;
    this.cache.clear(this.adapter.id);
    this.adapter.invalidate?.();
    this.onInvalidated();
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.publish(missing('unavailable', this.adapter.id, this.adapter.scope(this.workspacePath),
      'Account identity changed; waiting for a new reading'));
  }

  refresh(force = false): Promise<void> {
    if (!this.active) return Promise.resolve();
    if (this.work) return this.work;
    let generation = this.generation;
    const valid = () => this.active && generation === this.generation;
    const work = (async () => {
      if (this.adapter.identity && Date.now() - this.identityCheckedAt >= this.adapter.intervalMs) {
        let identity: AccountIdentity;
        try { identity = await this.adapter.identity(); }
        catch { identity = { revision: null, authenticated: null, accountId: null }; }
        if (!valid()) return;
        if ((this.identity && (identity.revision !== this.identity.revision ||
          identity.accountId !== this.identity.accountId || identity.authenticated !== this.identity.authenticated)) ||
          (!this.identity && identity.authenticated === false)) {
          this.invalidate();
          generation = this.generation;
        }
        this.identity = identity;
        this.identityCheckedAt = Date.now();
      }
      const scope = { ...this.adapter.scope(this.workspacePath), accountId: this.identity?.accountId ?? null };
      if (this.identity?.authenticated === false) {
        if (valid()) this.publish(missing('unauthenticated', this.adapter.id, scope,
          'Sign in to read account usage'));
        return;
      }
      const reading = await this.cache.read(this.adapter, scope, `${this.lease}:${generation}`, force);
      if (valid()) {
        this.publish(reading);
        clearTimeout(this.retryTimer);
        this.retryTimer = undefined;
        // Retry at the request floor instead of caching a throttled result for
        // another complete polling interval. force bypasses only the local cache;
        // the adapter still enforces its shared host request budget (GET-227).
        if (reading.retryAt !== undefined && Number.isFinite(reading.retryAt)) {
          this.retryTimer = setTimeout(() => {
            this.retryTimer = undefined;
            if (valid()) void this.refresh(true);
          }, Math.max(250, reading.retryAt - Date.now()));
        }
      }
    })().catch(() => {
      if (valid()) this.publish(missing('unavailable', this.adapter.id,
        this.adapter.scope(this.workspacePath), 'Account usage is unavailable'));
    }).finally(() => { if (this.work === work) this.work = undefined; });
    this.work = work;
    return work;
  }

  /**
   * An auth change seen while this monitor is stopped. A stopped adapter may
   * keep account state for the next selection (the Codex collector does), so
   * discard it here; a running monitor already handles its own auth events.
   */
  forget(): void {
    if (this.active) return;
    this.adapter.invalidate?.();
    this.identity = undefined;
    this.identityCheckedAt = -Infinity;
  }

  stop(): void {
    this.active = false;
    this.subscription += 1;
    this.generation += 1;
    this.work = undefined;
    this.unsubscribe();
    this.unsubscribe = () => {};
    if (this.timer !== undefined) clearInterval(this.timer);
    this.timer = undefined;
    clearTimeout(this.retryTimer);
    this.retryTimer = undefined;
    this.onInvalidated = () => {};
    this.publish = () => {};
  }
}
