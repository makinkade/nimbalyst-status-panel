# Nimbalyst Status Panel — instructions for coding agents

Read this file at the start of any work in this repository. It is the shared,
in-repository source of truth for agents working alongside Mark Kinkade. If you
learn something durable and non-obvious, propose adding it here or to
`docs/development-notes.md`.

## Project and product behavior

Status Panel is an extension for Nimbalyst, an AI-native desktop code editor built
with Electron and React that hosts Claude Code, Codex, Copilot, and Cursor agent
sessions. The extension adds a strip of chips to Nimbalyst's bottom panel,
mirroring the Claude Code CLI status line for the session selected in the editor.

| Chip | Shows |
| --- | --- |
| Model | Session model display name, e.g. `Opus 5.5 (1M)` |
| Effort | Reasoning effort, e.g. `High` |
| Permission mode | Color-coded `Bypass` / `Auto` / `Plan` / `Default` |
| Directory | Repo root folder name, or workspace folder outside a git repo |
| Branch | Current branch plus `±n` uncommitted-file count; `No repo` outside git |
| Context | Context-window usage bar, percentage, and `↑input ↓output` tokens |
| 5h / 7d | Claude plan utilization bars with reset times |
| Scoped caps | Model-scoped plan limits, e.g. `7d Fable` |
| Gear | Popover for selecting and reordering segments, toggling behaviors, and seeing the running version |
| Update | Appears only when a newer GitHub release exists |

Bars turn yellow, then red, as limits approach. Readings that cannot be refreshed
render muted so stale numbers do not look current. Every segment without data
explains why (`No repo`, `Context —`, `No scoped caps`) instead of disappearing.

- Public repository: https://github.com/makinkade/nimbalyst-status-panel
- License: MIT, © 2026 Mark Kinkade.
- Extension id: `com.mkinkade.status-panel`. Preserve it: changing it breaks
  update matching.
- Current version at the time of this briefing: `0.1.7`.
- Default branch: `master`. Work has been committed directly to master.
- `Ctrl+Shift+S` toggles the panel through
  `com.mkinkade.status-panel.status-line.toggle`.
- User installation: Nimbalyst → Settings → Extensions → Marketplace →
  *Install from GitHub*, then paste the repository URL. Re-pasting the URL
  upgrades the extension in place.

The extension is Claude Code first. Beside a Codex, Copilot, or Cursor session,
the plan chips relabel to `Claude 5h` / `Claude 7d`, render muted instead of
green/yellow/red, and name the actual session provider in their tooltip. Never
imply that these readings report another provider's quota.

## Stack and commands

Use TypeScript, React 18, Vite 7 through `@nimbalyst/extension-sdk/vite`, Vitest 5,
and adm-zip.

- `npm install` installs dependencies.
- `npm run build` writes `dist/index.js` and `dist/index.css`. `dist/` is
  intentionally gitignored.
- `npm test` runs Vitest. Run it before calling any change done.
- `npm run package` performs a clean build, then creates
  `build/status-panel-<version>.nimext` and its `.sha256`.
- `npm run package -- --no-build` packages the existing `dist/`.
- `vite.config.ts` bakes `manifest.json` fields `version` and
  `marketplace.repositoryUrl` into the bundle as `__PANEL_VERSION__` and
  `__PANEL_REPOSITORY_URL__`.

## Repository layout

