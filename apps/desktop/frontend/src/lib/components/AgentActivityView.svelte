<script lang="ts">
  import { onMount, tick } from 'svelte';
  import AgentFileDiff from './AgentFileDiff.svelte';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import { vm } from '../stores/app.svelte';
  import { agentNavigation, agentStore as kurloAgentStore, agentStoreFor, claudeAgentStore, codexAgentStore } from '../stores/agent.svelte';
  import { agentActivityStore as activity } from '../stores/agentActivity.svelte';
  import { focusFirstMenuItem, handleMenuKeydown } from '../menuKeyboard';
  import {
    agentActivityCanRestore, agentActivityChangeStatus, agentActivityChatMode, agentActivityFileName, agentActivityFullTime,
    agentActivityPlace, agentActivityPretty, agentActivityRestorable, agentActivityStatus, agentActivityTime,
  } from '../agentActivity';
  import type { AgentActivitySummary } from '../backend';

  const TONE_TAG = { ok: 'tag-success', bad: 'tag-danger', muted: '' } as const;

  let menuOpen = $state(false);
  let menu = $state<HTMLDivElement>();
  let menuTrigger = $state<HTMLButtonElement>();

  const entry = $derived(activity.selected);
  const status = $derived(entry ? agentActivityStatus(entry) : null);
  const restorable = $derived(agentActivityRestorable(entry));
  const chatMode = $derived(entry?.chatId ? agentActivityChatMode(entry.client) : null);
  const place = $derived(entry ? agentActivityPlace(entry) : '');
  const argumentsText = $derived(entry ? agentActivityPretty(entry.arguments) : '');
  const resultText = $derived(entry ? agentActivityPretty(entry.result) : '');
  const hasArguments = $derived(Boolean(argumentsText) && argumentsText !== '{}');
  const overview = $derived(activity.overview ?? { today: 0, week: 0, errors: 0, changed: 0, changes: [], problems: [] });
  const scopeLabel = $derived(activity.allWorkspaces ? 'all workspaces' : 'this workspace');
  const agentsRunning = $derived(kurloAgentStore.anyRunning || codexAgentStore.anyRunning || claudeAgentStore.anyRunning);

  let wasRunning = false;
  $effect(() => {
    const running = agentsRunning;
    if (wasRunning && !running) void activity.refresh();
    wasRunning = running;
  });

  onMount(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') void activity.refresh();
    };
    window.addEventListener('focus', refresh);
    document.addEventListener('visibilitychange', refresh);
    return () => {
      window.removeEventListener('focus', refresh);
      document.removeEventListener('visibilitychange', refresh);
    };
  });

  function openChat() {
    if (!entry?.chatId || !chatMode) return;
    agentNavigation.activity = false;
    agentNavigation.mode = chatMode;
    void agentStoreFor(chatMode).openChat(entry.chatId);
  }

  function pick(item: AgentActivitySummary) {
    void activity.select(item.id);
  }

  async function toggleMenu() {
    menuOpen = !menuOpen;
    if (!menuOpen) return;
    await tick();
    focusFirstMenuItem(menu);
  }

  function closeMenu() {
    menuOpen = false;
    menuTrigger?.focus();
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (!menuOpen) return;
    const target = event.target;
    if (target instanceof Element && target.closest('.agent-activity-menu, .agent-activity-menu-btn')) return;
    menuOpen = false;
  }

  async function toggleRecording() {
    menuOpen = false;
    await activity.setEnabled(!activity.enabled);
  }

  async function clearLog() {
    menuOpen = false;
    if (await vm.openConfirmDialog('Clear agent activity', 'Every recorded call and its saved file versions are deleted. Restore from Git afterwards if you need an older version.', 'Clear')) {
      await activity.clear();
    }
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />

<section class="history-detail agent-activity-view" aria-label="Agent activity">
  {#if activity.detailError}
    <header class="history-detail-head">
      <div class="history-detail-title"><h1>Agent activity</h1></div>
      <div class="history-detail-actions">
        <button class="btn btn-ghost btn-icon" type="button" aria-label="Back to overview" onclick={() => activity.deselect()}><AddCloseIcon /></button>
      </div>
    </header>
    <div class="history-detail-body"><div class="agent-activity-alert" role="alert">{activity.detailError}</div></div>
  {:else if entry && status}
    <header class="history-detail-head">
      <div class="history-detail-title">
        <div class="agent-activity-title-line">
          <h1 class="agent-activity-tool">{entry.tool}</h1>
          <span class="tag agent-activity-status {TONE_TAG[status.tone]}">{status.label}</span>
        </div>
        <p>{[place, entry.client, agentActivityFullTime(entry.time)].filter(Boolean).join(' · ')}</p>
      </div>
      <div class="history-detail-actions">
        {#if chatMode && entry.here}
          <button class="btn btn-secondary" type="button" onclick={openChat}>Open chat</button>
        {/if}
        {#if restorable.length > 1}
          <button class="btn btn-secondary" type="button" onclick={() => void activity.restore()} disabled={Boolean(activity.busy)}>{activity.busy === '*' ? 'Restoring…' : 'Restore all'}</button>
        {/if}
        <button class="btn btn-ghost btn-icon" type="button" aria-label="Back to overview" onclick={() => activity.deselect()}><AddCloseIcon /></button>
      </div>
    </header>

    <div class="history-detail-body agent-activity-body">
      {#if activity.actionError}<div class="agent-activity-alert" role="alert">{activity.actionError}</div>{/if}
      {#if entry.error}<div class="agent-activity-error" class:agent-activity-error-muted={status.tone === 'muted'}>{entry.error}</div>{/if}
      {#if chatMode && !entry.here}
        <p class="history-detail-note">The chat is in {entry.workspaceName ? `the workspace ${entry.workspaceName}` : 'another workspace or folder'}. Switch to it in the top bar to open the chat.</p>
      {/if}

      {#if entry.branch || entry.commit}
        <dl class="agent-activity-facts">
          {#if entry.branch}<div><dt>Branch</dt><dd><code>{entry.branch}</code></dd></div>{/if}
          {#if entry.commit}<div><dt>Commit</dt><dd><code>{entry.commit}</code></dd></div>{/if}
        </dl>
      {/if}

      {#if entry.changes.length}
        <section class="history-detail-section agent-activity-section" aria-label="Changed files">
          <h2>Files <span class="agent-activity-count">{entry.changes.length}</span></h2>
          <p class="agent-activity-hint">Restore puts back the version from before this call. Kurlo refuses when the file has changed since; restore it from Git then.</p>
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

      {#if hasArguments || resultText}
        <div class="history-detail-columns agent-activity-columns">
          {#if hasArguments}
            <section class="history-detail-section" aria-label="Arguments">
              <h2>Arguments</h2>
              <pre class="history-detail-code agent-activity-code">{argumentsText}</pre>
            </section>
          {/if}
          {#if resultText}
            <section class="history-detail-section" aria-label="Result">
              <h2>Result</h2>
              <pre class="history-detail-code agent-activity-code">{resultText}</pre>
            </section>
          {/if}
        </div>
      {/if}
    </div>
  {:else if activity.selectedId}
    <div class="history-detail-body"><p class="history-detail-note">Loading…</p></div>
  {:else}
    <header class="history-detail-head">
      <div class="history-detail-title">
        <h1>Agent activity</h1>
        <p>Tool calls in {scopeLabel}, kept on this computer for 30 days.</p>
      </div>
      <div class="history-detail-actions agent-activity-menu-wrap">
        <button class="btn btn-ghost btn-icon agent-activity-menu-btn" type="button" bind:this={menuTrigger} onclick={() => void toggleMenu()} aria-label="Activity options" aria-haspopup="menu" aria-expanded={menuOpen}>
          <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true"><circle cx="3" cy="8" r="1.25"/><circle cx="8" cy="8" r="1.25"/><circle cx="13" cy="8" r="1.25"/></svg>
        </button>
        {#if menuOpen}
          <div class="menu agent-activity-menu" role="menu" aria-label="Activity options" tabindex="-1" bind:this={menu} onkeydown={event => handleMenuKeydown(event, closeMenu)}>
            <button class="menu-item" type="button" role="menuitem" onclick={() => void toggleRecording()}>
              {#if activity.enabled}
                <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" aria-hidden="true"><path d="M6 4.5v7M10 4.5v7"/></svg>
              {:else}
                <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true"><circle cx="8" cy="8" r="3" fill="currentColor"/></svg>
              {/if}
              {activity.enabled ? 'Pause recording' : 'Resume recording'}
            </button>
            <div class="menu-separator" role="separator"></div>
            <button class="menu-item danger" type="button" role="menuitem" onclick={() => void clearLog()} disabled={!activity.entries.length}><MenuIcon name="trash" />Clear activity…</button>
          </div>
        {/if}
      </div>
    </header>

    <div class="history-detail-body agent-activity-body">
      {#if activity.actionError}<div class="agent-activity-alert" role="alert">{activity.actionError}</div>{/if}
      {#if !activity.enabled}
        <div class="agent-activity-paused">
          <span>Recording is off. New tool calls are not logged and cannot be restored from here.</span>
          <button class="btn btn-secondary btn-sm" type="button" onclick={() => void activity.setEnabled(true)}>Resume recording</button>
        </div>
      {/if}

      {#if activity.entries.length}
        <div class="history-detail-stats agent-activity-stats">
          <div class="runner-stat"><span>Today</span><strong>{overview.today}</strong></div>
          <div class="runner-stat"><span>Last 7 days</span><strong>{overview.week}</strong></div>
          <div class="runner-stat"><span>Errors</span><strong class:fail={overview.errors > 0}>{overview.errors}</strong></div>
          <div class="runner-stat"><span>Changed files</span><strong>{overview.changed}</strong></div>
        </div>

        <div class="history-detail-columns agent-activity-columns">
          <section class="overview-section" aria-labelledby="agent-activity-changes-title">
            <h2 id="agent-activity-changes-title">Recent changes</h2>
            {#if overview.changes.length}
              <div class="overview-list">
                {#each overview.changes as item (item.id)}
                  <button class="overview-row agent-activity-row" type="button" onclick={() => pick(item)}>
                    <span class="overview-row-name agent-activity-row-files"><span class="agent-activity-row-label">{item.files.map(agentActivityFileName).join(', ')}</span>{#if item.reverted}<span class="tag">Restored</span>{/if}</span>
                    <span class="overview-row-meta">{[item.tool, activity.allWorkspaces ? agentActivityPlace(item) : '', item.client].filter(Boolean).join(' · ')}</span>
                    <span class="overview-row-time">{agentActivityTime(item.time)}</span>
                  </button>
                {/each}
              </div>
            {:else}
              <p class="agent-activity-hint">No agent changed a file in the last 7 days.</p>
            {/if}
          </section>
          <section class="overview-section" aria-labelledby="agent-activity-problems-title">
            <h2 id="agent-activity-problems-title">Errors and declined</h2>
            {#if overview.problems.length}
              <div class="overview-list">
                {#each overview.problems as item (item.id)}
                  {@const tone = agentActivityStatus(item).tone}
                  <button class="overview-row agent-activity-row" type="button" onclick={() => pick(item)}>
                    <span class="overview-row-name agent-activity-row-tool"><span class="agent-activity-dot agent-activity-dot-{tone}" aria-hidden="true"></span>{item.tool}</span>
                    <span class="overview-row-meta">{item.error || (item.status === 'declined' ? 'Declined' : 'Error')}</span>
                    <span class="overview-row-time">{agentActivityTime(item.time)}</span>
                  </button>
                {/each}
              </div>
            {:else}
              <p class="agent-activity-hint">Every call in the last 7 days went through.</p>
            {/if}
          </section>
        </div>
      {:else if activity.loaded}
        <div class="empty-state agent-activity-empty">
          <svg width="1.75rem" height="1.75rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 12h4l3-8 4 16 3-8h4"/></svg>
          <span class="empty-state-title">No agent activity yet</span>
          <p class="empty-state-text">Tool calls from the Kurlo agent, Codex, Claude Code and MCP clients show up here with the files they changed. Any change can be put back to the version before the call.</p>
          {#if !activity.allWorkspaces}
            <button class="btn btn-secondary" type="button" onclick={() => activity.setAllWorkspaces(true)}>Show all workspaces</button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}
</section>

<style>
  .agent-activity-title-line {
    display: flex;
    align-items: center;
    gap: var(--space-2-5);
    min-width: 0;
  }
  .agent-activity-tool {
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--text-heading);
    letter-spacing: 0;
  }
  .agent-activity-status {
    flex: 0 0 auto;
  }
  .agent-activity-body {
    display: flex;
    flex-direction: column;
    gap: var(--space-6);
  }
  .agent-activity-body > .agent-activity-columns {
    margin-top: 0;
  }
  .agent-activity-alert {
    color: var(--danger);
    font-size: var(--text-body);
    overflow-wrap: anywhere;
  }
  .agent-activity-error {
    padding: var(--space-2-5) var(--space-3);
    border: 1px solid var(--danger-border);
    border-radius: var(--radius-lg);
    background: var(--danger-bg-subtle);
    color: var(--text);
    font-size: var(--text-body);
    line-height: var(--leading-normal);
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
  }
  .agent-activity-error-muted {
    border-color: var(--border-subtle);
    background: var(--surface);
    color: var(--text-2);
  }
  .agent-activity-facts {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-4) var(--space-8);
    margin: 0;
  }
  .agent-activity-facts div {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
    min-width: 0;
  }
  .agent-activity-facts dt {
    color: var(--text-3);
    font-size: var(--text-label);
  }
  .agent-activity-facts dd {
    margin: 0;
    min-width: 0;
  }
  .agent-activity-facts code {
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-body);
    overflow-wrap: anywhere;
    -webkit-user-select: text;
    user-select: text;
  }
  .agent-activity-section {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
  }
  .agent-activity-section h2 {
    display: flex;
    align-items: baseline;
    gap: var(--space-1-5);
    margin: 0;
  }
  .agent-activity-columns .history-detail-section h2 {
    margin-bottom: var(--space-2-5);
  }
  .agent-activity-count {
    color: var(--text-3);
    font-weight: var(--weight-regular);
    font-variant-numeric: tabular-nums;
  }
  .agent-activity-hint {
    margin: 0;
    color: var(--text-3);
    font-size: var(--text-body);
    line-height: var(--leading-normal);
  }
  .agent-activity-code {
    max-height: 24rem;
  }
  .agent-activity-menu-wrap {
    position: relative;
  }
  .agent-activity-menu {
    position: absolute;
    z-index: 50;
    top: calc(100% + var(--space-1));
    right: 0;
    min-width: 12.25rem;
  }
  .agent-activity-paused {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-2) var(--space-2) var(--space-3);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    background: var(--surface);
    color: var(--text-2);
    font-size: var(--text-body);
  }
  .agent-activity-stats {
    padding-bottom: 0;
  }
  .agent-activity-row {
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
  }
  .agent-activity-row-files {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }
  .agent-activity-row-label {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
  }
  .agent-activity-row-tool {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-label);
  }
  .agent-activity-dot {
    flex: 0 0 auto;
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: var(--radius-full);
  }
  .agent-activity-dot-bad {
    background: var(--danger);
  }
  .agent-activity-dot-muted,
  .agent-activity-dot-ok {
    background: var(--text-3);
  }
  .agent-activity-empty {
    flex: 1 1 auto;
    padding-bottom: var(--space-12);
  }
  .agent-activity-empty .empty-state-text {
    max-width: 26rem;
  }
</style>
