# Host status evidence

[status-host-0.83.0.json](status-host-0.83.0.json) is a sanitized projection of
real renderer IPC responses captured for GET-222 on 2026-11-24. It is input for
normalizer tests and later provider work, not an assertion that the existing
panel consumes every field. The [audit](../../../docs/development-notes.md#provider-capability-audit-get-222-2026-11-24)
records source contracts, gaps, and checks that were not performed.

The provenance envelope was added by the audit. `observations[].payload` comes
from the named real channel, in call order. The `codex-usage:update` payload is
the list of events received during the explicit refresh. `arguments` use a
workspace placeholder and consistent session aliases. `earlierCodexCache` is a
separate earlier observation with its own capture time; do not combine its age
with the final capture time.

Fields were allowlisted in the renderer before saving. Session IDs were
aliased consistently; email and organization were replaced. Only the two full
sessions' list/catalog entries were retained. Transcript arrays retain only
assistant entries and model/subagent fields. Text, prompts, tool content, user
paths, provider config, history, and unrelated metadata were omitted. The
projection removes whole unrelated fields rather than filling absent status
fields with fabricated null/zero values. A field outside a projection's
allowlist cannot be declared missing in the original response from this file.

To repeat the audit on another host version:

1. Record packaged/development mode, host version, runtime CLI versions, and
   hashes of the installed main/preload sources. Verify handlers before calling
   undocumented channels; never query the sessions database directly.
2. Use a temporary extension in the real renderer to read workspace selection,
   session list/full records, projected transcript tails, model catalog, effort
   default, and the documented audit's login/usage channels. Allowlist fields
   before returning or storing data. Do not read credential files or provider
   settings that can contain secrets.
3. Record the getter before a single explicit quota refresh, subscribe for its
   update, read again, then unsubscribe. Record selection before/after. Keep
   account quota separate from selected-session token data. Do not switch
   accounts, change permissions, or force failures as part of a passive capture.
4. Remove the probe and any probe storage keys. Save only sanitized evidence
   with accurate capture times, source version, projection notes, and untested
   cases. Keep source-derived examples separately labeled if added later.

The temporary extension was uninstalled and its subscription disposed. It wrote
to an ignored build folder and used no extension-storage keys. No production
extension was reloaded and no account, workspace policy, or selection changed.