```text
manifest.json               # id, version, permissions, panel, keybinding, marketplace copy + changelog
src/
  index.ts                  # exports { panels, activate, deactivate }; auto-open + panel keeper wiring
  StatusPanel.tsx           # chip strip
  useStatus.ts              # generation-guarded data subscriptions + timers
  segments.ts               # segment registry, default order, config reconciliation
  useSegmentConfig.ts       # config load/save via host.storage, global scope
  panelKeeper.ts            # reopen on host dismissal; DOM-free and testable
  useUpdateCheck.ts         # cached, throttled, silent newer-GitHub-release check
  components/Chip.tsx
  components/ConfigChip.tsx
  components/UpdateChip.tsx
  lib/ipc.ts                # typed, failure-tolerant window.electronAPI.invoke wrapper
  lib/planUsage.ts          # Claude OAuth credentials, Anthropic usage endpoint, shared cache
  lib/modelNames.ts         # parse model chip labels from ids; no version lookup table
  lib/provider.ts           # session.provider, then model-id prefix
  lib/releaseCheck.ts       # GitHub releases client: version parsing, cache, throttle
  lib/marketplace.ts        # install-from-github / install record / open-external; manual fallback
  lib/buildInfo.ts          # baked-in version + repo URL
  lib/format.ts             # formatting and Night Owl palette
  lib/thresholds.ts         # bar thresholds
  *.test.ts(x)              # Vitest suites beside the code
scripts/package.mjs         # builds .nimext; re-verifies with installer's own checks
docs/development-notes.md   # decisions, data sources, release process, verification log
.github/workflows/release.yml # v* tag → test, package, GitHub release
screenshots/                # status-panel-dark.png / status-panel-light.png; shipped in package
```

## Host architecture and data sources

Nimbalyst has no toolbar or status-bar contribution point.
`contributions.panels` with `placement: "bottom"` is the only supported surface.
Bottom panels share one slot with the terminal and other bottom panels.

Panels run in Nimbalyst's renderer, receive a `host` prop, and invoke host IPC
through `window.electronAPI.invoke(channel, ...args)`.

| Data | Source and precedence |
| --- | --- |
| Session | `workspace:get-state` → `agenticCodingWindowState.selectedWorkstream` (UI selection); then `metadata.metadata.lastReadAt`; then newest `updated_at`. Resolve through `sessions:list` + `sessions:get`. |
| Model | Latest main-thread assistant turn's served model id from `transcript:get-tail-messages`, parsed (e.g. `claude-opus-5-5` → Opus 5.5); `ai:getModels()` name as fallback. |
| Context window | `ai:getModels()` matched on `session.model`. |
| Effort | `ai:getEffectiveSettings`, falling back to `settings:get-default-effort-level`. |
| Permission mode | `app-settings:get("agentPermissionMode")`, falling back to `workspace:get-state`. `bypass-all` plus `allowAllUsesClassifier: true` means `Auto`. |
| Branch / dirty | `git:is-repo`, `git:branches`, `git:get-uncommitted-files`. |
| Tokens | `session.metadata.tokenUsage`. |
| Plan usage | `GET https://api.anthropic.com/api/oauth/usage` with header `anthropic-beta: oauth-2025-04-20`, falling back to `claude-usage:get()`. |

Refresh through subscriptions to `sessions:session-updated`,
`sessions:session-created`, `sessions:refresh-list`, `claude-usage:update`, and the
`open-ai-session` window event. Poll only `workspace:get-state` every 1 s to catch
selection changes, because nothing broadcasts them. Keep the full refresh at
5 s: it shells out to git three times.

Historical documentation warning: `docs/development-notes.md`, "Decisions" item 1,
still said the panel tracked "the most recently updated session" at briefing
time. That description is outdated. Since GET-102, the panel follows persisted
selection as described above; see `src/lib/ipc.ts`. Do not reintroduce the old
behavior based on that note.

## Claude plan usage and shared cache

`src/lib/planUsage.ts` reads Claude's OAuth token from `.credentials.json` using
host channels `read-global-claude-file` / `write-global-claude-file`. This is why
the manifest requests `permissions.filesystem`.

It shares `~/.claude/statusline-usage-cache.json` with Mark's terminal status line:
`~/.claude/statusline.ps1` uses `~/.claude/get-plan-usage.ps1`, the PowerShell
original from which the TypeScript implementation was ported. Preserve this
strict cache contract:

- TTL is 60 s. Use a younger cache as-is.
- Write atomically: write a temporary file, then rename it. Never write directly
  to the cache path.
