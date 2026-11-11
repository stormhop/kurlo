<script lang="ts">
  import { SvelteSet } from 'svelte/reactivity';
  import type { AgentFileChange } from '../backend';
  import { agentChangeCounts, agentChangeHint, agentChangeKindLabel, agentChangeStatus } from '../agent';
  import AgentFileDiff from './AgentFileDiff.svelte';

  let { changes }: { changes: AgentFileChange[] } = $props();

  const compact = $derived(changes.length > 2);
  const counts = $derived(agentChangeCounts(changes));
  const toggled = new SvelteSet<string>();
  const yaml = new SvelteSet<string>();
  const allOpen = $derived(changes.every(change => isOpen(change.path)));

  function isOpen(path: string): boolean {
    return compact ? toggled.has(path) : !toggled.has(path);
  }

  function toggle(path: string) {
    if (toggled.has(path)) toggled.delete(path);
    else toggled.add(path);
  }

  function setAll(open: boolean) {
    toggled.clear();
    if (open === compact) for (const change of changes) toggled.add(change.path);
  }

  function toggleYaml(path: string) {
    if (yaml.has(path)) yaml.delete(path);
    else yaml.add(path);
  }
</script>

{#if compact}
  <div class="agent-change-overview">
    <span>{counts}</span>
    <button class="btn btn-ghost btn-xs" type="button" onclick={() => setAll(!allOpen)}>{allOpen ? 'Collapse all' : 'Expand all'}</button>
  </div>
{/if}
<ul class="agent-change-list" aria-label="Changes">
  {#each changes as change (change.path)}
    {@const summary = change.summary}
    {@const open = isOpen(change.path)}
    {@const status = agentChangeStatus(change)}
    <li class="agent-change">
      <button class="agent-change-head" type="button" aria-expanded={open} onclick={() => toggle(change.path)}>
        <svg class="agent-change-chevron" class:open width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true">
          <path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        {#if summary}
          {#if agentChangeKindLabel(summary.kind) !== summary.name}<span class="agent-change-kind">{agentChangeKindLabel(summary.kind)}</span>{/if}
          <span class="agent-change-name">{summary.name}</span>
          {#if summary.location}<span class="agent-change-location">{summary.location}</span>{/if}
        {:else}
          <span class="agent-change-name agent-change-path">{change.path}</span>
        {/if}
        {#if !open && agentChangeHint(change)}<span class="agent-change-hint">{agentChangeHint(change)}</span>{/if}
        <span class="agent-change-status agent-change-status-{status.toLowerCase()}">{status}</span>
      </button>
      {#if open}
        <div class="agent-change-body">
          {#if summary}
            {#if summary.detail}<code class="agent-change-detail">{summary.detail}</code>{/if}
            {#if summary.fields?.length}
              <ul class="agent-change-fields">
                {#each summary.fields as field (field.label)}
                  <li>
                    <span class="agent-change-field">{field.label}</span>
                    {#if field.before && field.after}
                      <span class="agent-change-value"><del>{field.before}</del><span aria-hidden="true">→</span><span>{field.after}</span></span>
                    {:else if field.after}
                      <span class="agent-change-value">{field.after}</span>
                    {:else}
                      <span class="agent-change-mark agent-change-mark-{field.change}">{field.change}</span>
                    {/if}
                  </li>
                {/each}
              </ul>
            {:else if status === 'Changed'}
              <p class="agent-change-note">Only internal details such as ids or order change.</p>
            {/if}
            <button class="btn btn-ghost btn-xs agent-change-yaml" type="button" aria-expanded={yaml.has(change.path)} onclick={() => toggleYaml(change.path)}>{yaml.has(change.path) ? 'Hide file changes' : 'Show file changes'}</button>
            {#if yaml.has(change.path)}<AgentFileDiff {change} />{/if}
          {:else}
            <AgentFileDiff {change} />
          {/if}
        </div>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .agent-change-overview {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .agent-change-list {
    display: flex;
    flex-direction: column;
    max-height: min(26rem, 55vh);
    margin: 0;
    padding: 0;
    overflow: auto;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    list-style: none;
  }
  .agent-change + .agent-change {
    border-top: 1px solid var(--border-subtle);
  }
  .agent-change-head {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    min-width: 0;
    padding: var(--space-2) var(--space-2-5);
    border: 0;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-label);
    text-align: left;
    cursor: pointer;
  }
  .agent-change-head:hover {
    background: var(--hover);
  }
  .agent-change-head:focus-visible {
    outline: 2px solid var(--accent);
    outline-offset: -2px;
  }
  .agent-change-chevron {
    flex: 0 0 auto;
    color: var(--text-3);
    transition: transform var(--dur-fast);
  }
  .agent-change-chevron.open {
    transform: rotate(90deg);
  }
  .agent-change-kind {
    flex: 0 0 auto;
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .agent-change-name {
    min-width: 0;
    overflow: hidden;
    font-weight: var(--weight-medium);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-change-path {
    font-family: var(--font-mono);
    font-weight: var(--weight-regular);
    direction: rtl;
  }
  .agent-change-location,
  .agent-change-hint {
    min-width: 0;
    overflow: hidden;
    color: var(--text-3);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-change-hint {
    flex: 0 1 auto;
    margin-left: auto;
  }
  .agent-change-status {
    flex: 0 0 auto;
    margin-left: auto;
    padding: 0 var(--space-1-5);
    border-radius: var(--radius-sm);
    font-size: var(--text-caption);
    line-height: var(--leading-relaxed);
  }
  .agent-change-hint + .agent-change-status {
    margin-left: 0;
  }
  .agent-change-status-new {
    background: var(--success-bg);
    color: var(--s2xx);
  }
  .agent-change-status-changed {
    background: color-mix(in srgb, var(--accent) 12%, transparent);
    color: var(--accent-text);
  }
  .agent-change-status-deleted {
    background: var(--danger-bg);
    color: var(--danger);
  }
  .agent-change-body {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
    padding: 0 var(--space-2-5) var(--space-2-5) calc(var(--space-2-5) + 1.125rem);
  }
  .agent-change-body > :global(.agent-diff) {
    align-self: stretch;
  }
  .agent-change-detail {
    max-width: 100%;
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    overflow-wrap: anywhere;
  }
  .agent-change-fields {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    align-self: stretch;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .agent-change-fields li {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
    font-size: var(--text-label);
  }
  .agent-change-field {
    color: var(--text);
  }
  .agent-change-value {
    display: inline-flex;
    flex-wrap: wrap;
    gap: var(--space-1-5);
    min-width: 0;
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    overflow-wrap: anywhere;
  }
  .agent-change-value del {
    color: var(--text-3);
  }
  .agent-change-mark {
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .agent-change-mark-added {
    color: var(--s2xx);
  }
  .agent-change-mark-removed {
    color: var(--danger);
  }
  .agent-change-note {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-label);
  }
  .agent-change-yaml {
    margin-left: calc(-1 * var(--space-2));
    color: var(--text-2);
  }
</style>
