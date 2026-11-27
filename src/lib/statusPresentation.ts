import type { StatusModel } from './statusModel';
import { modelLabel, parseModelId } from './modelNames';
import { formatTokens, permissionModeLabel, titleCase } from './format';

/** GET-224: card text consumes scoped readings, never raw host/provider data. */
export function modelPresentation(model: StatusModel) {
  const requested = model.model.value?.requestedId;
  const served = model.servedModel.value;
  const alias = parseModelId(requested);
  const reply = parseModelId(served);
  // A matching Claude alias can use the parsed reply version. A
  // disagreement may be a changed request OR a reroute; neither is proven by
  // this transcript contract. Explicitly name the past reply in that case.
  const compatible = served === requested || (!!alias && alias.family === reply?.family &&
    (!alias.version || alias.version === reply.version));
  const historical = !!served && (!compatible || model.servedModel.state === 'stale');
  const label = modelLabel({ sessionModel: historical ? null : requested, servedModel: served,
    catalogName: model.model.value?.displayName, servedCatalogName: model.model.value?.servedDisplayName });
  const notes = [model.session?.title ?? (model.session ? 'Untitled session' : 'No session selected'),
    `Provider: ${model.provider.id ?? 'not reported'}`,
    requested ? `Requested model: ${requested}` : model.model.reason ?? 'No model reported'];
  if (served) {
    notes.push(`Last observed reply served by: ${served}`,
      'This identifies a past reply, not proof that the current requested model has answered.');
  } else notes.push(model.servedModel.reason ?? 'No verified served model is available');
  for (const reading of [model.model, model.servedModel]) {
    if (reading.state === 'stale') notes.push(`Stale model reading. ${reading.reason ?? ''}`);
  }
  if (alias?.oneMillion && served) notes.push('The 1M variant is requested; it is not a measured served context capacity.');
  return { label: label ? `${historical ? 'Last reply: ' : ''}${label}${historical && alias?.oneMillion ? ' (1M requested)' : ''}`
    : (model.session ? 'Model —' : 'No session'),
    title: notes.join('\n'), muted: !label || model.model.state === 'stale' || model.servedModel.state === 'stale' };
}

export function effortPresentation(model: StatusModel) {
  const reading = model.effort;
  if (!reading.value) return { label: 'Effort —', title: reading.reason ?? 'Configured reasoning effort is unavailable', muted: true };
  const { level, source } = reading.value;
  const origin = source === 'session' ? "this session's own setting" : source === 'app-default'
    ? 'the app default effort level' : 'the built-in default (no session or app value set)';
  return { label: `${titleCase(level)}${source !== 'session' ? ' (default)' : ''}`,
    title: `Configured reasoning effort: ${titleCase(level)}, from ${origin}.\n` +
      'The provider may clamp or override this setting; effective effort is not reported.' +
      (reading.state === 'stale' ? `\nStale effort reading. ${reading.reason ?? ''}` : ''),
    muted: reading.state === 'stale' };
}

export function permissionPresentation(model: StatusModel) {
  const reading = model.workspacePolicy;
  const policy = reading.value;
  const notes = [policy ? `Workspace permission policy: ${policy.mode}`
    : reading.reason ?? 'Workspace permission policy is unavailable'];
  if (policy?.mode === 'bypass-all') notes.push(policy.allowAllUsesClassifier === undefined
    ? 'Automatic review setting is not reported.'
    : `Automatic review: ${policy.allowAllUsesClassifier ? 'on' : 'off'}.`);
  if (reading.state === 'stale') notes.push(`Stale workspace policy. ${reading.reason ?? ''}`);
  // GET-229 owns the host bridge. Each field remains independently unavailable
  // until a provider acknowledges it; do not reverse-engineer a launch profile.
  const fields = { approvalPolicy: 'Provider approval policy', reviewer: 'Approval reviewer',
    sandbox: 'Session sandbox', filesystem: 'Filesystem access', network: 'Network access' } as const;
  if (!model.execution.value) notes.push(model.execution.reason ?? 'Effective session restrictions are unavailable');
  for (const [key, label] of Object.entries(fields)) {
    const value = model.execution.value?.[key as keyof typeof fields];
    notes.push(`${label}: ${value || 'not reported'}`);
  }
  if (model.execution.state === 'stale') notes.push(`Stale execution restrictions. ${model.execution.reason ?? ''}`);
  return { label: policy ? permissionModeLabel(policy.mode, policy.allowAllUsesClassifier) : null,
    title: notes.join('\n'), muted: !policy || reading.state === 'stale' };
}

/** Missing counts never pass through formatTokens' historical zero fallback. */
export function contextPresentation(model: StatusModel) {
  const context = model.context.value;
  const tokens = model.tokens.value;
  const notes = [context ? `${formatTokens(context.tokens)}${context.window !== null ? ` of ${formatTokens(context.window)}` : ''} tokens in context`
    : model.context.reason ?? 'Current context occupancy is not reported'];
  if (context && context.window === null) notes.push('Context window capacity is not reported; percentage is unavailable.');
  if (model.context.state === 'stale') notes.push(`Stale context reading. ${model.context.reason ?? ''}`);
  const labels = { inputTokens: 'Cumulative input', outputTokens: 'Cumulative output', totalTokens: 'Cumulative total',
    cacheReadInputTokens: 'Cache read input', cacheCreationInputTokens: 'Cache creation input', reasoningTokens: 'Reasoning',
    providerCumulativeInputTokens: 'Provider cumulative input', providerCumulativeOutputTokens: 'Provider cumulative output',
    providerCumulativeCachedInputTokens: 'Provider cumulative cached input' } as const;
  for (const [key, label] of Object.entries(labels)) {
    const value = tokens?.[key as keyof typeof labels];
    if (value !== undefined) notes.push(`${label}: ${value.toLocaleString('en-US')} tokens`);
  }
  if (tokens) notes.push('Token counters are separate from current context occupancy; cache and reasoning counts may overlap other counters.');
  else notes.push(model.tokens.reason ?? 'Session token counters are not reported');
  if (model.tokens.state === 'stale') notes.push(`Stale token counters. ${model.tokens.reason ?? ''}`);
  const summary = [tokens?.inputTokens !== undefined ? `↑${formatTokens(tokens.inputTokens)}` : '',
    tokens?.outputTokens !== undefined ? `↓${formatTokens(tokens.outputTokens)}` : ''].filter(Boolean).join(' ');
  // A token-only provider still gets a useful card, without inventing a bar.
  const tokenSummary = summary || (tokens?.totalTokens !== undefined ? `Total ${formatTokens(tokens.totalTokens)}`
    : tokens?.reasoningTokens !== undefined ? `Reasoning ${formatTokens(tokens.reasoningTokens)}`
      : tokens?.cacheReadInputTokens !== undefined ? `Cache read ${formatTokens(tokens.cacheReadInputTokens)}`
        : tokens ? 'Token counts' : '');
  return { title: notes.join('\n'), tokenSummary,
    tokenStale: model.tokens.state === 'stale',
    occupancy: context ? `${formatTokens(context.tokens)} tokens` : null };
}
