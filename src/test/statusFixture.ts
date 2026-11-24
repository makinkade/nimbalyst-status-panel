import type { ClaudeUsage, EffortSource, GitInfo, ModelInfo, SessionRecord } from '../lib/ipc';
import type { PlanUsage } from '../lib/planUsage';
import { normalizeSessionStatus } from '../lib/providerAdapters';
import { claudeReading } from '../lib/providers/claude';
import { measured, type ReadingScope } from '../lib/statusModel';
import type { Status } from '../useStatus';

/** Synthetic presentation inputs only. Real source/lifecycle tests live separately. */
export interface StatusInputs {
  session: SessionRecord | null;
  model: ModelInfo | null;
  servedModel: string | null;
  effort: string | null;
  effortSource: EffortSource | null;
  permissionMode: string | null;
  git: GitInfo;
  planUsage: PlanUsage | null;
  usage: ClaudeUsage | null;
  loading: boolean;
}

export function statusFixture(input: StatusInputs, workspacePath: string): Status {
  const scope: ReadingScope = { kind: 'account', provider: 'claude-code', workspacePath,
    accountId: null, configSource: 'test-claude-config', association: 'unbound' };
  const account = input.planUsage ? claudeReading(input.planUsage, scope, 'claude-direct')
    : input.usage ? claudeReading(input.usage, scope, 'claude-host') : null;
  const readings = normalizeSessionStatus({ workspacePath, session: input.session,
    models: input.model ? [input.model] : [],
    defaultEffort: input.effortSource === 'app-default' ? input.effort : null,
    permissionMode: input.permissionMode, accounts: account ? [account] : [],
    servedModel: input.servedModel ? measured(input.servedModel, 'synthetic-transcript',
      { kind: 'session', provider: input.session?.provider ?? null, workspacePath,
        sessionId: input.session?.id }, null) : undefined,
  });
  return { workspacePath, readings, git: input.git, loading: input.loading };
}
