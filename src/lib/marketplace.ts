/**
 * The three host calls the self-update flow makes, and the caveat they carry.
 *
 * These reach past the extension SDK. The SDK's capability table has no
 * "install an extension" entry and no "read my own install record" entry, so
 * this goes to `window.electronAPI` -- the same bridge `ipc.ts` already uses for
 * sessions, git and workspace state, which is how the panel gets any of its
 * data. `docs/EXTENSION_ARCHITECTURE.md` is explicit that the table is "an API
 * contract, not a sandbox", so this is possible by design rather than by
 * oversight. It is still reaching past the contract.
 *
 * The spike GET-99 asked for came back clean, and the reason is structural
 * rather than incidental: the preload exposes
 * `invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args)` with no
 * channel allowlist between the two, and `extension-marketplace:install-from-github`
 * is registered on the main side with `ipcMain.handle`. There is nothing in
 * between to refuse the call.
 *
 * What that does *not* buy is a promise. No bundled or third-party extension
 * calls these channels, so they are not an established pattern, and an
 * unestablished pattern can be changed on any Nimbalyst release without that
 * counting as a regression. Everything here is therefore written to degrade to
 * the manual path: a call that cannot be made, or comes back shaped wrong, ends
 * as `installed: false` and the popover shows the paste-this-URL instructions
 * instead. Nothing in the strip breaks either way.
 */

import { invokeQuiet } from './ipc';

/**
 * What Nimbalyst persisted when this extension was installed.
 *
 * `githubUrl` and `githubReleaseTag` are written by `installFromGitHub` and, as
 * GET-99 notes, read back by nothing in the host -- groundwork for an update
 * path that was never built. Reading them here is the point: it means the
 * update check follows the repo the user actually installed from, including a
 * fork, rather than the one this build's manifest happens to name.
 */
export interface InstallRecord {
  extensionId?: string;
  version?: string;
  source?: string;
  githubUrl?: string;
  githubReleaseTag?: string;
  githubInstallMethod?: string;
}

interface InstalledResponse {
  success?: boolean;
  data?: Record<string, InstallRecord> | null;
}

/**
 * This extension's install record, or null when there is not one.
 *
 * A symlinked dev install has no marketplace record at all, which is an
 * ordinary outcome here rather than a failure -- the caller falls back to the
 * manifest's `repositoryUrl`.
 */
export async function getInstallRecord(extensionId: string): Promise<InstallRecord | null> {
  const result = await invokeQuiet<InstalledResponse>('extension-marketplace:get-installed');
  // The wrapper is truthy whether it succeeded or failed, so the flag has to be
  // read rather than the object.
  if (!result?.success) return null;

  const record = result.data?.[extensionId];
  return record && typeof record === 'object' ? record : null;
}

export interface InstallOutcome {
  installed: boolean;
  /** Why not, when the host said. Shown beside the manual fallback. */
  error: string | null;
}

interface InstallResponse {
  success?: boolean;
  error?: string;
  extensionId?: string;
}

/**
 * Install (or reinstall over) this extension from its GitHub repo.
 *
 * Only ever called from the popover's explicit confirmation -- never on a
 * timer, never silently. Reinstall-over-existing needs no uninstall step:
 * `installFromPackageUrl` does `fs.rm(finalInstallPath, { recursive: true,
 * force: true })` and then renames staging into place, so an in-place upgrade
 * is the same code path as a first install.
 *
 * The new code does not become the running code. The bundle is already
 * evaluated in this renderer, so what is on screen after this resolves is still
 * the old build -- which is why the popover's success message asks for a
 * restart rather than claiming the update is live.
 */
export async function installFromGitHub(githubUrl: string): Promise<InstallOutcome> {
  const result = await invokeQuiet<InstallResponse>(
    'extension-marketplace:install-from-github',
    githubUrl,
  );

  // `invokeQuiet` answers null when the bridge is missing or the channel
  // rejects -- the case where the host has moved on and this whole path is
  // gone. Indistinguishable from here, and it does not need distinguishing:
  // both mean "do it by hand instead".
  if (!result) {
    return { installed: false, error: 'Nimbalyst did not answer the install request.' };
  }

  if (result.success) return { installed: true, error: null };

  return { installed: false, error: result.error ?? 'The install did not complete.' };
}

/**
 * Hand a URL to the system browser.
 *
 * A plain link would work too -- the main process installs a window-open guard
 * that routes https: to `shell.openExternal` -- but going through the channel
 * directly keeps the release notes on the same failure model as everything
 * else: it either opens or it does not, and nothing in the strip changes.
 */
export async function openExternal(url: string): Promise<void> {
  await invokeQuiet('open-external', url);
}

/**
 * Put text on the system clipboard.
 *
 * Through the host's `copy-to-clipboard` channel rather than
 * `navigator.clipboard.writeText`, which in Electron can resolve without
 * having written anything -- the SDK's own clipboard helper exists for exactly
 * that reason. It is not imported here because it lives behind the SDK's index,
 * which pulls in `@nimbalyst/runtime`: a module the host provides and nothing
 * outside it can resolve, so importing it would take the panel's test suite
 * down to reuse five lines.
 *
 * Reports whether it landed, because this one has a visible acknowledgement --
 * the button shows a tick -- and a tick for a copy that did not happen is worse
 * than no tick.
 */
export async function copyText(text: string): Promise<boolean> {
  const result = await invokeQuiet<{ success?: boolean } | null>('copy-to-clipboard', text);
  if (result === null) return false;
  // Channels here have no house convention for the `{ success }` wrapper, so a
  // response object that does not carry the flag is taken at its word: it
  // answered, and answering is the only signal on offer.
  return typeof result === 'object' && 'success' in result ? result.success === true : true;
}
