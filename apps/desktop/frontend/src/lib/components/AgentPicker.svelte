<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import AgentGlyph from './AgentGlyph.svelte';
  import { tick } from 'svelte';
  import { vm } from '../stores/app.svelte';
  import { agentNavigation, agentStoreFor, codexAgentStore, claudeAgentStore, agentStore as kurloAgentStore, switchAgent } from '../stores/agent.svelte';
  import { claudeConnectionStore as claude } from '../stores/claude.svelte';
  import { codexConnectionStore } from '../stores/codex.svelte';
  import { aiConnectionsStore } from '../stores/aiConnections.svelte';
  import KurloGlyph from './KurloGlyph.svelte';
  import { agentKindMonogram } from '../agent';

  let { disabled = false }: { disabled?: boolean } = $props();

  let open = $state(false);
  let trigger = $state<HTMLButtonElement>();
  let panel = $state<HTMLDivElement>();
  let panelStyle = $state('');

  function placePanel() {
    if (!trigger) return;
    const anchor = trigger.getBoundingClientRect();
    const bounds = trigger.closest('.agent-main')?.getBoundingClientRect();
    const rem = parseFloat(getComputedStyle(document.documentElement).fontSize);
    const margin = rem * 0.5;
    const left = Math.max(margin, (bounds?.left ?? 0) + margin);
    const right = Math.min(window.innerWidth - margin, (bounds?.right ?? window.innerWidth) - margin);
    const width = Math.min(26 * rem, right - left);
    const x = Math.max(left, Math.min(anchor.right - width, right - width));
    const top = Math.max(margin, trigger.closest('.agent-workspace')?.getBoundingClientRect().top ?? margin);
    const above = Math.max(0, anchor.top - top - margin);
    const below = Math.max(0, window.innerHeight - anchor.bottom - margin);
    const vertical = above >= below ? `bottom:calc(100% + ${margin}px);top:auto;max-height:${above}px;` : `top:calc(100% + ${margin}px);bottom:auto;max-height:${below}px;`;
    panelStyle = `left:${x - anchor.left}px;right:auto;width:${width}px;${vertical}`;
  }

  $effect(() => {
    if (!open || !panel || !trigger) return;
    const observer = new ResizeObserver(placePanel);
    const main = trigger.closest('.agent-main');
    if (main) observer.observe(main);
    window.addEventListener('resize', placePanel);
    placePanel();
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', placePanel);
    };
  });

  const store = $derived(agentStoreFor(agentNavigation.mode));
  const codex = $derived(codexConnectionStore.status);
  const codexReady = $derived(codex.connected);
  const connections = $derived(aiConnectionsStore.list);
  const lockedMode = $derived(store.activeChatId ? agentNavigation.mode : null);
  const codexModelId = $derived(codexAgentStore.model || codex.model);
  const codexModel = $derived(codex.models.find(model => model.id === codexModelId));
  const connection = $derived(connections.find(item => item.id === kurloAgentStore.connectionId) ?? aiConnectionsStore.defaultConnection);
  const external = $derived(agentNavigation.mode === 'external');
  const usingClaude = $derived(agentNavigation.mode === 'claude');
  const kurloModel = $derived(kurloAgentStore.model || connection?.model || '');
  let modelQuery = $state('');
  const connectionModels = $derived(connection ? aiConnectionsStore.models[connection.id] ?? [] : []);
  const filteredModels = $derived.by(() => {
    const terms = modelQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = connectionModels.some(model => model.id === kurloModel) || !kurloModel ? connectionModels : [{ id: kurloModel, name: kurloModel, recommended: false, weakTools: false }, ...connectionModels];
    return terms.length ? list.filter(model => terms.every(term => `${model.name} ${model.id}`.toLowerCase().includes(term))) : list;
  });
  const filteredCodexModels = $derived.by(() => {
    const terms = modelQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = codex.models.some(model => model.id === codexModelId) || !codexModelId ? codex.models : [{ id: codexModelId, name: codexModelId, recommended: false, weakTools: false }, ...codex.models];
    return terms.length ? list.filter(model => terms.every(term => `${model.name} ${model.id}`.toLowerCase().includes(term))) : list;
  });
  const claudeModelId = $derived(claudeAgentStore.model || claude.status.model);
  const claudeModel = $derived(claude.models.find(model => model.id === claudeModelId));
  const filteredClaudeModels = $derived.by(() => {
    const terms = modelQuery.trim().toLowerCase().split(/\s+/).filter(Boolean);
    const list = claude.models;
    return terms.length ? list.filter(model => terms.every(term => `${model.name} ${model.id}`.toLowerCase().includes(term))) : list;
  });
  const summary = $derived(external
    ? codexModel?.name || codexModelId || 'Codex'
    : usingClaude ? claudeModel?.name || claudeModelId || 'Claude Code' : connection ? (kurloModel || connection.label) : 'No model');

  async function toggle() {
    open = !open;
    if (!open) return;
    modelQuery = '';
    if (!external && !usingClaude && connection) void aiConnectionsStore.loadModels(connection.id);
    await tick();
    const current = panel?.querySelector<HTMLButtonElement>('.agent-model-option[aria-checked="true"]:not(:disabled)') ?? panel?.querySelector<HTMLButtonElement>('[data-pick][aria-checked="true"]:not(:disabled)') ?? panel?.querySelector<HTMLButtonElement>('[data-pick]:not(:disabled)');
    current?.focus();
  }

  function close(focusTrigger = true) {
    open = false;
    if (focusTrigger) trigger?.focus();
  }

  function pickCodex() {
    if (external) return;
    switchAgent('external');
    modelQuery = '';
  }

  function pickCodexModel(id: string) {
    switchAgent('external');
    codexAgentStore.model = id;
    const next = codex.models.find(model => model.id === id);
    if (!(next?.efforts ?? []).includes(codexAgentStore.effort)) codexAgentStore.effort = '';
    close();
  }

  function pickClaude() {
    if (usingClaude) return;
    switchAgent('claude');
    modelQuery = '';
  }

  function pickClaudeModel(id: string) {
    switchAgent('claude');
    claudeAgentStore.model = id === claude.status.model ? '' : id;
    close();
  }

  function pickConnection(id: string) {
    switchAgent('kurlo');
    if (kurloAgentStore.connectionId !== id || !kurloAgentStore.connectionId) kurloAgentStore.model = '';
    kurloAgentStore.connectionId = id;
    modelQuery = '';
    void aiConnectionsStore.loadModels(id);
  }

  function pickKurloModel(id: string) {
    switchAgent('kurlo');
    if (connection) kurloAgentStore.connectionId = connection.id;
    kurloAgentStore.model = id === connection?.model ? '' : id;
    close();
  }

  function manage(intent: '' | 'key' = '') {
    close(false);
    aiConnectionsStore.intent = intent;
    aiConnectionsStore.reveal = agentNavigation.mode === 'kurlo' ? 'kurlo' : 'agents';
    vm.openSettings('ai');
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      close();
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const items = Array.from(panel?.querySelectorAll<HTMLButtonElement>('[data-pick]:not(:disabled)') ?? []);
    if (!items.length) return;
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : (index - 1 + items.length) % items.length;
    items[next]?.focus();
  }

  function onWindowPointerDown(event: PointerEvent) {
    if (!open) return;
    const target = event.target;
    if (target instanceof Element && target.closest('.agent-picker')) return;
    open = false;
  }
