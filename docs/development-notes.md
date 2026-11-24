# Development notes

Working notes for this repo: why the panel is shaped the way it is, which host
channels it reads, how a release is cut, and what has been verified on screen.
None of this is needed to install or use the extension — see the
[README](../README.md) for that.

## Why a panel

Nimbalyst's Agent toolbar is a fixed React component — the `Context Breakdown` chip is `data-testid="context-indicator"`, not a pluggable slot. The extension manifest offers no toolbar or status-bar contribution point. `contributions.panels` is the supported surface for custom UI, so the status line becomes a bottom panel: `Ctrl+Shift+S`, or `Ctrl+J` and pick the tab.

Trade-off to live with: the SDK documents bottom panels as "mutually exclusive with other bottom panels (terminal, tracker)" (`@nimbalyst/extension-sdk/dist/types/panel.d.ts`). A status line you want permanently visible therefore competes with the terminal for the same slot. If that proves annoying in practice, `sidebar` placement or a `floating` panel are the escape hatches.

## Deferred segments

Considered and not built:

- Clock (local + TZ abbreviation, UTC)
- Current-turn stopwatch and tool-call count
- Fast mode chip

## Decisions

1. **Session tracked** — follows the session selected in the sidebar (GET-102). Nimbalyst keeps focus in a renderer atom extensions cannot read (`session:get-active` is a stub returning `null`), but every selection change is also persisted to workspace state as `agenticCodingWindowState.selectedWorkstream`, which `workspace:get-state` returns. That is the selection itself rather than a proxy for it, and it survives a restart. A worktree or workstream selection names the group, so it is resolved to the session on screen through `worktreeActiveSessions` or `workstreamStates[id].activeChildId`. When the workspace has no persisted selection yet, the panel falls back to the session with the newest `metadata.metadata.lastReadAt`, then to the most recently updated one. `lastReadAt` is only the second choice because two things write it without a session switch: the tray's "clear all unread", which stamps one timestamp onto every unread session, and `sessions:sync-read-state`, which can import one from another machine. Before GET-102 the panel used *the most recently updated session* alone, so switching sessions changed nothing until you prompted the new one. See `selectedSessionId` and `getFocusedSession` in `src/lib/ipc.ts`.
2. **Permission mode** — the workspace value (`agentPermissionMode`), not the per-session Shift+Tab mode the script parses out of the transcript. There is no stored `auto` value: `agentPermissions.permissionMode` of `bypass-all` combined with `allowAllUsesClassifier: true` is what Nimbalyst launches as auto mode, so the panel reports that pair as `Auto` and keeps `Bypass` for `bypass-all` with the classifier off.
3. **Refresh** — event subscriptions (`sessions:session-updated`, `sessions:session-created`, `sessions:refresh-list`, `open-ai-session` window event) plus two timers for values nothing broadcasts. Nothing announces a selection change, so a 1 s `SELECTION_POLL_MS` asks only `workspace:get-state`, which the host answers from memory, and triggers a full refresh when the selected session has changed. The full refresh runs every 5 s on its own, and stays at that rate because it shells out to git three times.
4. **Layout** — horizontal chip strip, wrapping.
5. **Keybinding** — `Ctrl+Shift+S`. Verified free: Nimbalyst's `file` shortcut group has no `saveAs` entry and nothing in the app binds `Shift+S`.

## Architecture

Panels run in Nimbalyst's renderer and receive a `host` prop (`{ host }`, per `PanelContainerInner`), with `window.electronAPI` available for IPC — the same approach the bundled Git panel uses.

```
src/
  index.ts            # exports { panels, activate, deactivate }
  StatusPanel.tsx     # chip strip
  useStatus.ts        # React binding; clears the previous workspace before effects run
  statusController.ts # production lifecycle, 1s selection + 5s full refresh, generation guards
  lib/statusModel.ts  # scoped readings, capabilities, model/context/tokens/account contract
  lib/providerAdapters.ts # registry, generic fallback, common source normalization
  lib/providers/claude.ts # Claude account adapter and direct/host normalization
  lib/accountMonitor.ts # adapter subscriptions, auth epochs and 60s Claude cadence
  lib/accountUsageCache.ts # scoped, memory-only cache and shared requests
  lib/statusPresentation.ts # compatibility projection for the existing fixed usage IDs
  components/Chip.tsx      # Chip + Bar
  components/ConfigChip.tsx # gear chip + segment picker popover
  segments.ts         # segment registry, default order, config reconciliation
  useSegmentConfig.ts # load/save config via host.storage global scope
  lib/ipc.ts          # typed, failure-tolerant wrapper over electronAPI
  lib/modelNames.ts   # model chip label, parsed from ids -- no version table to maintain
  panelKeeper.ts      # put the panel back when the host dismisses it on a mode switch
  useUpdateCheck.ts   # is there a newer GitHub release? -- cached, throttled, silent
  components/UpdateChip.tsx # the update chip, its confirmation and the manual fallback
  lib/planUsage.ts    # reads the credentials file and calls the usage API directly
  lib/releaseCheck.ts # GitHub releases client: version parsing, cache, throttle
  lib/marketplace.ts  # install / install-record / open-external, past the SDK contract
  lib/buildInfo.ts    # manifest version and repositoryUrl, baked in at build time
  lib/format.ts       # formatTokens / formatResetTime / labels, ported from the .ps1
  lib/thresholds.ts   # Night Owl palette + bar thresholds, ported from the .ps1
```

### Data sources

| Segment | Channel |
| --- | --- |
| Session | `workspace:get-state` → `selectedWorkstream`, else newest `lastReadAt`, else newest `updated_at`, resolved through `sessions:list(workspacePath, opts)` + `sessions:get(id)` (GET-102) |
| Model | Version from the latest main-thread turn's served model via `transcript:get-tail-messages`, parsed rather than looked up (GET-111); `ai:getModels()` name as fallback |
| Context window | `tokenUsage.currentContext.contextWindow`, then `tokenUsage.contextWindow`, then model catalog context window; see the catalog shape caveat in the provider audit below |
| Effort | `session.metadata.effortLevel`, then `settings:get-default-effort-level`, then the panel's built-in `high`; configured effort, not a universal provider capability |
| Permission mode | `workspace:get-state` → `agentPermissions` first; `app-settings:get("agentPermissionMode")` is a legacy fallback. This is workspace policy, not a session's effective restrictions. |
| Branch / dirty | `git:is-repo`, `git:branches`, `git:get-uncommitted-files` |
| Tokens | `session.metadata.tokenUsage` |
| Plan usage | `api.anthropic.com/api/oauth/usage`, falling back to `claude-usage:get()` |

### Plan usage

When the panel was built, `claude-usage:get` mapped only `five_hour`, `seven_day`, and `seven_day_opus`, so the panel calls the usage endpoint itself for model-scoped caps like `7d Fable`. The GET-222 audit below found that host 0.83.0 also maps weekly scoped limits to `weeklyModelLimits`; the panel's current fallback type and renderer do not consume that newer field. The direct client's shared-cache contract remains unchanged.

