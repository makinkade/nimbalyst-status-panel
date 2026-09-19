# Status Panel

A Nimbalyst bottom panel that mirrors the Claude Code CLI status line (`~/.claude/statusline.ps1`) for the active Agent session, so SDK-backed sessions show the same information the terminal REPL does.

**Status:** implemented and building. Not yet installed into Nimbalyst or verified live — see [Install](#install).

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

Failures are quiet by design — no credentials, unreadable file, network error, 401, 429 — and fall back to the last cached reading, whose older timestamp is what makes the chips render as stale. `claude-usage:get` remains the fallback when there is no reading at all, in which case the scoped bars are simply absent.

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

1. ~~**Cross-platform usage fetch.**~~ Done — nothing is exec'd, so there is no command left to make portable.
2. ~~**Stop depending on `~/.claude/get-plan-usage.ps1`.**~~ Done — the logic is in `src/lib/planUsage.ts`. One caveat remains: on macOS the host prefers the Keychain for the OAuth token and only falls back to `.credentials.json`, and the renderer cannot reach the Keychain, so a Keychain-only login degrades to `claude-usage:get`.
3. **Harden the database dependency.** `nimbalyst-database-read` plus raw SQL against `ai_sessions` is coupled to an internal schema that can change between releases. Keep the `sessions:list` fallback genuinely working, and fail soft if the query throws.
4. **Non-Claude providers.** Sessions on Codex/Copilot/Cursor render a sparse strip. Decide between hiding irrelevant chips and showing honest placeholders.
5. **Packaging.** Add the `marketplace` block (categories, tags, icon, tagline, longDescription, highlights, screenshots — see `resources/extensions/git/manifest.json`), a license, a repo link, and a real version.

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