</script>

<svelte:window onpointerdown={onWindowPointerDown} />


{#snippet modelList(label: string, models: Array<{ id: string; name: string }>, chosenId: string, defaultId: string, pick: (id: string) => void, loading: boolean, error: string, retry: () => void, total: number)}
  <div class="agent-pick-nested agent-pick-models">
    <label class="agent-model-search">
      <svg width="0.75rem" height="0.75rem" viewBox="0 0 13 13" fill="none" aria-hidden="true"><circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/><path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
      <input type="search" bind:value={modelQuery} placeholder="Search models" aria-label={`Search ${label} models`} spellcheck="false" data-pick />
    </label>
    {#if loading}
      <span class="agent-pick-meta agent-model-note" role="status"><span class="spinner spinner-inline"></span> Loading models…</span>
    {:else if error}
      <span class="agent-model-note agent-model-error" role="alert">{error} <button class="btn-link" type="button" onclick={retry}>Retry</button></span>
    {:else}
      <div class="agent-model-list" role="radiogroup" aria-label={`${label} model`} style={`min-height:min(12rem, ${Math.max(total, 1)} * var(--control-md))`}>
        {#each models as model (model.id)}
          {@const chosen = model.id === chosenId}
          <button class="menu-item agent-pick-option agent-model-option" class:selected={chosen} type="button" role="radio" aria-checked={chosen} data-pick onclick={() => pick(model.id)}>
            <span class="agent-pick-title">{model.name || model.id}</span>
            {#if model.id === defaultId}<span class="agent-pick-meta">default</span>{/if}
            {#if chosen}{@render check()}{/if}
          </button>
        {:else}
          <span class="agent-pick-meta agent-model-note">No model matches.</span>
        {/each}
      </div>
    {/if}
  </div>
{/snippet}

{#snippet check()}
  <svg class="agent-pick-check" width="0.75rem" height="0.75rem" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M2.5 6.5 5 9l4.5-6" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
{/snippet}

<div class="agent-picker">
  <button
    class="agent-picker-trigger"
    class:open
    type="button"
    bind:this={trigger}
    aria-haspopup="dialog"
    aria-expanded={open}
    aria-label={`Agent: ${external ? 'Codex' : usingClaude ? 'Claude Code' : 'Kurlo agent'} · ${summary}`}
    onclick={() => void toggle()}
    {disabled}
  >
    {#if external || usingClaude}
      <span class="agent-glyph agent-glyph-codex" class:agent-glyph-claude={usingClaude} aria-hidden="true"><AgentGlyph driver={usingClaude ? 'claude-code' : 'codex'} /></span>
      <span class="agent-picker-name">{usingClaude ? 'Claude Code' : 'Codex'}</span>
    {:else}
      <span class="agent-glyph agent-glyph-kurlo" aria-hidden="true"><KurloGlyph size="0.8125rem" /></span>
    {/if}
    <span class="agent-picker-summary">{summary}</span>
    <svg class="agent-picker-chevron" width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M2.5 3.75 5 6.25l2.5-2.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
  </button>

  {#if open}
    <div class="agent-picker-panel" role="dialog" aria-label="Choose agent and model" tabindex="-1" bind:this={panel} onkeydown={onKeydown} style={panelStyle}>
      <div class="agent-pick-section">
        <span class="agent-pick-label">On this computer</span>
        {#if codexReady}
          <div role="radiogroup" aria-label="Codex">
            <button class="menu-item agent-pick-option agent-pick-connection" class:selected={external} type="button" role="radio" aria-checked={external} data-pick disabled={lockedMode !== null && lockedMode !== 'external'} onclick={pickCodex}>
              <span class="agent-glyph agent-glyph-codex agent-glyph-lg" aria-hidden="true"><AgentGlyph driver="codex" size="1rem" /></span>
              <span class="agent-pick-text">
                <span class="agent-pick-title">Codex</span>
                <span class="agent-pick-meta">{external ? (codexModel?.name || codexModelId || codex.account || 'Signed in') : (codex.account || 'Signed in')}</span>
              </span>
              <span class="agent-pick-state" class:agent-pick-state-error={Boolean(codex.error)}><span class="agent-dot" class:agent-dot-ok={!codex.error}></span>{codex.error ? 'Unavailable' : 'Ready'}</span>
              {#if external}{@render check()}{/if}
            </button>
            {#if external}
              {@render modelList('Codex', filteredCodexModels, codexModelId, codex.model, pickCodexModel, false, '', () => {}, codex.models.length)}
            {/if}
          </div>
        {:else}
          <div class="agent-pick-agent">
            <span class="agent-glyph agent-glyph-codex agent-glyph-lg" aria-hidden="true"><AgentGlyph driver="codex" size="1rem" /></span>
            <span class="agent-pick-text">
              <span class="agent-pick-title">Codex</span>
              <span class="agent-pick-meta">{codex.installed ? 'Not connected' : codexConnectionStore.loaded ? 'Not installed' : 'Checking…'}</span>
            </span>
            <button class="btn btn-secondary btn-xs" type="button" data-pick onclick={() => manage()}>Connect</button>
          </div>
        {/if}
        {#if claude.usable}
          <div role="radiogroup" aria-label="Claude Code">
            <button class="menu-item agent-pick-option agent-pick-connection" class:selected={usingClaude} type="button" role="radio" aria-checked={usingClaude} data-pick disabled={lockedMode !== null && lockedMode !== 'claude'} onclick={pickClaude}>
              <span class="agent-glyph agent-glyph-codex agent-glyph-claude agent-glyph-lg" aria-hidden="true"><AgentGlyph driver="claude-code" size="1rem" /></span>
              <span class="agent-pick-text">
                <span class="agent-pick-title">Claude Code</span>
                <span class="agent-pick-meta">{usingClaude ? (claudeModel?.name || claudeModelId || claude.status.account) : (claude.status.account || 'Signed in')}</span>
              </span>
              <span class="agent-pick-state"><span class="agent-dot agent-dot-ok"></span>Ready</span>
              {#if usingClaude}{@render check()}{/if}
            </button>
            {#if usingClaude}
              {@render modelList('Claude Code', filteredClaudeModels, claudeModelId, claude.status.model, pickClaudeModel, false, '', () => {}, claude.status.models.length)}
            {/if}
          </div>
        {:else}
          <div class="agent-pick-agent">
            <span class="agent-glyph agent-glyph-codex agent-glyph-claude agent-glyph-lg" aria-hidden="true"><AgentGlyph driver="claude-code" size="1rem" /></span>
            <span class="agent-pick-text"><span class="agent-pick-title">Claude Code</span><span class="agent-pick-meta">{!claude.loaded ? 'Checking…' : claude.status.authenticated ? 'Not connected' : claude.status.installed ? 'Not signed in' : 'Not installed'}</span></span>
            <button class="btn btn-secondary btn-xs" type="button" data-pick onclick={() => manage()}>Connect</button>
          </div>
        {/if}
      </div>

      <div class="agent-pick-section">
        <span class="agent-pick-label agent-pick-label-kurlo"><KurloGlyph size="0.75rem" />Kurlo agent · any model</span>
        {#if connections.length}
          <div role="radiogroup" aria-label="Kurlo agent model">
            {#each connections as item (item.id)}
              {@const selected = !external && !usingClaude && item.id === connection?.id}
              <button class="menu-item agent-pick-option agent-pick-connection" class:selected type="button" role="radio" aria-checked={selected} data-pick disabled={lockedMode !== null && lockedMode !== 'kurlo'} onclick={() => pickConnection(item.id)}>
                <span class="agent-glyph agent-glyph-lg agent-glyph-kind" aria-hidden="true">{agentKindMonogram(item.kind)}</span>
                <span class="agent-pick-text">
                  <span class="agent-pick-title">{item.label}</span>
                  <span class="agent-pick-meta">{selected ? kurloModel : item.model}</span>
                </span>
                {#if item.default}<span class="agent-pick-badge">Default</span>{/if}
                {#if selected}{@render check()}{/if}
              </button>
              {#if selected}
                {@render modelList(item.label, filteredModels, kurloModel, item.model, pickKurloModel, Boolean(aiConnectionsStore.modelsLoading[item.id] && !connectionModels.length), !connectionModels.length ? aiConnectionsStore.modelsError[item.id] ?? '' : '', () => void aiConnectionsStore.loadModels(item.id, true), connectionModels.length)}
              {/if}
            {/each}
          </div>
        {:else}
          <button class="menu-item agent-pick-option" type="button" data-pick onclick={() => manage('key')}>
            <span class="agent-glyph agent-glyph-lg agent-glyph-kind" aria-hidden="true"><AddCloseIcon add /></span>
            <span class="agent-pick-text">
              <span class="agent-pick-title">Add a model</span>
              <span class="agent-pick-meta">OpenRouter, an API key or a local model</span>
            </span>
          </button>
        {/if}
      </div>

      {#if lockedMode}
        <p class="agent-pick-note">Start a new chat to switch to another agent.</p>
      {/if}

      <div class="agent-pick-footer">
        <button class="btn-link agent-pick-manage" type="button" onclick={() => manage()}>Manage connections</button>
      </div>
    </div>
  {/if}
</div>

<style>
  .agent-picker {
    position: relative;
    min-width: 0;
    flex: 1 1 auto;
  }
  .agent-picker-trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    width: 100%;
    max-width: 100%;
    min-width: 0;
    height: var(--control-md);
    padding: 0 var(--space-2) 0 var(--space-1);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text);
    font: inherit;
    font-size: var(--text-label);
    cursor: pointer;
    transition: background var(--dur-fast), border-color var(--dur-fast), box-shadow var(--dur-fast);
  }
  .agent-picker-trigger:hover:not(:disabled) {
    background: var(--hover);
  }
  .agent-picker-trigger.open {
    border-color: var(--accent);
    box-shadow: var(--focus-ring);
  }
  .agent-picker-trigger:disabled {
    opacity: var(--opacity-disabled);
    cursor: not-allowed;
  }
  .agent-picker-name {
    font-weight: var(--weight-medium);
    white-space: nowrap;
  }
  .agent-picker-summary {
    min-width: 0;
    overflow: hidden;
    color: var(--text-2);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-picker-chevron {
    flex: 0 0 auto;
    color: var(--text-3);
  }
  @container agent-main (max-width: 34rem) {
    .agent-picker-name {
      display: none;
    }
  }
  .agent-glyph {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    justify-content: center;
    width: 1.125rem;
    height: 1.125rem;
    border-radius: var(--radius-sm);
    font-family: var(--font-mono);
    font-size: 0.5625rem;
    font-weight: var(--weight-semibold);
    line-height: 1;
  }
  .agent-glyph-lg {
    width: 1.5rem;
    height: 1.5rem;
    border-radius: var(--radius-md);
    font-size: 0.625rem;
  }
  .agent-glyph-codex {
    background: var(--text);
    color: var(--bg);
  }
  .agent-glyph-claude {
    background: var(--claude-tile);
  }
  .agent-glyph-kurlo {
    background: var(--accent-dim);
    color: var(--accent);
  }
  .agent-glyph-kind {
    background: var(--elevated);
    color: var(--text-2);
  }
  .agent-picker-panel {
    position: absolute;
    right: 0;
    bottom: calc(100% + var(--space-1-5));
    z-index: 150;
    display: flex;
    flex-direction: column;
    width: min(26rem, 86vw);
    max-height: min(32rem, 70vh);
    overflow: auto;
    border: 1px solid var(--border);
    border-radius: var(--radius-xl);
    background: var(--modal-bg);
    box-shadow: var(--shadow-popover);
  }
  .agent-picker-panel:focus {
    outline: none;
  }
  .agent-pick-section {
    display: flex;
    flex-direction: column;
    padding: var(--space-1-5);
  }
  .agent-pick-section + .agent-pick-section {
    border-top: 1px solid var(--border-subtle);
  }
  .agent-pick-label {
    padding: var(--space-1) var(--space-2) var(--space-1);
    color: var(--text-3);
    font-size: var(--text-caption);
    font-weight: var(--weight-medium);
  }
  .agent-pick-label-kurlo {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
  }
  .agent-pick-label-kurlo :global(.kurlo-glyph) {
    color: var(--accent);
  }
  .agent-pick-agent {
    display: flex;
    align-items: center;
    gap: var(--space-2-5);
    padding: var(--space-1-5) var(--space-2);
  }
  .agent-pick-text {
    display: flex;
    flex: 1 1 auto;
    flex-direction: column;
    min-width: 0;
  }
  .agent-pick-title {
    min-width: 0;
    overflow: hidden;
    color: var(--text);
    font-size: var(--text-body);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-pick-meta {
    min-width: 0;
    overflow: hidden;
    color: var(--text-3);
    font-size: var(--text-caption);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .agent-pick-state {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    color: var(--s2xx);
    font-size: var(--text-caption);
  }
  .agent-pick-state-error {
    color: var(--s5xx);
  }
  .agent-dot {
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: var(--radius-full);
    background: currentColor;
  }
  .agent-dot-ok {
    background: var(--s2xx);
  }
  .agent-pick-nested {
    display: flex;
    flex-direction: column;
    margin: 0 0 var(--space-1) calc(var(--space-2) + 1.5rem + var(--space-1));
    padding-left: var(--space-1-5);
    border-left: 1px solid var(--border-subtle);
  }
  .agent-pick-option {
    gap: var(--space-2-5);
    min-height: var(--control-lg);
    padding: var(--space-1) var(--space-2);
    border-radius: var(--radius-md);
  }
  .agent-pick-option.selected {
    background: var(--accent-dim);
  }
  .agent-pick-option > .agent-pick-title {
    flex: 1 1 auto;
  }
  .agent-pick-check {
    flex: 0 0 auto;
    margin-left: auto;
    color: var(--accent);
  }
  .agent-pick-badge {
    flex: 0 0 auto;
    padding: 0 var(--space-1-5);
    border-radius: var(--radius-sm);
    background: var(--elevated);
    color: var(--text-2);
    font-size: var(--text-caption);
    line-height: 1.5;
  }
  .agent-pick-models {
    gap: var(--space-1);
    padding-top: var(--space-1);
  }
  .agent-model-search {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    height: var(--control-md);
    margin: 0 var(--space-1) var(--space-0-5);
    padding: 0 var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--bg);
    color: var(--text-3);
  }
  .agent-model-search:focus-within {
    border-color: var(--accent);
    box-shadow: var(--focus-ring);
  }
  .agent-model-search input {
    flex: 1;
    min-width: 0;
    border: none;
    outline: none;
    background: transparent;
    color: var(--text);
    font: inherit;
    font-size: var(--text-label);
  }
  .agent-model-list {
    display: flex;
    flex-direction: column;
    max-height: 12rem;
    overflow-y: auto;
  }
  .agent-model-option {
    min-height: var(--control-md);
  }
  .agent-model-note {
    padding: var(--space-1-5) var(--space-2);
  }
  .agent-model-error {
    color: var(--danger);
    font-size: var(--text-caption);
  }
  .agent-pick-note {
    margin: 0;
    padding: var(--space-2) var(--space-3);
    border-top: 1px solid var(--border-subtle);
    color: var(--text-3);
    font-size: var(--text-caption);
  }
  .agent-pick-footer {
    display: flex;
    align-items: center;
    padding: var(--space-2) var(--space-3);
    border-top: 1px solid var(--border-subtle);
    background: var(--surface);
  }
  .agent-pick-manage {
    font-size: var(--text-label);
  }
</style>