`src/lib/planUsage.ts` reads the OAuth token from `.credentials.json`, `GET`s `https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20`, and shapes the response the way `~/.claude/get-plan-usage.ps1` does — including `allLimits`, the diagnostic record of every entry in `limits[]`. Nothing is spawned; both files are reached through `read-global-claude-file` / `write-global-claude-file`, which resolve the Claude config directory host-side and honour `CLAUDE_CONFIG_DIR`. `permissions.filesystem` is still required, because that is what gates reading the credentials file.

`statusline.ps1` still dot-sources `get-plan-usage.ps1`, and the panel still shares `statusline-usage-cache.json` with it, so whichever renders first pays for the API call. Sharing that file means honouring its discipline in both directions:

- **60 s TTL** — a cache younger than that is returned as-is, so the panel and the status line do not double-fetch.
- **Atomic writes** — a temp file per renderer, then a rename. `write-global-claude-file` truncates before writing, so writing the cache path directly is what used to leave it at zero bytes.
- **Tolerant reads** — empty, truncated, or unparseable is treated as absent. Note the reader must `trim()` before `JSON.parse`: Windows PowerShell writes a UTF-8 BOM, which `JSON.parse` rejects outright.
- **Local timestamps** — written as `2026-09-18T17:56:57.983-04:00`, not `toISOString()`. `ConvertFrom-Json` coerces the field to a `[DateTime]`, and a trailing `Z` comes back `Kind=Utc`, which the status line's age expression re-reads as a local wall clock; the age goes negative, `-lt 60` holds, and the CLI serves that reading as fresh for hours.

Failures are quiet by design — no credentials, unreadable file, network error, 401, 429 — and fall back to the last cached reading, whose older timestamp is what makes the chips render as stale. That includes the console: the usage path reaches the host through `invokeQuiet`, so a channel the host cannot answer costs a `console.debug` rather than a `console.warn` every minute the panel is open. `claude-usage:get` remains the fallback when there is no reading at all, in which case the scoped bars are simply absent.

Formatting, thresholds, and the palette are ported verbatim so a bar that is red in the terminal is red here.

### Staying open

The host closes our panel and does not reopen it. `setWindowMode` calls `dismissExtensionPanels`, which nulls both the sidebar and the bottom panel id, on **every** mode set — including setting the mode it is already in, which is how the history button and the tracker-navigation handler lose the panel with no mode change at all. Nor is a bottom panel id persisted: `loadActiveExtensionPanel` filters the stored id through `isSidebarPanel`, so there is no host setting that keeps ours up and no manifest flag to ask for one. That is GET-107, and the whole reason `autoOpenPanel` existed in the first place.

So `panelKeeper.ts` watches for it and reopens. The hard part is not fighting a deliberate close, which would leave the panel impossible to dismiss. The host offers exactly three ways to close ours and no more — the `<panelId>.toggle` command behind Ctrl+Shift+S, the panel's button in the bottom gutter, and `host.close()`, which `StatusPanel` never calls. The first two are DOM events we can see, so they are recorded as closing gestures and every *other* disappearance is treated as a dismissal to undo.

- **Only after the panel has been seen open.** That is what says the user wants it there, and it keeps the keeper silent when `autoOpen` is off and the panel was never opened.
- **The bottom slot is shared.** The host keeps the terminal and bottom panels mutually exclusive — opening the terminal nulls the bottom panel id, and opening Git Log replaces ours — so reopening over either would stack two panels. The keeper waits, and takes the slot back when it is free.
- **Bounded retries.** Three consecutive reopens that change nothing and it stops asking until the panel is next seen open, so a host that declines cannot become a loop.
- **Narrow observers.** A `childList` observer on the main column (not subtree — the bottom panel is a direct child) and a `style` observer on the terminal container, which hides with `display: none` rather than unmounting. Both are needed for the strip to come back within a frame instead of blinking; a 1 s interval is the backstop for a layout that does not match, and retries attaching them until a workspace is open.

The decision is kept clear of the DOM so it can be tested against a fake slot rather than a rendered app — `panelKeeper.test.ts`.

### Self-update check

Nimbalyst never auto-updates a GitHub-installed extension. `checkForUpdates()` in `ExtensionMarketplaceHandlers.ts` walks every install record, including `source: 'github-url'` ones, but only matches them against **registry** entries by id and then installs from the registry's `downloadUrl` — so an extension that is not in the registry never matches, and `runExtensionAutoUpdate()` skips it silently on every startup, forever. The install record does persist `githubUrl`, `githubReleaseTag` and `githubInstallMethod`; nothing in the host reads them back. Since we ship via GitHub rather than the registry, closing that is ours to do (GET-99).

**Detecting.** `src/lib/releaseCheck.ts` polls `https://api.github.com/repos/<owner>/<repo>/releases/latest` and compares `tag_name` against the manifest version, which `vite.config.ts` bakes into the bundle as `__PANEL_VERSION__` — the version of the code actually executing, rather than the one the install record claims. Which repo gets asked comes from the install record's `githubUrl` when there is one, so someone running a fork is offered their fork's releases; the manifest's `repositoryUrl` is the fallback, and the only answer for a symlinked dev install.

The same discipline as the usage client, for the same reason — a shared, rate-limited endpoint:

- **Six-hour TTL, persisted.** Unauthenticated GitHub is 60 requests an hour *per IP*, shared with everything else on the machine. The reading is stored in global extension storage under `releaseCheck`, so restarting Nimbalyst does not spend a request. The first check is delayed 8 s so panel storage has hydrated and the read is a real one.
- **A half-hour floor and a shared in-flight promise**, which is what holds when there is no storage to hold the TTL.
- **Only a completed check advances `checkedAt`.** A failure that stamped it would read as a fresh "no update" and suppress the next six hours of checks on the strength of an outage.
- **Stable releases only.** Version parsing is anchored, so `v0.2.0-beta.1` does not parse at all rather than comparing as `0.2.0` and offering a beta build to someone who installed a stable one.
- **Fail silent.** Offline, rate-limited, repo renamed, malformed body, unparseable tag — every one of them resolves to "no chip". None may produce an error state or a spinner in the strip. This is the one segment with no empty-state placeholder, and deliberately so: the other segments describe values that always exist and are merely unavailable, whereas "no newer release" is the ordinary condition of being up to date, not a missing reading.

**Installing.** `extension-marketplace:install-from-github` is reachable from an extension, and structurally rather than accidentally: the preload exposes `invoke: (channel, ...args) => ipcRenderer.invoke(channel, ...args)` with **no channel allowlist**, and the handler is registered main-side with `ipcMain.handle`. Nothing sits between the two to refuse it. Reinstall-over-existing needs no uninstall step — `installFromPackageUrl` does `fs.rm(finalInstallPath, { recursive: true, force: true })` and renames staging into place.

That is reachability, not a promise. No bundled or third-party extension calls these channels, so this is not an established pattern and therefore not a supported one; it can break on any Nimbalyst release without that counting as a regression on their side. `docs/EXTENSION_ARCHITECTURE.md` is explicit that the capability table is "an API contract, not a sandbox" — possible by design, still past the contract. So everything in `lib/marketplace.ts` degrades to the manual path: a call that cannot be made, or comes back shaped wrong, ends as `installed: false` and the popover shows the paste-this-URL instructions, which are on screen the whole time rather than appearing only after a failure.

