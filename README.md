# Status Panel

*The Claude Code status line as a bottom panel.*

A Nimbalyst bottom panel that mirrors the Claude Code CLI status line (`~/.claude/statusline.ps1`) for the active Agent session, so SDK-backed sessions show the same information the terminal REPL does.

**Status:** implemented and building. Not yet installed into Nimbalyst or verified live — see [Install](#install).

## Claude Code only

v1 is built for Claude Code sessions, and that is a deliberate limit rather than an oversight — per-provider behaviour is deferred. Install it expecting Claude; do not install it expecting Copilot, Cursor or Codex support.

What that means on a session from another provider:

- **Model** — the chip matches the session's model id against the whole model catalog, so a non-Claude model usually still resolves to a name. When it does not, the fallback in `src/lib/modelNames.ts` only knows `claude-code:` ids, and the raw id is shown instead.
- **5h / 7d / scoped caps** — these read Anthropic's plan-usage endpoint with your Claude OAuth token. They report *your Claude plan*, not the focused session, so alongside a Copilot session they are unrelated numbers.
- **Effort, permission mode, directory, branch** — provider-neutral; these work the same either way.
- **Context** — comes from the session's own `metadata.tokenUsage`, so it populates for any provider that records it and reads `Context —` otherwise.

Confirmed on screen against a live `openai-codex` session (GET-89): every chip renders, the model reads as the raw `openai-codex:gpt-5.6-luna`, and the Context bar is fully populated at `15% ↑38.3K ↓35`. Nimbalyst writes `metadata.tokenUsage` with `currentContext` for Codex exactly as it does for Claude Code, so Context is not a per-provider gap — it is empty only until a session has been prompted once, which is true of any provider.

Two rough edges did show up there, and both are about *which* session the strip describes and *whose* limits it reports:

- **The strip follows the most recently updated session, not the one you are looking at.** Switching to a Codex session in the UI does not move the chips; prompting it does. `metadata.metadata.lastReadAt` is the signal that would fix this — `setActiveSessionAtom` calls `markSessionReadAtom` unconditionally on every active-session change, which persists `lastReadAt` through `ai:updateSessionMetadata` and broadcasts the `sessions:session-updated` the panel already listens for. Ranking candidates by `lastReadAt`, falling back to `updatedAt`, would track the visible session without needing the renderer atom `session:get-active` refuses to expose.
- **The 5h / 7d / scoped bars keep reporting the Claude plan** next to a session that has nothing to do with it, with no visual hint that they are unrelated.

Turning the usage chips off in the gear popover is the practical workaround until per-provider behaviour is decided.

## Why a panel

Nimbalyst's Agent toolbar is a fixed React component — the `Context Breakdown` chip is `data-testid="context-indicator"`, not a pluggable slot. The extension manifest offers no toolbar or status-bar contribution point. `contributions.panels` is the supported surface for custom UI, so the status line becomes a bottom panel: `Ctrl+Shift+S`, or `Ctrl+J` and pick the tab.

Trade-off to live with: the SDK documents bottom panels as "mutually exclusive with other bottom panels (terminal, tracker)" (`@nimbalyst/extension-sdk/dist/types/panel.d.ts`). A status line you want permanently visible therefore competes with the terminal for the same slot. If that proves annoying in practice, `sidebar` placement or a `floating` panel are the escape hatches.

## Segments

Rendered as a chip strip, in status-line order:

| Chip | Content |
| --- | --- |
| Model | Display name from the model catalog, falling back to the raw session model id |
| Effort | `High` etc., title-cased |
| Permission mode | `Bypass` / `Auto` / `Plan` / `Default`, color-coded as in the script |
| Directory | Repo root folder name when in a git repo, else the workspace folder |
| Branch | Current branch, with `±n` uncommitted-file count |
| Context | 10-cell bar, percentage, `↑input ↓output` counts |
| 5h / 7d | Plan utilization bars with reset stamps |
| Scoped caps | Model-scoped limits from the API's `limits[]`, e.g. `7d Fable` |

Chips are centered in the strip, and a gear chip at the end opens a popover for choosing which segments appear and in what order (checkbox + up/down, with Reset). The choice is persisted through `host.storage.setGlobal`, so it follows you across workspaces rather than resetting per project. A stored config is reconciled against the current segment list on load, so segments added in a later version appear instead of silently vanishing.

### Deferred

- Clock (local + TZ abbreviation, UTC)
- Current-turn stopwatch and tool-call count
- Fast mode chip

## Decisions

1. **Session tracked** — follows the focused session. Nimbalyst keeps focus in a renderer atom extensions cannot read (`session:get-active` is a stub returning `null`), so this resolves to *the most recently updated session in the workspace*, re-queried on every session broadcast. In practice that is the session you are talking to. If it ever picks wrong, the fallback is a session picker pinned via `host.storage`.
2. **Permission mode** — the workspace value (`agentPermissionMode`), not the per-session Shift+Tab mode the script parses out of the transcript. There is no stored `auto` value: `agentPermissions.permissionMode` of `bypass-all` combined with `allowAllUsesClassifier: true` is what Nimbalyst launches as auto mode, so the panel reports that pair as `Auto` and keeps `Bypass` for `bypass-all` with the classifier off.
3. **Refresh** — event subscriptions (`sessions:session-updated`, `sessions:session-created`, `sessions:refresh-list`, `claude-usage:update`, and the `open-ai-session` window event) plus a 5 s timer for values nothing broadcasts.
4. **Layout** — horizontal chip strip, wrapping.
5. **Keybinding** — `Ctrl+Shift+S`. Verified free: Nimbalyst's `file` shortcut group has no `saveAs` entry and nothing in the app binds `Shift+S`.

## Architecture

Panels run in Nimbalyst's renderer and receive a `host` prop (`{ host }`, per `PanelContainerInner`), with `window.electronAPI` available for IPC — the same approach the bundled Git panel uses.

```
src/
  index.ts            # exports { panels, activate, deactivate }
  StatusPanel.tsx     # chip strip
  useStatus.ts        # subscriptions + 5s timer, generation-guarded
  components/Chip.tsx      # Chip + Bar
  components/ConfigChip.tsx # gear chip + segment picker popover
  segments.ts         # segment registry, default order, config reconciliation
  useSegmentConfig.ts # load/save config via host.storage global scope
  lib/ipc.ts          # typed, failure-tolerant wrapper over electronAPI
  lib/planUsage.ts    # reads the credentials file and calls the usage API directly
  lib/format.ts       # formatTokens / formatResetTime / labels, ported from the .ps1
  lib/thresholds.ts   # Night Owl palette + bar thresholds, ported from the .ps1
```

### Data sources

| Segment | Channel |
| --- | --- |
| Session | `sessions:list(workspacePath, opts)` → newest → `sessions:get(id)` |
| Model / context window | `ai:getModels()` matched on `session.model` |
| Effort | `ai:getEffectiveSettings`, falling back to `settings:get-default-effort-level` |
| Permission mode | `app-settings:get("agentPermissionMode")`, falling back to `workspace:get-state` |
| Branch / dirty | `git:is-repo`, `git:branches`, `git:get-uncommitted-files` |
| Tokens | `session.metadata.tokenUsage` |
| Plan usage | `api.anthropic.com/api/oauth/usage`, falling back to `claude-usage:get()` |

### Plan usage

`claude-usage:get` maps only `five_hour`, `seven_day`, and `seven_day_opus` — the API's `limits[]` array, which carries model-scoped caps like `7d Fable`, never reaches the renderer. Since that is the cap most likely to bite, the panel calls the usage endpoint itself.

`src/lib/planUsage.ts` reads the OAuth token from `.credentials.json`, `GET`s `https://api.anthropic.com/api/oauth/usage` with `anthropic-beta: oauth-2025-04-20`, and shapes the response the way `~/.claude/get-plan-usage.ps1` does — including `allLimits`, the diagnostic record of every entry in `limits[]`. Nothing is spawned; both files are reached through `read-global-claude-file` / `write-global-claude-file`, which resolve the Claude config directory host-side and honour `CLAUDE_CONFIG_DIR`. `permissions.filesystem` is still required, because that is what gates reading the credentials file.

`statusline.ps1` still dot-sources `get-plan-usage.ps1`, and the panel still shares `statusline-usage-cache.json` with it, so whichever renders first pays for the API call. Sharing that file means honouring its discipline in both directions:

- **60 s TTL** — a cache younger than that is returned as-is, so the panel and the status line do not double-fetch.
- **Atomic writes** — a temp file per renderer, then a rename. `write-global-claude-file` truncates before writing, so writing the cache path directly is what used to leave it at zero bytes.
- **Tolerant reads** — empty, truncated, or unparseable is treated as absent. Note the reader must `trim()` before `JSON.parse`: Windows PowerShell writes a UTF-8 BOM, which `JSON.parse` rejects outright.
- **Local timestamps** — written as `2026-09-18T17:56:57.983-04:00`, not `toISOString()`. `ConvertFrom-Json` coerces the field to a `[DateTime]`, and a trailing `Z` comes back `Kind=Utc`, which the status line's age expression re-reads as a local wall clock; the age goes negative, `-lt 60` holds, and the CLI serves that reading as fresh for hours.

Failures are quiet by design — no credentials, unreadable file, network error, 401, 429 — and fall back to the last cached reading, whose older timestamp is what makes the chips render as stale. That includes the console: the usage path reaches the host through `invokeQuiet`, so a channel the host cannot answer costs a `console.debug` rather than a `console.warn` every minute the panel is open. `claude-usage:get` remains the fallback when there is no reading at all, in which case the scoped bars are simply absent.

Formatting, thresholds, and the palette are ported verbatim so a bar that is red in the terminal is red here.

## Install

Requires Extension Dev Tools (Settings → Advanced). **The `extension_*` MCP tools attach at session start**, so after enabling the setting, restart Nimbalyst or start a new AI session before installing.

```
npm install
npm run build        # -> dist/index.js, dist/index.css
npm test             # cache, throttle and staleness discipline in the usage client
```

Then from a session that has the dev tools:

```
extension_install({ path: "C:\\Users\\Mark Kinkade\\source\\repos\\nimbalyst-status-panel" })
extension_get_status({ extensionId: "com.mkinkade.status-panel" })
```

Iterate with `extension_reload({ extensionId, path })`.

## Marketplace readiness (backlog)

Nothing comparable exists in the registry (`extensions.nimbalyst.com`) — 27 built-ins plus Astro, Electronics Studio, Jupyter, Mindmap, Namenym, Replicad and Slides, none of which surface session state. Publishing would mean closing these gaps, all of which exist because this was built for one machine:

1. **~~Cross-platform usage fetch.~~** Done — nothing is exec'd, so there is no command left to make portable.
2. **~~Stop depending on `~/.claude/get-plan-usage.ps1`.~~** Done — the logic is in `src/lib/planUsage.ts`. One caveat remains: on macOS the host prefers the Keychain for the OAuth token and only falls back to `.credentials.json`, and the renderer cannot reach the Keychain, so a Keychain-only login degrades to `claude-usage:get`.
3. **~~Harden the database dependency.~~** Done — `nimbalyst-database-read` and the raw SQL against `ai_sessions` are both gone. The panel resolves its session through `sessions:list` + `sessions:get`, so the only permission left is `filesystem` and nothing is coupled to an internal schema.
4. **Non-Claude providers.** Deferred for v1 and documented instead — see [Claude Code only](#claude-code-only) and the marketplace `longDescription`. Sessions on Codex/Copilot/Cursor render a strip whose usage chips are about the Claude plan rather than that session. Still to decide: hide the irrelevant chips or show honest placeholders.
5. **Packaging.** ~~Add the `marketplace` block~~ Done — `categories`, `tags`, `icon`, `tagline`, `longDescription`, `highlights` and `changelog` are populated, shaped against `ExtensionMarketplaceMetadata` in `@nimbalyst/extension-sdk/dist/types/extension.d.ts` rather than guessed from `resources/extensions/git/manifest.json`. `tagline`, `longDescription` and `highlights` are the copy shared with this README. Still open: `screenshots` (an external extension must bundle real `src` PNGs — `fileToOpen`/`selector` drive the internal capture pipeline only), `repositoryUrl` (no git remote is configured yet), a license, and a real version (GET-93).

Publishing route is unconfirmed: the app only consumes the registry, with no in-app submit path. Start at `docs.nimbalyst.com/extensions`. (The `marketplace.json` constant in the app bundle points at `anthropics/claude-plugins-official` — that is Claude plugins, a different system.)

## Verification checklist

Nothing below has been exercised against a running instance yet.

- [ ] Panel appears in the bottom panel and under `Ctrl+Shift+S`
- [ ] Model, effort, permission mode, directory, branch populate
- [ ] Context bar tracks a live session (the one source not yet confirmed — if `metadata.tokenUsage` lags, fall back to parsing the session JSONL as the script does)
- [ ] Usage bars show plausible percentages and reset stamps, including the scoped `7d Fable` bar
- [x] Usage endpoint reachable from the renderer, credentials read, cache written atomically and read back by `Get-PlanUsage`
- [x] `statusline.ps1` still renders correctly after the extraction
- [ ] Light and dark themes both legible
- [ ] Empty states: no session, not a git repo, usage unavailable offline
- [x] A session from another provider renders every segment rather than throwing — `src/StatusPanel.test.tsx` builds the strip from the record Nimbalyst wrote for a real `openai-codex` session (GET-89)
- [x] The same strip seen on screen in the running panel, with a `gpt-5.6-luna` Codex session resolved (GET-89)
