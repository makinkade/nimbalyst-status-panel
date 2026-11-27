/**
 * GET-227: real DOM/React checks with no added DOM emulation dependency.
 * Run npm run verify:ui, open /scripts/verify-ui.html, and read the results.
 * All storage, timers and network calls here are isolated synthetic inputs.
 */
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { ConfigChip } from '../components/ConfigChip';
import { useSegmentConfig, type PanelStorage } from '../useSegmentConfig';
import { DEFAULT_CONFIG, SEGMENT_LABELS, SEGMENT_DESCRIPTIONS, type SegmentConfig } from '../segments';
import { useUpdateCheck } from '../useUpdateCheck';
import { __resetThrottleForTests } from '../lib/releaseCheck';
import '../styles.css';

(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const results: { name: string; passed: boolean; error?: string }[] = [];
const target = document.querySelector('#root')!;
let root: Root;
function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}
async function check(name: string, run: () => Promise<void>) {
  root = createRoot(target);
  try { await run(); results.push({ name, passed: true }); }
  catch (error) { results.push({ name, passed: false, error: String(error) }); }
  finally { await act(async () => root.unmount()); }
}
async function click(element: Element | null) {
  if (!(element instanceof HTMLElement)) throw new Error('Missing clickable element');
  await act(async () => element.click());
}
function row(name: string) {
  return [...document.querySelectorAll('.sp-popover-row')].find((el) => el.textContent?.includes(name));
}
let latestConfig: SegmentConfig;
let label = 'Synthetic primary bucket';
function ConfigHarness({ storage }: { storage: PanelStorage }) {
  const { config, update, reset } = useSegmentConfig(storage);
  latestConfig = config;
  return <ConfigChip config={config} onChange={update} onReset={reset}
    labels={{ ...SEGMENT_LABELS, usagePrimary: label }}
    descriptions={{ ...SEGMENT_DESCRIPTIONS, usagePrimary: 'Synthetic window description' }} />;
}

/** Deterministic browser timer scheduler; React still mounts in the actual DOM. */
function clock() {
  const original = { setTimeout: window.setTimeout, setInterval: window.setInterval,
    clearTimeout: window.clearTimeout, clearInterval: window.clearInterval, now: Date.now };
  let now = 1_800_000_000_000;
  let id = 0;
  const jobs = new Map<number, { at: number; callback: () => void; interval: number }>();
  const schedule = (callback: TimerHandler, delay = 0, interval = 0) => {
    assert(typeof callback === 'function', 'Only callback timers are supported');
    jobs.set(++id, { at: now + delay, callback: callback as () => void, interval }); return id;
  };
  window.setTimeout = ((f: TimerHandler, ms = 0) => schedule(f, ms)) as typeof window.setTimeout;
  window.setInterval = ((f: TimerHandler, ms = 0) => schedule(f, ms, ms)) as typeof window.setInterval;
  window.clearTimeout = window.clearInterval = (id?: unknown) => { if (typeof id === 'number') jobs.delete(id); };
  Date.now = () => now;
  return {
    async advance(ms: number) {
      const end = now + ms;
      while (true) {
        const next = [...jobs].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
        if (!next) break;
        now = next[1].at; jobs.delete(next[0]);
        if (next[1].interval) jobs.set(next[0], { ...next[1], at: now + next[1].interval });
        await act(async () => next[1].callback());
      }
      now = end;
    },
    count: () => jobs.size,
    restore() { Object.assign(window, { setTimeout: original.setTimeout, setInterval: original.setInterval,
      clearTimeout: original.clearTimeout, clearInterval: original.clearInterval }); Date.now = original.now; },
  };
}
function UpdateHarness({ enabled }: { enabled: boolean }) {
  const update = useUpdateCheck(undefined, enabled);
  return <output>{update?.release.version ?? 'none'}</output>;
}
const release = { ok: true, status: 200, json: async () => ({ tag_name: 'v99.0.0',
  html_url: 'https://github.com/makinkade/nimbalyst-status-panel/releases/tag/v99.0.0' }) } as Response;
async function updates(run: (timer: ReturnType<typeof clock>, calls: string[]) => Promise<void>) {
  const timer = clock(); const calls: string[] = [];
  const oldFetch = window.fetch; const oldBridge = (window as any).electronAPI;
  window.fetch = async () => { calls.push('fetch'); return release; };
  (window as any).electronAPI = { invoke: async (channel: string) => { calls.push(channel); return null; } };
  __resetThrottleForTests();
  try { await run(timer, calls); }
  finally {
    await act(async () => root.unmount());
    timer.restore(); window.fetch = oldFetch; (window as any).electronAPI = oldBridge;
    __resetThrottleForTests();
    // check() owns a root too; replace the unmounted root for its final cleanup.
    root = createRoot(target);
  }
}

