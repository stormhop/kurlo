<script lang="ts">
  import type { Snippet } from 'svelte';
  import type { AgentFileChange } from '../backend';
  import { agentChangeSummary } from '../agent';
  import { collapseUnchanged, diffResponseBodies } from '../responseDiff';

  let { change, status = '', actions }: { change: AgentFileChange; status?: string; actions?: Snippet } = $props();

  const chunks = $derived(change.tooLarge ? [] : collapseUnchanged(diffResponseBodies(change.before ?? '', change.after ?? '').lines, 2));
</script>

<div class="agent-diff">
  <div class="agent-diff-head">
    <span class="agent-diff-path">{change.path}</span>
    <span class="agent-diff-kind">{status || agentChangeSummary(change)}</span>
    {#if actions}{@render actions()}{/if}
  </div>
  {#if change.tooLarge}
    <div class="agent-diff-note">The file is too large to show here.</div>
  {:else}
    <div class="agent-diff-body" role="table" aria-label={`Changes in ${change.path}`}>
      {#each chunks as chunk, chunkIndex (chunkIndex)}
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

<style>
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
</style>