- Read tolerantly: empty or unparseable content means absent. Call `trim()` before
  `JSON.parse`, because Windows PowerShell writes a UTF-8 BOM.
- Use timestamps with the **local offset**, e.g.
  `2026-09-18T17:56:57.983-04:00`. Never use `toISOString()`: a trailing `Z` makes
  the PowerShell reader compute a negative age and serve stale data as fresh.
- Fail quietly for missing credentials, 401, 429, and offline failures. Fall back
  to the last reading and render it muted.

Formatting, thresholds, and the Night Owl palette are ported verbatim from the
PowerShell script. Preserve parity: a red terminal bar must be red here.
Muted/stale rendering uses `var(--nim-text-muted)` to remain legible on light
themes.

## Keeping the panel open

Nimbalyst closes every bottom panel on every window-mode set and never restores
a bottom panel id. `panelKeeper.ts` reopens the panel after host dismissal while
respecting deliberate closes. The `Ctrl+Shift+S` toggle event and a click on the
panel's gutter button count as closing gestures.

The keeper acts only after the panel has been seen open, waits while the terminal
or another bottom panel holds the slot, and stops after 3 reopens that change
nothing. Keep it DOM-free and testable.

## Self-update behavior

`releaseCheck.ts`, `useUpdateCheck.ts`, `UpdateChip.tsx`, and `marketplace.ts`
implement self-update. Nimbalyst never auto-updates GitHub-installed extensions,
so the panel polls `api.github.com/repos/<owner>/<repo>/releases/latest`.

Preserve these rules:

- Persist a 6-hour TTL in global extension storage, with a 30-minute floor.
- Share an in-flight promise and delay the first check by 8 s.
- Advance `checkedAt` only after a completed check.
- Parse only stable tags; `v0.2.0-beta.1` must not parse.
- Fail silently: no error chip and no spinner.
- *Behavior → Check for updates* in the gear popover disables the network request
  entirely.
- Install through `extension-marketplace:install-from-github`. It is reachable
  but **not a supported API**, so degrade to manual "re-paste the URL"
  instructions when needed.
- Never install without a user click. The user must restart afterwards.

## Gotchas to check before changing code

1. **IPC channels have no common return shape.** `git:is-repo` returns
   `{ success, isRepo }`; `git:get-uncommitted-files` returns `{ success, files }`;
   `git:branches` returns bare `{ branches, current }`. Wrapper objects are truthy
   either way: check `Boolean(r?.success && r.isRepo)`. Keep `invoke` a thin
   pass-through; never unwrap centrally. Verify each channel's actual shape.
2. **Read Nimbalyst's own source when necessary.**
   `C:\Program Files\Nimbalyst\resources\app.asar` is unminified.
   `grep -a -o -b '"channel:name"'` on it, followed by `dd` of a window around the
   offset, reveals the real handler. Most host behavior here was established
   this way.
3. **Building does not update the running panel.** The development install is a
   symlink to the repository; the renderer retains the module it loaded. Even
   `extension_reload` often has no effect. Only restarting Nimbalyst reliably
   runs new code. Never claim a change is live just because a build passed.
4. **The packaged renderer console is inaccessible.** To observe runtime state,
   write a probe with `host.storage.setGlobal(key, value)`, then read
   `%APPDATA%\@nimbalyst\electron\app-settings.json` → `extensionStorage` →
   `ext:com.mkinkade.status-panel:<key>`. Remove probe keys afterwards.
5. **Unit tests can miss host-shape bugs.** Hand-built state such as
   `repoPath: null` proves the UI renders that state, not that anything produces
   it. Test against shapes the host actually sends.
6. **Do not use model-name version lookup tables.** Parse the served model id so
   new models do not require a release.
7. **Do not access the database directly.** Direct SQL against Nimbalyst's
   `ai_sessions` / `ai_agent_messages` was removed deliberately. Use session and
   transcript IPC channels.
