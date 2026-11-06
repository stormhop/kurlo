<script lang="ts">
  import AgentFileDiff from './AgentFileDiff.svelte';
  import { vm } from '../stores/app.svelte';
  import { agentNavigation, agentStoreFor } from '../stores/agent.svelte';
  import { agentActivityStore as activity } from '../stores/agentActivity.svelte';
  import {
    agentActivityCanRestore, agentActivityChangeStatus, agentActivityChatMode, agentActivityFullTime, agentActivityPlace, agentActivityPretty,
    agentActivityRestorable, agentActivityStatus,
  } from '../agentActivity';

  let showArguments = $state(false);
  let showResult = $state(false);

  const entry = $derived(activity.selected);
  const status = $derived(entry ? agentActivityStatus(entry) : null);
  const restorable = $derived(agentActivityRestorable(entry));
  const chatMode = $derived(entry?.chatId ? agentActivityChatMode(entry.client) : null);
  const place = $derived(entry ? agentActivityPlace(entry) : '');
  const argumentsText = $derived(entry ? agentActivityPretty(entry.arguments) : '');
  const resultText = $derived(entry ? agentActivityPretty(entry.result) : '');

  $effect(() => {
    void activity.selectedId;
    showArguments = false;
    showResult = false;
  });

  function openChat() {
    if (!entry?.chatId || !chatMode) return;
    agentNavigation.activity = false;
    agentNavigation.mode = chatMode;
    void agentStoreFor(chatMode).openChat(entry.chatId);
  }

  async function clearLog() {
    if (await vm.openConfirmDialog('Clear agent activity', 'Every recorded call and its saved file versions are deleted. Restore from Git afterwards if you need an older version.', 'Clear')) {
      await activity.clear();
    }
  }
</script>