async function run() {
  await check('Gear migrates, edits, reorders, persists and resets through mounted controls', async () => {
    let saved: unknown = { order: ['usage7d', 'model', 'usage5h', 'usageScoped'], hidden: ['usage5h'],
      autoOpen: false, checkForUpdates: false };
    let writes = 0;
    const storage: PanelStorage = { getGlobal: () => saved, setGlobal: async (_key, value) => { writes++; saved = value; } };
    await act(async () => root.render(<ConfigHarness storage={storage} />));
    assert(writes === 0 && latestConfig.version === 2, 'Hydration must migrate without writes');
    await click(document.querySelector('.sp-config-button'));
    const primary = row(label)!;
    assert((primary.querySelector('input') as HTMLInputElement).checked === false, 'Hidden choice must migrate');
    assert(primary.querySelector('label')?.title === 'Synthetic window description', 'Live description missing');
    await click(primary.querySelector('input'));
    assert(!latestConfig.hidden.includes('usagePrimary') && writes === 1, 'Visibility must persist');
    await click(primary.querySelector('[aria-label$="earlier"]'));
    assert(latestConfig.order.indexOf('usagePrimary') === 1, 'Reorder must persist at the real callback');
    const before = JSON.stringify(latestConfig);
    label = 'Renamed bucket';
    await act(async () => root.render(<ConfigHarness storage={storage} />));
    assert(row(label) && JSON.stringify(latestConfig) === before, 'Bucket labels must not alter stable preferences');
    const writeCount = writes;
    await act(async () => root.unmount()); root = createRoot(target);
    await act(async () => root.render(<ConfigHarness storage={storage} />));
    assert(writes === writeCount && JSON.stringify(latestConfig) === before, 'v2 remount must not save or reset');
    await click(document.querySelector('.sp-config-button'));
    await click(document.querySelector('.sp-popover-reset'));
    assert(JSON.stringify(latestConfig) === JSON.stringify(DEFAULT_CONFIG), 'Reset must save defaults');
    assert(JSON.stringify(saved) === JSON.stringify(DEFAULT_CONFIG), 'Reset was not persisted');
  });
  await check('Update opt-out creates no timers, host reads or network work', () => updates(async (timer, calls) => {
    await act(async () => root.render(<UpdateHarness enabled={false} />));
    await timer.advance(8 * 60 * 60_000);
    assert(calls.length === 0 && timer.count() === 0, 'Disabled hook performed work');
  }));
  await check('Disabling before the first 8-second check cancels both timers', () => updates(async (timer, calls) => {
    await act(async () => root.render(<UpdateHarness enabled />));
    await timer.advance(7999);
    assert(calls.length === 0, 'Check started early');
    await act(async () => root.render(<UpdateHarness enabled={false} />));
    await timer.advance(60 * 60_000);
    assert(calls.length === 0 && timer.count() === 0, 'Disabled timers were retained');
  }));
  await check('Pending update cannot reappear after disable; re-enable uses the shared result', () => updates(async (timer, calls) => {
    let resolve!: (response: Response) => void;
    window.fetch = () => { calls.push('fetch'); return new Promise((finish) => { resolve = finish; }); };
    await act(async () => root.render(<UpdateHarness enabled />));
    await timer.advance(8000);
    assert(calls.filter((c) => c === 'fetch').length === 1, 'Expected one request');
    await act(async () => root.render(<UpdateHarness enabled={false} />));
    await act(async () => resolve(release));
    assert(target.textContent === 'none', 'Canceled update repopulated the UI');
    await act(async () => root.render(<UpdateHarness enabled />));
    await timer.advance(8000);
    assert(target.textContent === '99.0.0', 'Re-enabled hook missed the completed result');
    assert(calls.filter((c) => c === 'fetch').length === 1, 'Re-enable bypassed request floor');
  }));
  await check('Unmount cancels update timers and ignores pending completion', () => updates(async (timer, calls) => {
    let resolve!: (response: Response) => void;
    window.fetch = () => { calls.push('fetch'); return new Promise((finish) => { resolve = finish; }); };
    await act(async () => root.render(<UpdateHarness enabled />));
    await timer.advance(8000);
    await act(async () => root.unmount()); root = createRoot(target);
    await act(async () => resolve(release));
    await timer.advance(60 * 60_000);
    assert(timer.count() === 0 && calls.filter((c) => c === 'fetch').length === 1, 'Unmount leaked timers');
    assert(target.textContent === '', 'Unmounted hook wrote UI');
  }));
  document.querySelector('#results')!.textContent = JSON.stringify(results, null, 2);
  (window as any).__uiChecks = results;
}
void run();