8. **Target Mark's platform.** Mark uses Windows 11 and PowerShell 7. Anything
   launching a shell, including scripts and scheduled tasks, must use
   `C:\Users\Mark Kinkade\AppData\Local\Microsoft\WindowsApps\pwsh.exe`.
   `powershell.exe` is 5.1; versioned `Program Files\WindowsApps\...` paths break
   on upgrades. Keep task scripts 5.1-parseable: no `??`, `?.`, or ternaries.

## Release rules

The git tag (currently `v0.1.7`), `manifest.json` `version`, and `package.json`
`version` must agree. Both the workflow and `npm run package` refuse to run when
they disagree. Bump all three together, and add a `marketplace.changelog` line in
`manifest.json`; it becomes the release notes.

Pushing a `v*` tag triggers `.github/workflows/release.yml`: `npm ci`,
tag/manifest check, `npm test`, `npm run package`, then
`gh release create --latest` with the `.nimext` and `.sha256` assets. This
describes the release process; it does not authorize agents to commit or push.

A `.nimext` is a zip containing `manifest.json` at the **top level**, plus
`dist/index.js`, `dist/index.css`, `screenshots/*.png`, `README.md`, and `LICENSE`.
Exclude `src/`, `node_modules/`, and source maps. A broken asset causes a hard
install failure with no fallback, so the package script re-verifies the archive
using the installer's own checks.

Nimbalyst's extension registry is first-party only. Distribute through
*Install from GitHub* and GitHub releases.

## Agent workflow and collaboration with Mark

- **Tickets live in Linear.** Use team "Mark Kinkade", prefix `GET-` (e.g.
  GET-111), and project "Status Panel - publish to Nimbalyst registry". States
  are Backlog, Feature Request, Todo, In Progress, In Review, Done, Canceled,
  Duplicate. Move a ticket to In Progress when starting. When work is ready,
  move it to In Review and comment with what changed, why, and how it was
  verified. Move it to Done after it is committed. If Linear cannot be reached,
  give Mark the comment text instead.
- **Mark makes every commit himself.** Never run `git commit` or `git push`, and
  never stage or unstage anything, unless Mark explicitly asks. Leave changes
  uncommitted for review.
- **Use Mark's commit-message format when asked.** Subject:
  `GET-NN: <ticket title verbatim>`, then a blank line and a plain-language body
  wrapped at about 72 columns. Explain what changed for the user and why, then
  changes by area, then `Verified:` listing checks actually run. End with
  `Refs GET-NN`, or `Fixes GET-NN` when closing the ticket. No co-author trailers.
  Older history uses `feat:` / `fix:` / `docs:` / `chore:` prefixes; release
  messages use `chore: release X.Y.Z`.
- **Report verification honestly.** State checks actually run, including test
  counts, builds, and on-screen checks, and say what was not checked. A build
  does not verify the running app.
- **Write for people.** README text, changelog entries, tooltips, and Linear
  comments should plainly explain what changed for the user, not implementation
  history.
- **Preserve comments explaining why.** The codebase uses JSDoc comments to
  record reasons, often naming a ticket. Keep that style; do not remove these
  comments as noise. Odd-looking details such as `.trim()` and local-offset
  timestamps have reasons documented in code or `docs/development-notes.md`.
- **Keep documentation aligned with behavior.** Update `README.md`,
  `docs/development-notes.md`, and the `manifest.json` marketplace copy wherever
  a behavior change affects their descriptions.

## Working alongside Claude Code

Claude Code (Anthropic's coding agent running inside Nimbalyst) works in the same
repository, sometimes concurrently.

- Run `git status` before starting. Uncommitted changes you did not make may be
  Claude's in-progress work. Do not revert, reformat, or overwrite them. Ask Mark
  if ownership or safe handling is uncertain.
- Claude keeps its own notes outside the repository. Use this `AGENTS.md` as the
  shared in-repository source of truth. Put durable project knowledge here or in
  `docs/development-notes.md`, rather than leaving it only in chat.
- Follow the same conventions so work from either assistant looks consistent.
