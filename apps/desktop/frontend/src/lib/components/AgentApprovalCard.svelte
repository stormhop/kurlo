<script lang="ts">
  import type { AgentApproval, AgentFileChange } from '../backend';
  import { agentApprovalArguments, agentApprovalTitle, agentChangeSummary } from '../agent';
  import { collapseUnchanged, diffResponseBodies } from '../responseDiff';

  let {
    approval,
    onAnswer,
  }: {
    approval: AgentApproval;
    onAnswer: (decision: 'allow' | 'allow_chat' | 'reject') => void | Promise<void>;
  } = $props();

  let busy = $state(false);
  let error = $state('');
  let showArgs = $state(false);
  const write = $derived(approval.kind === 'write');

  function diffOf(change: AgentFileChange) {
    const diff = diffResponseBodies(change.before ?? '', change.after ?? '');
    return { diff, chunks: collapseUnchanged(diff.lines, 2) };
  }

  async function answer(decision: 'allow' | 'allow_chat' | 'reject') {
    if (busy) return;
    busy = true;
    error = '';
    try { await onAnswer(decision); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); } finally { busy = false; }
  }
</script>

<div class="agent-approval" role="group" aria-label={agentApprovalTitle(approval)}>
  <div class="agent-approval-head">
    <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path d="M8 1.75 2.75 4v3.6c0 3.2 2.2 5.7 5.25 6.65 3.05-.95 5.25-3.45 5.25-6.65V4L8 1.75Z" stroke="currentColor" stroke-width="1.3" stroke-linejoin="round"/>
    </svg>
    <strong>{agentApprovalTitle(approval)}</strong>
    <span class="agent-approval-tool">{approval.tool}</span>
  </div>
  {#if approval.reason}<p class="agent-approval-reason">{approval.reason}</p>{/if}

  {#if write && approval.changes.length}
    <div class="agent-approval-files">
      {#each approval.changes as change (change.path)}
        <div class="agent-diff">
          <div class="agent-diff-head">
            <span class="agent-diff-path">{change.path}</span>
            <span class="agent-diff-kind">{agentChangeSummary(change)}</span>
          </div>
          {#if change.tooLarge}
            <div class="agent-diff-note">The file is too large to show here.</div>
          {:else}
            {@const view = diffOf(change)}
            <div class="agent-diff-body" role="table" aria-label={`Changes in ${change.path}`}>
              {#each view.chunks as chunk, chunkIndex (chunkIndex)}
                {#if chunk.kind === 'gap'}
                  <div class="agent-diff-gap" role="row">{chunk.count} unchanged {chunk.count === 1 ? 'line' : 'lines'}</div>
                {:else}
                  {#each chunk.lines as line, lineIndex (lineIndex)}
                    <div class="agent-diff-line agent-diff-{line.kind}" role="row">
                      <span class="agent-diff-sign" aria-hidden="true">{line.kind === 'added' ? '+' : line.kind === 'removed' ? '−' : ' '}</span>
                      <span class="agent-diff-text">{line.text || ' '}</span>
                    </div>
                  {/each}
                {/if}
              {/each}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {:else}
    <button class="btn btn-ghost btn-sm agent-approval-args-toggle" type="button" aria-expanded={showArgs} onclick={() => (showArgs = !showArgs)}>
      <svg class:open={showArgs} width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
      Arguments
    </button>
    {#if showArgs}<pre class="agent-approval-args">{agentApprovalArguments(approval)}</pre>{/if}
  {/if}

  <p class="agent-approval-reason">This turn stops after 30 minutes without a response.</p>
  {#if error}<p class="agent-approval-error" role="alert">{error}</p>{/if}
  <div class="agent-approval-actions">
    <button class="btn btn-primary btn-sm" type="button" onclick={() => answer('allow')} disabled={busy}>{write ? 'Apply' : 'Send'}</button>
    <button class="btn btn-secondary btn-sm" type="button" onclick={() => answer('allow_chat')} disabled={busy}>Allow for this chat</button>
    <button class="btn btn-ghost btn-sm" type="button" onclick={() => answer('reject')} disabled={busy}>Reject</button>
  </div>
</div>

<style>
  .agent-approval-error { color: var(--danger); font-size: var(--text-label); overflow-wrap: anywhere; }
  .agent-approval {
    display: flex;
    flex: 0 0 auto;
    flex-direction: column;
    overflow: hidden;
    border: 1px solid color-mix(in srgb, var(--accent) 35%, var(--border));
    border-radius: var(--radius-xl);
    background: var(--bg);
  }
  .agent-approval > * {
    margin-inline: var(--space-3);
  }
  .agent-approval-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
    margin: 0;
    padding: var(--space-2-5) var(--space-3);
    border-bottom: 1px solid color-mix(in srgb, var(--accent) 20%, var(--border-subtle));
    background: color-mix(in srgb, var(--accent) 7%, var(--bg));
    color: var(--text);
    font-size: var(--text-body);
  }
  .agent-approval-head svg {
    flex: 0 0 auto;
    color: var(--accent);
  }
  .agent-approval-head strong {
    min-width: 0;
    overflow-wrap: anywhere;
    font-weight: var(--weight-semibold);
  }
  .agent-approval-tool {
    margin-left: auto;
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    min-width: 0;
    max-width: 45%;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-approval-reason {
    margin-top: var(--space-2-5);
    margin-bottom: 0;
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .agent-approval-files {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    margin-block: var(--space-2-5);
  }
  .agent-diff {
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg);
    overflow: hidden;
  }
  .agent-diff-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1-5) var(--space-2-5);
    border-bottom: 1px solid var(--border-subtle);
    font-size: var(--text-caption);
  }
  .agent-diff-path {
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font-family: var(--font-mono);
    text-overflow: ellipsis;
    white-space: nowrap;
    direction: rtl;
    text-align: left;
  }
  .agent-diff-kind {
    flex: 0 0 auto;
    margin-left: auto;
    color: var(--text-3);
  }
  .agent-diff-body {
    max-height: 18rem;
    overflow: auto;
    padding: var(--space-1) 0;
    font-family: var(--font-mono);
    font-size: var(--text-code);
    line-height: var(--leading-relaxed);
    -webkit-user-select: text;
    user-select: text;
  }
  .agent-diff-line {
    display: grid;
    grid-template-columns: 1.25rem minmax(0, 1fr);
    padding-right: var(--space-2-5);
  }
  .agent-diff-sign {
    color: var(--text-3);
    text-align: center;
  }
  .agent-diff-text {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    color: var(--text-2);
  }
  .agent-diff-added {
    background: color-mix(in srgb, var(--s2xx) 12%, transparent);
  }
  .agent-diff-added .agent-diff-sign,
  .agent-diff-added .agent-diff-text {
    color: var(--text);
  }
  .agent-diff-removed {
    background: color-mix(in srgb, var(--danger) 12%, transparent);
  }
  .agent-diff-removed .agent-diff-sign,
  .agent-diff-removed .agent-diff-text {
    color: var(--text);
  }
  .agent-diff-gap {
    padding: var(--space-0-5) var(--space-2-5);
    color: var(--text-3);
    font-family: var(--font-ui);
    font-size: var(--text-caption);
  }
  .agent-diff-note {
    padding: var(--space-2) var(--space-2-5);
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .agent-approval-args-toggle {
    align-self: flex-start;
    margin-block: var(--space-2);
    gap: var(--space-1-5);
    color: var(--text-2);
  }
  .agent-approval-args-toggle svg {
    color: var(--text-3);
    transition: transform var(--dur-fast);
  }
  .agent-approval-args-toggle svg.open {
    transform: rotate(90deg);
  }
  .agent-approval-args {
    margin-top: 0;
    margin-bottom: var(--space-2-5);
    max-height: 14rem;
    overflow: auto;
    padding: var(--space-2) var(--space-2-5);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
  }
  .agent-approval-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-2);
    margin: 0;
    padding: var(--space-2-5) var(--space-3);
    border-top: 1px solid var(--border-subtle);
  }
</style>