<div class="agent-activity-view">
  <div class="agent-activity-head">
    <h2 class="agent-activity-title">Agent activity</h2>
    <label class="agent-activity-record">
      <span>Record activity</span>
      <span class="switch-control">
        <input type="checkbox" checked={activity.enabled} onchange={event => void activity.setEnabled(event.currentTarget.checked)} />
        <span class="switch-track"></span>
        <span class="switch-state">{activity.enabled ? 'ON' : 'OFF'}</span>
      </span>
    </label>
    <button class="btn btn-ghost btn-sm" type="button" onclick={() => void activity.refresh()} disabled={activity.loading}>Refresh</button>
    <button class="btn btn-ghost btn-sm agent-activity-clear" type="button" onclick={() => void clearLog()} disabled={!activity.entries.length}>Clear…</button>
  </div>

  <div class="agent-activity-body">
    {#if activity.actionError}<div class="agent-activity-alert" role="alert">{activity.actionError}</div>{/if}
    {#if !activity.enabled}
      <p class="agent-activity-note">Recording is off. New tool calls are not logged and cannot be restored from here.</p>
    {/if}

    {#if activity.detailError}
      <div class="agent-activity-alert" role="alert">{activity.detailError}</div>
    {:else if entry && status}
      <section class="agent-activity-summary" aria-label="Call">
        <div class="agent-activity-summary-line">
          <span class="agent-activity-tool">{entry.tool}</span>
          <span class="agent-activity-badge agent-activity-badge-{status.tone}">{status.label}</span>
        </div>
        <div class="agent-activity-facts">
          {#if place}<span>{place}</span>{/if}
          <span>{entry.client}</span>
          <span>{agentActivityFullTime(entry.time)}</span>
          {#if entry.branch}<span>Branch <code>{entry.branch}</code></span>{/if}
          {#if entry.commit}<span>Commit <code>{entry.commit}</code></span>{/if}
        </div>
        {#if entry.error}<p class="agent-activity-error-text">{entry.error}</p>{/if}
        {#if chatMode && entry.here}
          <button class="btn btn-secondary btn-sm agent-activity-open-chat" type="button" onclick={openChat}>Open chat</button>
        {:else if chatMode}
          <p class="agent-activity-note">The chat is in {entry.workspaceName ? `the workspace ${entry.workspaceName}` : 'another workspace or folder'}. Switch to it in the top bar to open the chat.</p>
        {/if}
      </section>

      {#if entry.changes.length}
        <section class="agent-activity-section" aria-label="Changed files">
          <div class="agent-activity-section-head">
            <h3>Files</h3>
            {#if restorable.length > 1}
              <button class="btn btn-secondary btn-sm" type="button" onclick={() => void activity.restore()} disabled={Boolean(activity.busy)}>{activity.busy === '*' ? 'Restoring…' : 'Restore all'}</button>
            {/if}
          </div>
          <p class="agent-activity-note">Restore puts back the version from before this call. Kurlo refuses when the file has changed since; restore it from Git then.</p>
          {#each entry.changes as change (change.path)}
            <AgentFileDiff {change} status={agentActivityChangeStatus(change)}>
              {#snippet actions()}
                {#if agentActivityCanRestore(change)}
                  <button class="btn btn-ghost btn-xs" type="button" aria-label={`Restore ${change.path}`} onclick={() => void activity.restore(change.path)} disabled={Boolean(activity.busy)}>{activity.busy === change.path ? 'Restoring…' : 'Restore'}</button>
                {/if}
              {/snippet}
            </AgentFileDiff>
          {/each}
        </section>
      {/if}

      <section class="agent-activity-section">
        {#if argumentsText}
          <button class="btn btn-ghost btn-sm agent-activity-toggle" type="button" aria-expanded={showArguments} onclick={() => (showArguments = !showArguments)}>
            <svg class:open={showArguments} width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Arguments
          </button>
          {#if showArguments}<pre class="agent-activity-pre">{argumentsText}</pre>{/if}
        {/if}
        {#if resultText}
          <button class="btn btn-ghost btn-sm agent-activity-toggle" type="button" aria-expanded={showResult} onclick={() => (showResult = !showResult)}>
            <svg class:open={showResult} width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M3.5 2l3 3-3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/></svg>
            Result
          </button>
          {#if showResult}<pre class="agent-activity-pre">{resultText}</pre>{/if}
        {/if}
      </section>
    {:else if activity.selectedId}
      <p class="agent-activity-note">Loading…</p>
    {:else}
      <div class="agent-activity-empty">
        <h3>See what agents did</h3>
        <p>Every tool call from the Kurlo agent, Codex, Claude Code and MCP clients is kept on this computer for 30 days. The list shows this workspace; choose All workspaces for the rest. Pick one to see its arguments, result and the files it changed, and restore a file to the version before the call.</p>
      </div>
    {/if}
  </div>
</div>

<style>
  .agent-activity-view {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    background: var(--bg);
  }
  .agent-activity-head {
    display: flex;
    flex: 0 0 auto;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-2);
    min-height: 3.25rem;
    padding: var(--space-1-5) var(--space-6);
    border-bottom: 1px solid var(--border-subtle);
  }
  .agent-activity-title {
    margin: 0 auto 0 0;
    font-size: var(--text-title);
    font-weight: var(--weight-semibold);
  }
  .agent-activity-record {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .agent-activity-clear {
    color: var(--danger);
  }
  .agent-activity-body {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    gap: var(--space-4);
    width: 100%;
    max-width: 64rem;
    min-height: 0;
    margin: 0 auto;
    padding: var(--space-5) var(--space-6);
    overflow: auto;
  }
  .agent-activity-alert {
    color: var(--danger);
    font-size: var(--text-label);
    overflow-wrap: anywhere;
  }
  .agent-activity-note {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-label);
  }
  .agent-activity-summary {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: var(--space-2);
  }
  .agent-activity-summary-line {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }
  .agent-activity-tool {
    font-family: var(--font-mono);
    font-size: var(--text-title);
    font-weight: var(--weight-semibold);
    overflow-wrap: anywhere;
  }
  .agent-activity-badge {
    padding: var(--space-0-5) var(--space-2);
    border-radius: var(--radius-full);
    font-size: var(--text-caption);
    font-weight: var(--weight-medium);
  }
  .agent-activity-badge-ok {
    background: color-mix(in srgb, var(--s2xx) 14%, transparent);
    color: var(--s2xx);
  }
  .agent-activity-badge-bad {
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--danger);
  }
  .agent-activity-badge-muted {
    background: var(--hover);
    color: var(--text-2);
  }
  .agent-activity-facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1) var(--space-4);
    color: var(--text-2);
    font-size: var(--text-label);
  }
  .agent-activity-facts code {
    font-family: var(--font-mono);
    font-size: var(--text-code);
    -webkit-user-select: text;
    user-select: text;
  }
  .agent-activity-error-text {
    margin: 0;
    color: var(--danger);
    font-size: var(--text-label);
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
  }
  .agent-activity-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .agent-activity-section-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-2);
  }
  .agent-activity-section-head h3 {
    margin: 0;
    font-size: var(--text-body);
    font-weight: var(--weight-semibold);
  }
  .agent-activity-toggle {
    align-self: flex-start;
    gap: var(--space-1-5);
    color: var(--text-2);
  }
  .agent-activity-toggle svg {
    color: var(--text-3);
    transition: transform var(--dur-fast);
  }
  .agent-activity-toggle svg.open {
    transform: rotate(90deg);
  }
  .agent-activity-pre {
    margin: 0;
    max-height: 20rem;
    overflow: auto;
    padding: var(--space-2) var(--space-2-5);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
  }
  .agent-activity-empty {
    max-width: 34rem;
    margin: var(--space-8) auto 0;
    text-align: center;
  }
  .agent-activity-empty h3 {
    margin: 0 0 var(--space-2);
    font-size: var(--text-title);
    font-weight: var(--weight-semibold);
  }
  .agent-activity-empty p {
    margin: 0;
    color: var(--text-2);
    font-size: var(--text-body);
    line-height: var(--leading-relaxed);
  }
</style>