A successful install does not become the running code — the bundle was evaluated at startup — so the popover asks for a restart rather than claiming the update is live.

**Consent.** `checkForUpdates` in the segment config, default on, in the popover's Behavior group. Off means no request is made at all, not merely that the chip is hidden; it is the only thing the panel does that reaches an address the user did not open.

## Releasing

The GitHub install path resolves `/releases/latest`, downloads the `.nimext` asset and
extracts it to `<user-data>/extensions/com.mkinkade.status-panel/` — `%APPDATA%\@nimbalyst\electron`
on Windows, `~/Library/Application Support/@nimbalyst/electron` on macOS,
`~/.config/@nimbalyst/electron` on Linux.

That path needs a release and **fails rather than degrading without one**: with no release
Nimbalyst falls back to cloning the source, which requires a committed `dist/`, and `dist/`
is deliberately gitignored here — the fallback would report *"Extension repository does not
include a built dist/ directory."*

```
npm run package          # clean build -> build/status-panel-<version>.nimext + .sha256
npm run package -- --no-build   # package the dist/ already on disk
```

A `.nimext` is a zip Nimbalyst extracts straight into its user-data `extensions/{id}/` directory, so `manifest.json` has to be at the **top level** of the archive rather than one directory deep. What ships:

```
manifest.json
dist/index.js
dist/index.css
screenshots/status-panel-dark.png
screenshots/status-panel-light.png
README.md
LICENSE
```

No `src/`, no `node_modules/`, and no `.js.map` — a source map inlines the full text of `src/` through `sourcesContent`, which is the one thing the marketplace review checklist asks packages not to carry. The repo is public, so debugging means building locally.

`scripts/package.mjs` builds the archive with **adm-zip**, which is the same library `extractNimext` uses to unpack it, then re-opens the result and re-runs the installer's own checks — top-level `manifest.json` that parses and has the right `id`, `manifest.main`/`manifest.styles` actually present, no entry that escapes the destination directory. A release carrying a *broken* asset is a hard install failure that does **not** fall back to the clone path, so a malformed package is worse than no package; it is worth failing in the build rather than on someone's machine.

### Published identity

Settled in GET-93 and not worth re-deciding:

- **`author`** is `Mark Kinkade` — the same name as the LICENSE copyright line. The registry and the extension card show this string verbatim, so it is the public byline; the earlier `mkinkade` was a placeholder that did not even match the GitHub owner.
- **`id`** stays `com.mkinkade.status-panel`. `checkForUpdates()` matches an install to a registry entry on id alone, so a `com.nimbalyst.*` id would invite a first-party registry build to overwrite this GitHub install on startup.
- **`minimumAppVersion` is not a manifest field.** The registry generator derives it as `manifest.apiVersion || '1.0.0'`, so `apiVersion: "1.0.0"` — already declared — is the field that decides it. It is also never enforced: nothing compares it against the running app version, and on the GitHub install path no registry entry exists at all. Treat it as advisory metadata. A real minimum-version guard would have to be a runtime check in the panel.

### Cutting a release

`.github/workflows/release.yml` runs on any `v*` tag: `npm ci`, version check, `npm test`, `npm run package`, then `gh release create` with both artifacts attached.

```
git tag v0.1.3        # must match manifest.json "version"
git push origin v0.1.3
```

**The tag and the manifest version have to agree.** The app's update check compares a release's `tag_name` against the installed manifest version, so drift there silently breaks update detection for anyone already installed. Three copies exist — the tag, `manifest.json`, and `package.json` — and both the workflow and `npm run package` refuse to proceed when they disagree, so bump all three together.

The release is published with `--latest`, because the installer asks for `/releases/latest` specifically rather than for a tag.

Note that `0.1.1` and `0.1.2` have changelog entries but no tags: both were built and version-bumped locally and never pushed, so `v0.1.3` is the first release to carry them. Nothing is lost — the installer only ever resolves `/releases/latest` — but it does mean a version bump is not a release until the tag is pushed, and the two can drift a long way apart without anything complaining.

The `.sha256` is emitted alongside for form's sake. Nothing on the GitHub path consumes it — installs from a repo URL record `checksum: ''` — but `installFromUrl` does verify a checksum when the registry supplies one, so the discipline is worth keeping.

## Provider capability audit (GET-222, 2026-11-24)

