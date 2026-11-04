<script lang="ts">
  import Select from './Select.svelte';
  import { vm } from '../stores/app.svelte';
  import { agentActivityStore as activity } from '../stores/agentActivity.svelte';
  import {
    AGENT_ACTIVITY_PERIODS, AGENT_ACTIVITY_SCOPES, agentActivityClients, agentActivityPlace, agentActivityFilesLabel, agentActivityGroups, agentActivityStatus,
    agentActivityTime, filterAgentActivity, type AgentActivityPeriod,
  } from '../agentActivity';

  const clientOptions = $derived([{ value: '', label: 'All clients' }, ...agentActivityClients(activity.entries).map(client => ({ value: client, label: client }))]);
  const visible = $derived(filterAgentActivity(activity.entries, { text: activity.text, client: activity.client, period: activity.period }));
  const groups = $derived(agentActivityGroups(visible));
  const filtered = $derived(Boolean(activity.text.trim() || activity.client || activity.period !== 'all'));

  function open(id: string) {
    vm.openAgentTab();
    void activity.select(id);
  }

  function clearFilters() {
    activity.text = '';
    activity.client = '';
    activity.period = 'all';
  }
</script>

<div class="agent-activity-filters">
  <div class="field field-md field-wrap sidebar-search">
    <svg width="0.75rem" height="0.75rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
      <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>
    <input bind:value={activity.text} placeholder="Search tools and files" aria-label="Filter activity" spellcheck="false" />
  </div>
  <div class="agent-activity-scope">
    <Select value={activity.allWorkspaces ? 'all' : 'workspace'} options={AGENT_ACTIVITY_SCOPES} className="agent-activity-select" ariaLabel="Workspaces" onChange={value => activity.setAllWorkspaces(value === 'all')} />
  </div>
  <div class="agent-activity-selects">
    <Select value={activity.client} options={clientOptions} className="agent-activity-select" ariaLabel="Client" onChange={value => (activity.client = value)} />
    <Select value={activity.period} options={AGENT_ACTIVITY_PERIODS} className="agent-activity-select" ariaLabel="Period" onChange={value => (activity.period = value as AgentActivityPeriod)} />
  </div>
</div>

{#if activity.error}<div class="agent-activity-error" role="alert">{activity.error}</div>{/if}

{#if groups.length}
  <div class="history-list agent-activity-list" role="list" aria-label="Agent activity">
    {#each groups as group (group.label)}
      <div class="agent-activity-group" role="presentation">{group.label}</div>
      {#each group.entries as entry (entry.id)}
        {@const status = agentActivityStatus(entry)}
        <div class="history-entry agent-activity-row" class:active={activity.selectedId === entry.id} role="listitem">
          <button class="history-entry-main agent-activity-main" type="button" onclick={() => open(entry.id)} aria-current={activity.selectedId === entry.id ? 'true' : undefined}>
            <span class="agent-activity-dot agent-activity-dot-{status.tone}" role="img" aria-label={status.label}></span>
            <span class="agent-activity-tool">{entry.tool}</span>
            <span class="agent-activity-time">{agentActivityTime(entry.time)}</span>
            <span class="agent-activity-meta">{[activity.allWorkspaces ? agentActivityPlace(entry) : '', entry.client, agentActivityFilesLabel(entry), entry.reverted ? 'restored' : ''].filter(Boolean).join(' · ')}</span>
          </button>
        </div>
      {/each}
    {/each}
  </div>
{:else if activity.entries.length}
  <div class="empty-state history-empty">
    <span class="empty-state-title">Nothing matches these filters.</span>
    {#if filtered}<button class="btn btn-secondary" type="button" onclick={clearFilters}>Clear filters</button>{/if}
  </div>
{:else if activity.loaded}
  <div class="empty-state history-empty">
    <span class="empty-state-title">No activity yet.</span>
    <small class="empty-state-text">{activity.allWorkspaces ? 'Tool calls from the Kurlo agent, Codex, Claude Code and MCP clients show up here, with the files they changed.' : 'Nothing was recorded in this workspace yet. Choose All workspaces to see the rest.'}</small>
  </div>
{/if}

<style>
  .agent-activity-filters {
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
  }
  .agent-activity-selects {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: var(--space-1-5);
    padding: 0 var(--space-1);
  }
  .agent-activity-scope {
    padding: 0 var(--space-1);
  }
  .agent-activity-scope :global(.agent-activity-select),
  .agent-activity-scope :global(.agent-activity-select .app-select-trigger),
  .agent-activity-selects :global(.agent-activity-select),
  .agent-activity-selects :global(.agent-activity-select .app-select-trigger) {
    width: 100%;
    min-width: 0;
  }
  .agent-activity-scope :global(.agent-activity-select .app-select-trigger),
  .agent-activity-selects :global(.agent-activity-select .app-select-trigger) {
    justify-content: space-between;
  }
  .agent-activity-error {
    padding: 0 var(--space-1-5);
    color: var(--danger);
    font-size: var(--text-caption);
  }
  .agent-activity-group {
    padding: var(--space-3) var(--space-2) var(--space-1);
    color: var(--text-3);
    font-size: var(--text-caption);
    font-weight: var(--weight-medium);
    letter-spacing: 0.04em;
    text-transform: uppercase;
  }
  .agent-activity-group:first-child {
    padding-top: var(--space-1);
  }
  .agent-activity-row {
    grid-template-columns: minmax(0, 1fr);
  }
  .agent-activity-row.active {
    background: var(--bg);
    box-shadow: inset 0 0 0 1px var(--border);
  }
  .agent-activity-main {
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-rows: auto auto;
    column-gap: var(--space-2);
    row-gap: var(--space-0-5);
    padding: var(--space-2) var(--space-2);
    font-size: var(--text-body);
    line-height: var(--leading-normal);
    height: auto;
  }
  .agent-activity-dot {
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: var(--radius-full);
  }
  .agent-activity-dot-ok {
    background: var(--s2xx);
  }
  .agent-activity-dot-bad {
    background: var(--danger);
  }
  .agent-activity-dot-muted {
    background: var(--text-3);
  }
  .agent-activity-tool {
    min-width: 0;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--text-label);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-activity-time {
    color: var(--text-3);
    font-size: var(--text-caption);
    font-variant-numeric: tabular-nums;
    white-space: nowrap;
  }
  .agent-activity-meta {
    grid-column: 2 / -1;
    min-width: 0;
    overflow: hidden;
    color: var(--text-3);
    font-size: var(--text-caption);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
</style>
