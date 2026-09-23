# Status Panel

*A Nimbalyst bottom panel showing model, context usage and plan limits for the session you are talking to.*

Status Panel adds a strip of chips to Nimbalyst's bottom panel that tracks the focused Agent session: which model it is running, at what reasoning effort and permission mode, where it is working, and how much of the context window and of your Claude plan you have used. Everything updates live as the session runs.

![The chip strip on a dark theme: model, effort, permission mode, directory, branch, context usage and Claude plan limits](screenshots/status-panel-dark.png)

![The same chip strip on a light theme](screenshots/status-panel-light.png)

## What it shows

| Chip | Content |
| --- | --- |
| Model | Display name of the session's model |
| Effort | Reasoning effort, e.g. `High` |
| Permission mode | `Bypass` / `Auto` / `Plan` / `Default`, color-coded |
| Directory | Repo root folder name when in a git repo, else the workspace folder |
| Branch | Current branch, with `±n` uncommitted-file count |
| Context | Usage bar, percentage, and `↑input ↓output` token counts |
| 5h / 7d | Claude plan utilization bars with reset times |
| Scoped caps | Model-scoped plan limits, e.g. `7d Fable` |

Bars turn yellow and then red as a limit gets close, and a reading the panel could not refresh is drawn muted so a stale number does not look like a current one.

## Usage

Open the panel from its icon in the left rail, or toggle it with **Ctrl+Shift+S**. It also appears in the bottom panel group under `Ctrl+J`.

The gear chip at the end of the strip opens a picker for which segments appear and in what order. That choice is stored globally, so it follows you from workspace to workspace instead of resetting per project.

## Staying up to date

Nimbalyst does not auto-update extensions installed from GitHub, so the panel checks for itself. Every few hours it asks GitHub whether this repo has a newer release, and if one exists an **Update** chip appears at the end of the strip. Clicking it shows what changed and offers to install — never automatically, and never without you pressing the button. The new version runs after you restart Nimbalyst.

Nothing appears while you are up to date, and nothing appears when the check cannot be made: offline, rate-limited, or unable to read the release, the chip simply does not show. It never becomes an error or a spinner.

The check is a setting — **Behavior → Check for updates** in the gear popover, on by default. Turning it off stops the request being made at all, not just the chip being shown. With it off, re-paste the repo URL into **Install from GitHub** to upgrade by hand.

The version you are running is named at the foot of that same popover, and when a newer release is known it shows both — `0.1.5 → 0.1.6 available`.

## Claude Code support

This version is built for Claude Code sessions. The provider-neutral chips — effort, permission mode, directory, branch and context — work with any session, but plan limits are read from your Anthropic plan, and model names are resolved from Claude Code model ids.

Beside a session from another provider (Copilot, Cursor, Codex) the plan chips say so rather than implying the number describes that session: they relabel to `Claude 5h` / `Claude 7d`, render muted instead of green/yellow/red, and name the session's actual provider in their tooltip. No other provider's quota is reported.

## Install

In Nimbalyst: **Settings → Extensions → Marketplace → Install from GitHub**, and paste:

```
https://github.com/makinkade/nimbalyst-status-panel
```

Nimbalyst downloads the latest release and installs it. Re-pasting the same URL upgrades an existing install in place.

Reading your Claude plan usage requires the filesystem permission the extension declares, which is what gates reading your Claude credentials. Plan limits are fetched from Anthropic's usage endpoint; if they are unavailable for any reason the rest of the strip still works and those chips fall back to the last reading, drawn muted.

## Building from source

```
git clone https://github.com/makinkade/nimbalyst-status-panel
cd nimbalyst-status-panel
npm install
npm run build        # -> dist/index.js, dist/index.css
npm test
```

Installing your own build needs Extension Dev Tools (Settings → Advanced); the `extension_*` tools attach at session start, so restart Nimbalyst or start a new session after enabling it.

```
extension_install({ path: "/absolute/path/to/nimbalyst-status-panel" })
```

A panel that is already mounted does not reliably pick up a reload, so restart Nimbalyst when a change does not show up.

Repo notes — host channels the panel reads, design decisions, release process — are in [docs/development-notes.md](https://github.com/makinkade/nimbalyst-status-panel/blob/master/docs/development-notes.md).

## License

MIT — see [LICENSE](LICENSE). Copyright (c) 2026 Mark Kinkade.