This is a data-source audit for [GET-222](https://linear.app/markkinkade/issue/GET-222), not a claim that the panel already implements multi-provider cards. It supplies the contracts for GET-223 through GET-227. No production collector or UI behavior changed during the audit.

### Evidence and limits

The running host was **Nimbalyst 0.83.0, packaged, Windows 11**. `claude-code:check-installation` reported **2.1.330 (Claude Code)**; the bundled Codex executable returned **codex-cli 0.167.0** for `--version`. Bundled package metadata reported Claude Agent SDK **0.3.321** and Codex SDK **0.167.0**. The PATH also contained a user-installed Claude binary; its version was not substituted for the host's version. Copilot and Cursor were not found by `Get-Command`, were disabled in the host catalog, and had no sessions in the workspace sample. Custom/local and other built-in providers were also disabled. This is not proof that they cannot be installed elsewhere.

**R** below means observed through real renderer IPC; **H** means verified in the installed handler/provider source; **U** means an upstream contract without a verified extension reading. **Unavailable** means this audit cannot supply the reading; **unsupported** means the examined host integration explicitly lacks it. Neither means the upstream vendor could never expose it.

The [sanitized fixture](../src/lib/fixtures/status-host-0.83.0.json) contains real projected payloads, including both session records, both transcript tails, the model catalog, login status, quota getters, a refresh, and its update event. [Fixture notes](../src/lib/fixtures/README.md) describe omissions and reproduction. IDs are consistently aliased; account details are redacted. Credentials, prompts, transcript text, tool arguments, and user paths were never included. These are projections, not full payload dumps; an omitted unrelated field is not evidence of its absence in the original.

A temporary renderer extension captured the data into an ignored build folder, then was uninstalled. Its Codex event subscription was disposed. No extension-storage probes, credentials-file reads, session/account changes, permission changes, or sandbox setup were used. Two explicit Codex refreshes were made while refining the capture; the fixture retains the final refresh sequence and an earlier cached observation. The existing panel was neither rebuilt/reloaded for the probe nor restarted.

Source locators refer to UTF-8 text extracted from the installed `app.asar`, **not** to a development checkout. `out/main/index.js` SHA-256 is `59a0f85f5f43a9611e6cc13d8f8f0e13b1fb1b2daaaf99daf703da8d90048c16`; `out/preload/index.js` is `6276288e4a4fd48870bdcfc92f3017221d9f8ab0fc79fa5a1c20011c947a17e6`. Search the named functions after a host upgrade; line numbers alone are not a compatibility guarantee.

### Capability matrix

Source IDs in cells refer to the contracts below, including their scope, refresh, and missing-data rules. “Configured” is deliberately distinct from provider-acknowledged effective settings.

| Reading | Claude Code (`claude-code`) | ChatGPT/Codex (`openai-codex`) | Copilot (`copilot-cli`) | Cursor (`cursor-agent`) | Generic/custom |
| --- | --- | --- | --- | --- | --- |
| Provider identity | R S1 | R S1 | H S1 | H S1 | H S1; unknown stays unknown |
| Requested model | R S1/S2 | R S1/S2 | H S1/S2; default may be an alias | H S1/S2; `auto` may be an alias | H S1/S2; supplied ID/name only |
| Served model | R S3, `claude-opus-5-5` | R S3: assistant entries had no model; unavailable | H parser does not project it; unavailable | H parser does not project it; unavailable | Unverified per integration; do not infer from requested ID |
| Effort | R configured S4; H launch/clamping | R configured S4; H launch/clamping | H no verified effort control; unsupported in examined path | H no verified effort control; unsupported in examined path | No universal control; capability must be verified |
| Workspace approval policy | R S5 | R S5 | H same workspace source S5 | H same workspace source S5 | H S5 when workspace exists |
| Effective approval/reviewer | H launch mapping S6; no verified session read contract | H launch mapping S6; no verified session read contract | H trust gate S6, not effective CLI settings | H trust gate/flags S6, not acknowledged settings | Unavailable until integration exposes S6 |
| Effective sandbox/restrictions | Unavailable S6 | Machine setup status is H, effective thread restrictions unavailable S6 | No verified session contract S6 | No verified session contract S6 | Unavailable; workspace policy is not proof |
| Current context/window | R S7 | R S7 | H capability `none`; unsupported | H `token-counts` only; percentage unsupported | H chat providers: token counts only; unknown: none; explicit adapters may differ |
| Cumulative token totals | R S7 | R S7; cache-inclusive totals differ from context | H zero completion fallback, not measured usage | H result usage normalized to S7; runtime untested | H optional provider usage; missing is not zero |
| Account identity/plan | R S8, redacted Claude Pro login | R S9, redacted ChatGPT Plus login; stable scope missing | No verified extension account reader | No verified extension account reader | No generic account reader |
| Quota windows | R cached S10; H scoped windows | R S11 account windows; selected-session owner unproven | No quota bridge found in examined integration | No quota bridge found in examined integration | No generic bridge; never reuse Claude/Codex allowances |
| Credits | No credit field in examined host usage projection | R S11 credit object and reset-credit collection | No verified credit reader | No verified credit reader | Unavailable unless a specific integration supplies it |

`openai` is the API chat provider, not `openai-codex`; an OpenAI model ID alone does not prove ChatGPT login or subscription quota. The deprecated `openai-codex-acp` has separate context-window capability in the host registry but was not enabled or observed. `opencode` has a host-specific context-window path; generic/custom support must not erase such separately verified capabilities, or assume every custom provider has them.

### Session and workspace contracts

**S1 — selection, provider, requested model.** `workspace:get-state(workspacePath)` returns the state directly, including `agenticCodingWindowState.selectedWorkstream: { type, id }`, `workstreamStates[id].activeChildId`, and optionally `worktreeActiveSessions[id]`. `sessions:list(workspacePath, { limit: 50 })` returns `{ success, sessions }`; entries carry `id`, `provider`, `model`, numeric `updatedAt`, `childCount`, `messageCount: 0`, and `metadata: {}`. `sessions:get(id)` returns `{ success: true, session }`; failure returns `{ success: false, error, session: null }`. Full records hold the actual metadata; JSON-text metadata is also tolerated by the panel. Empty transcript/session results must remain missing, not become Claude by default.

Scope is workspace selection plus session identity. Preserve persisted selection, group-child resolution, then `metadata.metadata.lastReadAt`, then `updatedAt`; retain the existing bounded root/candidate handling. The list's timestamp can bubble child activity, so do not substitute it for full-record focus. Refresh via `sessions:session-updated`, `sessions:session-created`, `sessions:refresh-list`, and `open-ai-session`; retain the cheap 1 s selection poll and 5 s full refresh. A missing selection may use the existing heuristic; a new provider must not change its precedence. Sources: main lines 274813, 284345; panel `selectedSessionId`/`getFocusedSession`.

**S2 — catalog.** `ai:getModels()` has no workspace argument; the handler derives workspace from the calling window. It returns `{ success: true, models, grouped, providers, providerLabels, providerIcons }`. Flat `models` entries are `{ id, display_name, provider, maxTokens }`. `grouped[provider]` retains richer entries with `name` and `contextWindow`. The runtime Codex entry had `maxTokens: 128000`, catalog `contextWindow: 272000`, and session-reported window **475000**. `maxTokens` is not a context denominator. Claude's flat `maxTokens` was 8192 while its session window was 1000000.

The current panel's `getModels()` happens to flatten the `models` array but casts its entries to `{ name, contextWindow }`; those fields are absent on that flat projection. Normalize at this boundary in GET-223/GET-224, using `display_name` and the appropriate richer catalog entry. Missing/disabled models need a generic ID label, not a guessed name or quota. Scope is the calling window's enabled catalog, not proof of served identity. It is polled by the current 5 s refresh; no model-change subscription was established in this audit. Main `ai:getModels`, line 414847.

**S3 — served model.** `transcript:get-tail-messages(sessionId, 40)` returns a bare projected message array, newest last. Missing session/service returns `[]`. Claude main-thread `assistant_message` entries include `model`; skip `subagentId` and synthetic/non-model values. The live Codex assistant entries had no `model`. Copilot's `CopilotRawParser` and Cursor's `HeadlessAgentRawParser` project assistant text without served model. The panel currently parses only versioned Claude IDs and remembers a miss per session. Its cache is a last-observed answer, not proof that a newly requested model has already served a turn. Scope is that session's projected transcript, refreshed with session events/5 s polling. Main handler line 284845; parser classes around 139082, 140314, 140914.

**S4 — effort.** Full session metadata contains `effortLevel` (both live providers returned `high`). `settings:get-default-effort-level()` returns a bare string or an unset value. The host parses valid levels and clamps to model-specific ceilings when constructing Claude/Codex options; Codex thread config receives `model_reasoning_effort`. These sources prove configured/requested effort, not an acknowledgement from the serving model. The host UI only enables effort controls for supported Claude variants and Codex families; do not display the panel's unconditional `high` fallback as a Copilot, Cursor, or unknown-provider measurement. `ai:getEffectiveSettings(workspacePath)` returns provider configuration under `{ success, settings }`, not the effort contract, and should not be probed for this purpose. Scope: session setting, then app default; current refresh is events plus 5 s polling, with no effort-specific event established. Missing capability is unsupported; missing supported-provider settings need an explicitly labeled default. Main `resolveEffortLevel`, line 14744; `buildCodexThreadStartParams`, near 61304; renderer `supportsEffortLevel`.

**S5 — workspace policy.** State contains `agentPermissions: { permissionMode, allowAllUsesClassifier }`; the runtime value was `bypass-all` with classifier `true`. `getPermissionMode` reads it first and labels that pair Auto. The legacy `app-settings:get('agentPermissionMode')` is only a fallback. `permissions:getWorkspacePermissions(workspacePath)` separately returns bare `{ isTrusted, permissionMode, allowAllUsesClassifier, allowedPatterns, additionalDirectories, allowedUrlPatterns }` or rejects; those collections were not needed or captured. Scope is workspace, possibly resolved through a worktree's permission path. Refresh on the existing 5 s poll; missing/untrusted must stay distinct from bypass. Main handler line 294742.

**S6 — effective execution settings.** Host code proves different launch behavior, not one shared effective status field. Claude maps session mode through `resolveEffectiveSessionMode`/SDK permission options, with separate workspace tool checks. Codex `resolveCodexPermissionProfile` maps agent-verified bypass to workspace-write/on-request/auto_review, plain bypass to danger-full-access, ask with user approvals to read-only, and other cases to workspace-write. SDK and app-server transports pass different `userApprovals` options; model/config overrides, resumed sessions, and provider acknowledgement also matter. `validateCodexSandbox` checks the returned sandbox during initialization, but no verified extension getter returns that selected thread's complete effective profile. `openai-codex:sandbox-status` reads machine setup readiness, not a thread's active sandbox.

Copilot gates a turn on trusted allow-all/bypass policy, then creates an ACP session; the examined `createSession` does not apply `options.model` through that request. Its configured model therefore cannot be presented as served. Cursor also gates entry and launches with requested `--model` plus `--force --trust`; those flags do not establish a provider-acknowledged sandbox or approval profile. Generic/custom providers have no common effective restriction shape. Missing values should say unavailable/unsupported while workspace policy stays separately labeled. [GET-229](https://linear.app/markkinkade/issue/GET-229) tracks the smallest session-scoped, read-only bridge and change event. Main lines 43384, 60635, 61215, 61304, 86231, 87950.

**S7 — current context versus totals.** The observed full records expose `metadata.tokenUsage` with numeric `inputTokens`, `outputTokens`, `totalTokens`, cache counters, `contextWindow`, and `currentContext: { tokens, contextWindow }`. Nested `metadata.metadata.tokenUsage` and flattened variants remain tolerated. `currentContext` is the numerator/denominator pair for a percentage. Cumulative totals must never stand in for its numerator; absent current context is not zero usage.

Claude accumulates per-turn usage, tracks cache read/write counters separately, and clears context fill and denominator at compaction. Codex's app-server `thread/tokenUsage/updated` uses `total` for thread counters, `last` for fill, and `modelContextWindow` for capacity. `threadCumulativeCounters` computes deltas on resume rather than summing cumulative snapshots, and separates cached input. The fixture demonstrates that `totalTokens` need not equal uncached `inputTokens + outputTokens`. Host `ai:tokenUsageUpdated` includes `{ sessionId, tokenUsage }` and can carry intermediate context as well as end-of-turn totals; the current panel relies on session events plus polling instead of subscribing to it directly. Scope must stay session-specific and generation-guarded. No account quota may be derived from tokens.

The host capability registry says Claude Code/Codex report `context-window`; Copilot reports `none`; Cursor reports `token-counts`. Copilot's ACP parser ignores usage updates and falls back to a zero usage completion; that zero is not a measurement. Cursor maps result `inputTokens + cacheReadTokens + cacheWriteTokens` and `outputTokens` into totals, without an independent fill/window. API chat providers (`claude`, `openai`, `lmstudio`) report token counts, not an independent context snapshot; unknown provider types default to none. Optional extension/custom capabilities require separate verification. Main `BUILTIN_AGENT_CAPABILITIES`, line 35946; Codex notification branch near 62627; accumulation functions 408853/408880/408908 and completion persistence near 410954.

### Account and allowance contracts

**S8 — Claude account.** `claude-code:check-login()` returns login booleans and, on success, `email`, `organization`, `subscriptionType`, and optional token/API-key source fields. Failure returns booleans with optional `error`; it does not return the credential itself. The probe observed Claude Pro and redacted account details. `claude-code:check-installation()` returns `{ installed, version }`. The account handler uses a short SDK account-info query; it is not a session-account binding and should not run on every status tick. No reliable account-change refresh event was established for this integration, so re-check identity at an appropriate account boundary and invalidate uncertain ownership. Main lines 290641/290657.

**S9 — Codex account.** `openai-codex:check-login()` returns bare `{ installed, isLoggedIn, authMode, email, planType, message }`, with optional `error` on failure. The live result was authenticated `chatgpt`/`plus`. The host calls app-server `account/read`, caches status, and broadcasts `openai-codex:auth-updated` and `openai-codex:auth-login-completed`. The update payload is an auth-service status object (`account`, `requiresOpenaiAuth`, `authMode`, `planType`), not the getter shape. Its notification handler can temporarily retain cached email/plan before a full read. No stable account/workspace ID or selected-session account association is exposed by the examined getter. Missing or failed status must not be treated as authenticated just because a quota cache exists. Main `CodexAuthServiceImpl`, line 290935, and handler 291184.

**S10 — Claude allowances.** `claude-usage:get()` returns a cached reading directly, refreshes only when no cache exists, and returns null on an escaped handler failure. Host 0.83.0's parser returns `fiveHour`, `sevenDay`, optional `sevenDayOpus`, `weeklyModelLimits: [{ model, utilization, resetsAt }]`, and numeric epoch-ms `lastUpdated`; windows have percentage `utilization` and nullable reset strings. `weeklyHistory` may also be present. A missing weekly window is defaulted to zero in that host parser, so do not confuse a default with an observed allowance. Host failures return an `error` with zero windows and a new timestamp, not an authenticated zero-percent reading. `claude-usage:refresh`/`activity` trigger work and `claude-usage:update` broadcasts readings; activity polling sleeps after an idle period. The observed getter was old, with a five-hour reset already past, illustrating why returned data must carry freshness.

The panel's preferred direct source remains Anthropic's OAuth usage endpoint through `planUsage.ts`: top-level `five_hour`/`seven_day`, and model-scoped `limits[]` shaped into `scoped`/`allLimits`. Its cache has a 60 s TTL, BOM-tolerant reads, atomic writes, and local-offset timestamps; failures keep the last timestamp and mute it when stale. No credential was read or direct endpoint request made by this audit. The shared file and module cache have no account partition: they describe the Claude login/config source, not necessarily the selected session's account. Keep the current explicit Claude labels beside other providers; account reassociation needs verified identity/invalidation. Main `parseClaudeUsageResponse`, line 425233; service near 425325; getter 425630. The host maps weekly scoped limits now, but no arbitrary credit balance is in that examined projection.

**S11 — Codex allowances and credits.** `codex-usage:get()` returns a bare cached object, otherwise invokes refresh; handler failure returns null. `codex-usage:refresh()` refreshes explicitly and its handler can reject. Normal service failures instead return `{ limits: [], lastUpdated, error }`, potentially with history. `codex-usage:update` broadcasts the same normalized reading; the subscription returned an unsubscribe closure and was disposed after capture.

Account-source shape is `{ limits, rateLimitResetCredits, limitsAvailable, source: 'account', lastUpdated }`, optionally with `weeklyHistory`. Each limit is `{ id, name, planType, windows, credits, individualLimit, rateLimitReachedType }`. Windows are `{ slot: 'primary' | 'secondary', usedPercent, windowDurationMins, resetsAt }`. Durations are minutes, utilization is percent, `lastUpdated` is epoch ms, and reset timestamps are converted from upstream Unix seconds to ISO strings. Do not hardcode 5 h/7 d or translate a missing window to zero. The real account returned one `codex` bucket with 300-minute and 10080-minute windows. The host also converts/deduplicates upstream `rateLimitsByLimitId`, but multiple buckets and individual limits were not observed on this account.

Credits are `{ hasCredits, unlimited, balance }`; the observed balance was the string `"0"`, not a token count or percentage. Reset credits are a separate optional `{ availableCount, credits }` collection; null details and an empty list have different meanings. The sample returned count zero and `[]`. The converter preserves optional individual limit `{ limit, used, remainingPercent, resetsAt }`. Missing credit fields mean unavailable, not zero or unlimited. Positive balances, unlimited plans, reset-credit details, and individual limits were not observed.

The service calls app-server `account/rateLimits/read` first. If that fails or offers no account limits, it scans up to five recent files under the host-resolved Codex sessions directory, with no selected Nimbalyst session filter. The fallback can return `source: 'session'`, quota windows, and/or `tokenUsage: { totalTokens, lastTokens }`; token-only results set `limitsAvailable: false`. Expired windows are filtered, but event observation time/account identity is not retained. Those totals cannot be used as the selected session's totals or context.

Freshness is especially important: the earlier getter in the fixture was **2,398,444 ms old** when captured, reporting 10%/4%. A later explicit refresh reported 18%/5%, emitted an update, and the next getter matched it. The final fixture sequence also shows a fresh timestamp advancing on an explicit refresh. Host polling is 30 minutes while active, sleeps after one hour idle, and is awakened by activity; rate-limit notifications on the separate auth-management app-server also trigger refresh. The getter itself does not enforce a TTL. Conversion stamps processing time, including file fallback, so it is not necessarily original source observation time.

The quota singleton is not keyed by provider account/workspace. Auth updates/logout change auth-service status but do not directly invalidate the usage singleton in the examined code; no stable owner travels with a usage event. A fresh auth read followed by a quota read therefore cannot prove an atomic owner binding. Treat account-source readings as **host signed-in account usage with unverified session association**; suppress any claim that they belong to a particular selected session when association is unknown. Discard uncertain values after auth changes, and never relabel global session-file fallback as current-account quota. [GET-228](https://linear.app/markkinkade/issue/GET-228) requests stable non-secret scope, source observation/fetch times, invalidation, and generation-safe events. No replacement credential reader is required: the basic quota bridge works. Main service 425666; converters 425975/425983/426002; handlers 426054/426066.

The [official Codex app-server documentation](https://learn.chatgpt.com/docs/app-server) describes model, thread-token, account, and rate-limit methods. That is **U** evidence for upstream capabilities, not proof that any arbitrary method is renderer IPC. Nimbalyst's internal usage/auth handlers above are the verified bridge. API-key-only Codex authentication must not be assumed to have ChatGPT subscription windows.

### Switching, fallbacks, and follow-through

The runtime probe read one selected Codex session and a separate Claude session through session/transcript IPC. It read workspace selection before and after and observed the same selected ID; it did **not** change the UI selection or sign out. Fixture-based resolver tests cover selecting the older Claude record despite newer Codex activity and resolving both providers with delayed responses. Those tests exercise the resolver, not the hook's full lifecycle or on-screen switching.

The current hook rejects results from older full refreshes via a generation counter and caches served model by session ID. It still displays the previous completed status until the new refresh lands; cleanup does not itself advance the generation on unmount. Its independent global plan refresh updates previous state without a selection/account generation, and its shared file/module cache has no account partition. Losing the workspace only clears loading, retaining previous values. These are explicit constraints for GET-223: invalidate displayed session readings at a selection boundary, key caches by verified scope, reject late provider/account/workspace results, dispose subscriptions, and invalidate requests on cleanup. Preserve the 1 s/5 s budgets and existing selection precedence.

Unknown/unsupported capability, unauthenticated account, failed request, and old reading are separate states. Do not infer unauthenticated from a generic network error; do not turn unsupported into a plausible high effort, zero usage, full sandbox, or inherited Claude quota. Until GET-229 supplies effective execution status, show workspace policy under its own name and leave effective restrictions unavailable. Until GET-228 supplies ownership, keep quota association explicit and unbound where necessary. GET-224/GET-226 can use these fallbacks without claiming the host gaps are solved.

**Verification boundary:** real handler/source inspection and runtime IPC observations were completed for Claude/Codex; fixture tests and the repository test suite are recorded in the GET-222 implementation comment. UI provider/account switching, logout/relogin, forced offline/unauthenticated failures, compaction/resume in a new turn, late account-event races, Copilot/Cursor/custom-provider execution, and a restarted panel were not tested. Failure paths and launch mappings above are source evidence, not simulated real-user observations. These limitations remain inputs to GET-227 and the two bridge follow-ups; they do not turn this audit into a claim of full integration support.

## Shared status model and adapters (GET-223, 2026-11-24)

The GET-222 audit above records the pre-refactor implementation and host evidence.
The new production path is `useStatus` → `StatusController` → common source
normalization and a provider registry. Renderer chips consume `StatusModel`,
not Claude cache/IPC payloads. `statusPresentation.ts` temporarily projects the
normalized Claude collection onto the existing usage segment IDs. GET-224 owns
further model-card presentation; GET-225 owns dynamic usage/settings migration;
GET-226 owns the production Codex quota collector. No preference keys, segment
IDs, extension identity or release version changed here.

### Contract and source normalization

Every reading carries its source, scope, fetch time, optional observation time,
reason, and an explicit state: available, unsupported, unauthenticated,
unavailable or stale. A network failure is not evidence of sign-out. Refresh
activity is separate from value validity. A cached getter never advances the
source observation time. Unknown observation time remains null; quota values
with unknown or old observation times are muted. Failed refreshes can retain a
same-scope last-successful value as stale, with its original timestamp.

Provider identity prefers the explicit session field, then an unambiguous
catalog provider, then a provider prefix. Unknown IDs stay unknown and use the
generic adapter. An OpenAI API model does not select a Codex/ChatGPT account
reader. Audited capabilities are registered for Claude Code, Codex, Copilot and
Cursor; new integrations can register without adding provider branches to cards.
Generic collection still supplies session/workspace/git facts without quotas.
Copilot's synthetic zero counters do not become measured tokens or context.

The catalog normalizer joins the flat display projection and grouped entries by
provider/model identity. It keeps ambiguous bare IDs distinct. It never uses
flat `maxTokens` as context capacity. Session current context and capacity win;
valid zero fill is 0%. Cumulative, cached and reasoning token counters remain
separate from current fill. Requested and last-observed served models remain
separate too. Remembered served models are keyed by workspace/session/provider/
requested ID, and a transcript-tail miss keeps that answer explicitly stale.
Configured effort is only defaulted for a verified capability; unsupported and
unknown providers do not inherit a made-up High setting. Workspace policy is
separate from effective execution restrictions, which remain unavailable until
GET-229 supplies a verified session-scoped bridge.

Account usage is a collection of buckets/windows, not mandatory five-hour and
seven-day fields. IDs derive from source/semantic identity rather than percent,
reset time or ordering. Returned labels, durations, units, resets, model scope,
optional plans/credits and account scope travel with the reading. Claude's
adapter maps both the direct shared-cache source and the host fallback, including
newer `weeklyModelLimits`. Host errors carrying fresh zero windows are failures.
The fixed chips retain their existing labels, thresholds, global preferences
and cross-provider attribution. Unknown selected providers also qualify/mute
Claude bars; a no-session view still shows the separate Claude plan.

### Ownership, lifecycle and refresh cost

The controller clears old session readings when a selection change is observed,
including changes during initial load or a full refresh. It rejects late session,
transcript, selection-poll and account results after a boundary or cleanup.
Optional transcript/account work cannot block common workspace/session facts.
Provider changes dispose adapter subscriptions and timers, even when the session
ID stays the same. Workspace loss clears the old snapshot before rendering.
Overlapping full refreshes share work within the same generation.

The 1 s selection poll still asks only for workspace state. The full session/git
refresh stays at 5 s. Account work has its own adapter cadence (Claude: 60 s),
with event-triggered reads and in-flight sharing. It no longer calls the Claude
host getter on every full refresh. Consumer cleanup detaches a view; it does not
cancel another consumer's shared request. An ownership invalidation cancels the
old cache epoch and rejects late results.

Normalized account caches are memory-only and partitioned by provider, verified
account ID when available, workspace/config source and auth epoch. Unbound owners
also require a consumer lease. Mismatched owner responses are rejected. Auth
change-detector fields are private in memory; they are neither stable account
IDs nor exported/logged/persisted status. The Claude login check runs at a scope
boundary and on its quota cadence, not every status tick. No reliable immediate
Claude auth-change event was established by the audit, so detection between
those checks is not guaranteed.

Claude's shared file stays in the same location with the same schema, 60 s TTL,
BOM/single-object tolerance, atomic temp/rename writes and local-offset stamps.
Its reading is explicitly unbound Claude-login/config-source usage. This is not
proof of the selected session's account. After a detected auth change the client
ignores that unowned file until a new direct reading succeeds, invalidates its
module result/in-flight work, and suppresses older host singleton snapshots.
No credentials or private login fields are put into extension storage.

GET-228 still owns reliable Codex account ownership/source times and invalidation.
No Codex quota client, credential reader, login mutation or installed-host patch
was added. GET-227 still owns broader restarted-app/provider/account validation.
Automated lifecycle tests use the audited real session/catalog shapes plus
clearly labeled synthetic auth, cancellation, unknown-provider and failure cases;
they do not establish new runtime support for disabled integrations.

Verification for this implementation: `npm test` passed **253 tests across 20
files**; `npx tsc --noEmit`, `npm run build` and `git diff --check` passed.
Node development typings were added for the existing/new fixture-reading tests;
npm also synchronized the lockfile's stale root version to 0.1.7. No new runtime
dependency was added. The running panel was not restarted/reloaded, so real
provider/account switching, failure handling and theme checks on the new bundle
remain unverified. The build alone does not update the mounted extension.

## Marketplace readiness (backlog)

Nothing comparable exists in the registry (`extensions.nimbalyst.com`) — 27 built-ins plus Astro, Electronics Studio, Jupyter, Mindmap, Namenym, Replicad and Slides, none of which surface session state. Publishing would mean closing these gaps, all of which exist because this was built for one machine:

1. **~~Cross-platform usage fetch.~~** Done — nothing is exec'd, so there is no command left to make portable.
2. **~~Stop depending on `~/.claude/get-plan-usage.ps1`.~~** Done — the logic is in `src/lib/planUsage.ts`. One caveat remains: on macOS the host prefers the Keychain for the OAuth token and only falls back to `.credentials.json`, and the renderer cannot reach the Keychain, so a Keychain-only login degrades to `claude-usage:get`.
3. **~~Harden the database dependency.~~** Done — `nimbalyst-database-read` and the raw SQL against `ai_sessions` are both gone. The panel resolves its session through `sessions:list` + `sessions:get`, so the only permission left is `filesystem` and nothing is coupled to an internal schema.
4. **Non-Claude providers.** Still Claude-first, but no longer silently misleading — see [Claude Code support](../README.md#claude-code-support) and the marketplace `longDescription`. ~~Still to decide: hide the irrelevant chips or show honest placeholders.~~ Decided in GET-103, for honest placeholders: beside a session whose provider is not `claude-code`, the plan chips relabel to `Claude 5h` / `Claude 7d` / `Claude 7d Fable`, render in the muted accent rather than green/yellow/red, and name the session's actual provider in their tooltip. GET-223 extends this safeguard to an unknown selected provider. Identity now prefers the explicit session field, then unambiguous catalog metadata, then the model prefix. Model names use the catalog or supplied ID, while quota collection remains Claude-specific. The common contract and adapter registry are in place; dynamic usage settings and other-provider quota collectors remain follow-up work.
5. **Packaging.** ~~Add the `marketplace` block~~ Done — `categories`, `tags`, `icon`, `tagline`, `longDescription`, `highlights` and `changelog` are populated, shaped against `ExtensionMarketplaceMetadata` in `@nimbalyst/extension-sdk/dist/types/extension.d.ts` rather than guessed from `resources/extensions/git/manifest.json`. `tagline`, `longDescription` and `highlights` are the copy shared with this README. ~~A license~~ is done too — MIT, in [LICENSE](../LICENSE) (GET-91); `ExtensionMarketplaceMetadata` has no license field, so `package.json` carries it as `"license": "MIT"`. ~~`repositoryUrl`~~ is set too, now that the repo is public. ~~Delivery~~ is done too — `npm run package` produces a verified `.nimext` and a tag push publishes it (GET-100); see [Releasing](#releasing). ~~Version and author identity~~ are done too (GET-93) — see [Published identity](#published-identity). ~~`screenshots`~~ are done too (GET-94) — `screenshots/status-panel-dark.png` and `-light.png`, wired as one entry's `src` and `srcLight`. An external extension must bundle real PNGs: `fileToOpen`/`selector` drive the internal capture pipeline only, and the registry's own `extensions.nimbalyst.com/screenshots/<id>/` is an R2 bucket nobody outside Nimbalyst can write to. `screenshots/` was already in the packaging script's file list, so the PNGs ship with the `.nimext` as well as heading this README.

Publishing route is settled: **the registry is first-party only.** Every live entry is authored by Nimbalyst under `com.nimbalyst.*`, and `registry.json` is a generated artifact pushed to Nimbalyst's own R2 bucket rather than a file anyone can PR — being listed means a maintainer adds a local path to `packages/marketplace/release-extensions.txt`, which is a favour rather than a process. The docs' offer to "publish an extension you built yourself" has no workflow behind it.

The supported route is the app's own **Install from GitHub**: a public repo whose tagged releases carry a `.nimext` asset, which is what [Install](../README.md#install) documents. The `marketplace` block stays in `manifest.json` either way — the registry generator reads it straight from the manifest, so nothing needs redoing if the route ever opens. (The `marketplace.json` constant in the app bundle points at `anthropics/claude-plugins-official` — that is Claude plugins, a different system.)

## Light and dark

`src/lib/thresholds.ts` keeps the Night Owl palette literal — the point of the port is that a bar which is red in the terminal is red here — and the panel draws it over whatever surface the host theme provides. Those two facts have already collided once: the stale/unavailable bar used `PALETTE.light` (`#d6deeb`), which is Night Owl's *foreground*, meant to sit on dark navy. On a light theme a full bar in it was indistinguishable from an empty one. That path is now `MUTED`, i.e. `var(--nim-text-muted)`, which follows the theme instead of fighting it.

The two captures in the [README](../README.md) (`screenshots/status-panel-dark.png` and `-light.png`) are the standing check. They are the same session 23 seconds apart with nothing changed but the theme, so a fill that vanishes on one surface shows up as a difference between two images rather than as a bug report.

What they actually cover is the green and yellow thresholds on a populated session — Context at 13 %, 5h at 24 %, 7d at 53 % — and the `No scoped caps` empty state. Two things they do not: the red band above 70/80 %, and the `MUTED` rendering itself, which needs either a stale reading or a non-Claude session to appear. Those are covered by tests (`src/StatusPanel.test.tsx`) and, for the non-Claude case, by an on-screen check in GET-103; they are not in these PNGs. Re-capture when a threshold colour changes.

The red band has since been seen on the light theme anyway, incidentally rather than by arrangement: GET-98's checks ran with the 5h window at 83 %, and the bar read as clearly red against the light chip surface. That is one of the two gaps closed by observation, though not by these images.

Cropped to the panel's own bounds. The window around it is not the subject, and a full-window capture would date itself against every unrelated change to the rest of the app.

## Verification checklist

Worked through against the running panel on 2026-09-23 (GET-98). A ticked item
was seen on screen in this app; where a test is the whole of the evidence, the
item says so.

- [x] Panel appears in the bottom panel and under `Ctrl+Shift+S` — the strip sits below the editor, wrapping to a second row at this window width, and `Ctrl+Shift+S` hides it and brings it back. One catch worth knowing: the keybinding acts on whatever has focus, so sent at a window whose editor had focus it did nothing. In a window you have just opened, the panel's icon in the left rail is what mounts it.
- [x] Model, effort, permission mode, directory, branch populate — `Opus 5 (1M) · High · Auto · nimbalyst-status-panel · master` in this repo, and `Sonnet 5 · High · Auto · Nimbalyst Tutorial` in a second workspace, so none of the five is reading a constant. The branch chip drops its `±n` on a clean tree rather than showing `±0`.
- [x] Context bar tracks a live session — it moved 7 % → 8 % → 11 % across this session's own turns, matching `currentContext.tokens` in `ai_sessions.metadata` at every reading (75,914 → 80,114 → 108,707 of 1M). `metadata.tokenUsage` does not lag, so the JSONL fallback this item used to hedge about is not needed. What is *not* live is the `↑input ↓output` pair beside the percentage: it reads `↑0 ↓0` for the whole of a running session, and every finished session in the store has real counts. The percentage — the part the bar draws — is the live half.
- [x] Usage bars show plausible percentages and reset stamps — `5h 53 % ↻10:39` and `7d 63 % ↻Fri 04:59`, the same figures the endpoint's cache held, with both `resets_at` values (`14:39:59Z` and `Sep 25 08:59:59Z`) rendered in local time.
- [ ] The scoped `7d Fable` bar specifically — **not observable on this account**, rather than unchecked. The endpoint's `limits[]` currently carries only the `session` and `weekly` groups and neither has a `scope.model`, so `scopedLimits()` yields nothing and the chip correctly reads `No scoped caps`. Closing this needs an account that has a model-scoped cap; another pass here will not do it.
- [x] Usage endpoint reachable from the renderer, credentials read, cache written atomically and read back by `Get-PlanUsage`
- [x] `statusline.ps1` still renders correctly after the extraction
- [x] Light and dark themes both legible — captured at 1:1 on both surfaces, green and yellow thresholds plus the `No scoped caps` empty state (GET-94); see [Light and dark](#light-and-dark) for what those two images do *not* cover
- [x] Empty states: no session, not a git repo, usage unavailable offline — all of them, plus the denied-permission case, are covered by `src/emptyStates.test.tsx` (GET-97). Three are also confirmed on screen, in a workspace with no `.git` and an unprompted session: `No repo`, `Context —` and `No scoped caps` together in one strip. `not a git repo` got there the hard way — it rendered as `Branch —` until GET-98, see [What the checklist turned up](#what-the-checklist-turned-up). The offline reading is the one still resting on its test alone.
- [x] The plan chips degrade to `Claude 5h` in the muted accent beside a non-Claude session, keeping the number and dropping the urgency colour (GET-103) — `src/StatusPanel.test.tsx`, `src/lib/provider.test.ts`
- [x] The same degradation seen on screen in the running panel after a restart (GET-103)
- [x] A session from another provider renders every segment rather than throwing — `src/StatusPanel.test.tsx` builds the strip from the record Nimbalyst wrote for a real `openai-codex` session (GET-89)
- [x] The same strip seen on screen in the running panel, with a `gpt-5.6-luna` Codex session resolved (GET-89)
- [x] `npm run package` produces an archive whose top-level `manifest.json` parses under an independent zip reader, with no `src/` or source maps in it
- [x] `v0.1.3` published by the release workflow, and the app's own resolve-download-extract path replayed against it: `/releases/latest` returns the tag, `selectReleaseAsset` picks the `.nimext`, it extracts with `manifest.json` on top and `dist/` where the manifest points, both `screenshots/` PNGs are present at the sizes the manifest points to, and the published `.sha256` matches the published asset
- [ ] The same thing on a *clean* machine, through the real UI rather than a replay of its logic — Windows (GET-95) and macOS/Linux (GET-96)

### What the checklist turned up

`getGitInfo` read `git:is-repo` as a `boolean`. The channel answers with a
wrapper — `{ success: true, isRepo }`, or `{ success: false, error, isRepo:
false }` when the check throws — so the answer is an object, and truthy
whichever way it answers. Every folder therefore resolved as a repo: a
workspace with no `.git` anywhere above it showed `Branch —` and the tooltip
`git:branches returned no current branch`, when the truth was that there was no
repository at all. The `No repo` half of that chip could not be reached in the
running app.

The empty-state suite did not catch it because it hands `buildSegments` a
`repoPath: null` directly. That proves the placeholder renders; it cannot prove
anything ever produces the state. The gap was only visible by opening a
workspace that is not a repo and looking at the strip. `src/lib/ipc.test.ts`
now covers `getGitInfo` against the shape the channel actually sends, and the
chip was checked on screen both ways after the fix: `No repo` in a folder with
no `.git`, `master ±3` in this repo with three files modified.

Worth repeating for anyone verifying a change here: a rebuild is not enough and
neither is `extension_reload`. Both were done before that check and the
renderer went on running the previous day's bundle — visibly polling, with the
usage bar climbing — so the fix appeared not to work. Only restarting the app
picked it up.

Worth carrying forward when another channel is added: the three git channels do
not agree with one another. `git:is-repo` and `git:get-uncommitted-files` wrap
their answers in `{ success, ... }`; `git:branches` returns `{ branches, current
}` bare. Each has to be read on its own terms, which is why `invoke` stays a
thin pass-through instead of unwrapping centrally.

