<script lang="ts">
  import AgentMcpSettings from './AgentMcpSettings.svelte';
  import Disclosure from './Disclosure.svelte';
  import { codexConnectionStore } from '../stores/codex.svelte';
  import { claudeConnectionStore } from '../stores/claude.svelte';
  import { onMount, tick } from 'svelte';
  import Select from './Select.svelte';
  import ClaudeConnectionSettings from './ClaudeConnectionSettings.svelte';
  import CodexConnectionSettings from './CodexConnectionSettings.svelte';
  import AiModelCombobox from './AiModelCombobox.svelte';
  import { agentKindMonogram } from '../agent';
  import { aiConnectionsStore } from '../stores/aiConnections.svelte';
  import {
    aiConnections, saveAiConnection, removeAiConnection, setDefaultAiConnection, testAiConnection,
    discoverLocalAiServers, startOpenRouterConnect, cancelOpenRouterConnect, reopenOpenRouterConnect,
    openRouterConnectStatus, onOpenRouterConnect,
    type AiConnection, type AiConnectionInput, type AiConnectionModel, type AiConnectionsState,
    type AiLocalServer, type OpenRouterConnectState,
  } from '../backend';

  type KeyKind = 'anthropic' | 'openai' | 'compatible';

  const KIND_LABELS: Record<string, string> = {
    openrouter: 'OpenRouter',
    anthropic: 'Anthropic',
    openai: 'OpenAI',
    compatible: 'OpenAI-compatible',
    local: 'Local model',
  };
  const KEY_KINDS: Array<{ value: KeyKind; label: string }> = [
    { value: 'anthropic', label: 'Anthropic' },
    { value: 'openai', label: 'OpenAI' },
    { value: 'compatible', label: 'OpenAI-compatible' },
  ];
  const KEY_PLACEHOLDERS: Record<KeyKind, string> = {
    anthropic: 'sk-ant-…',
    openai: 'sk-proj-…',
    compatible: 'Optional for servers without auth',
  };

  const AI_CONNECTION_LIMIT = 10;

  let connections = $state<AiConnection[]>([]);
  const atLimit = $derived(connections.length >= AI_CONNECTION_LIMIT);
  let listError = $state('');
  let loaded = $state(false);
  let addMode = $state<'none' | 'key' | 'local'>('none');
  const revealed = aiConnectionsStore.reveal;
  aiConnectionsStore.reveal = '';
  const agentsSummary = $derived.by(() => {
    const connected = [
      codexConnectionStore.status.connected ? 'Codex' : '',
      claudeConnectionStore.status.connected ? 'Claude Code' : '',
    ].filter(Boolean);
    if (connected.length) return `${connected.join(' · ')} connected`;
    return codexConnectionStore.loaded && claudeConnectionStore.loaded ? 'Not connected' : 'Checking…';
  });
  const kurloSummary = $derived.by(() => {
    if (!loaded) return '';
    if (!connections.length) return 'No connections';
    const fallback = connections.find(connection => connection.default) ?? connections[0];
    return `${connections.length} ${connections.length === 1 ? 'connection' : 'connections'} · ${fallback.label}${fallback.model ? ` · ${fallback.model}` : ''}`;
  });

  let openRouter = $state<OpenRouterConnectState>({ status: 'idle', authUrl: '' });

  let keyKind = $state<KeyKind>('anthropic');
  let keyValue = $state('');
  let keyBaseURL = $state('');
  let keyBusy = $state(false);
  let keyError = $state('');
  let keyModels = $state<AiConnectionModel[]>([]);
  let keyModel = $state('');

  let localBusy = $state(false);
  let localSearched = $state(false);
  let localServers = $state<AiLocalServer[]>([]);
  let localChoice = $state<Record<string, string>>({});
  let localManualURL = $state('');
  let localManualModels = $state<AiConnectionModel[]>([]);
  let localManualModel = $state('');
  let localError = $state('');

  let modelLists = $state<Record<string, AiConnectionModel[]>>({});
  let modelLoading = $state<Record<string, boolean>>({});
  let modelErrors = $state<Record<string, string>>({});
  let pendingRemove = $state('');

  function input(fields: Partial<AiConnectionInput>): AiConnectionInput {
    return { id: '', kind: '', label: '', baseUrl: '', key: '', model: '', ...fields };
  }

  function apply(state: AiConnectionsState) {
    connections = state.connections ?? [];
    if (!state.error) aiConnectionsStore.set(connections);
    listError = state.error ?? '';
    loaded = true;
  }

  async function refresh() {
    apply(await aiConnections());
  }

  function modelsWithCurrent(models: AiConnectionModel[], current: string): AiConnectionModel[] {
    if (!current || models.some(model => model.id === current)) return models;
    return [{ id: current, name: current, recommended: false, weakTools: false }, ...models];
  }

  function firstUsableModel(models: AiConnectionModel[]): string {
    return (models.find(model => !model.weakTools) ?? models[0])?.id ?? '';
  }

  function connectionDetail(connection: AiConnection): string {
    if (connection.kind === 'local' || connection.kind === 'compatible') return connection.baseUrl;
    return connection.keyHint || 'no key';
  }

  function connectionKind(connection: AiConnection): string {
    const kind = KIND_LABELS[connection.kind] ?? connection.kind;
    return kind === connection.label ? '' : `${kind} · `;
  }

  async function loadModels(connection: AiConnection) {
    modelLoading = { ...modelLoading, [connection.id]: true };
    modelErrors = { ...modelErrors, [connection.id]: '' };
    const result = await testAiConnection(input({ id: connection.id }));
    modelLoading = { ...modelLoading, [connection.id]: false };
    if (!result.ok) {
      modelErrors = { ...modelErrors, [connection.id]: result.error ?? 'Kurlo could not load the models.' };
      return;
    }
    modelLists = { ...modelLists, [connection.id]: result.models };
  }

  async function chooseModel(connection: AiConnection, model: string) {
    apply(await saveAiConnection(input({ id: connection.id, kind: connection.kind, label: connection.label, baseUrl: connection.baseUrl, model })));
  }

  async function makeDefault(connection: AiConnection) {
    apply(await setDefaultAiConnection(connection.id));
  }

  async function remove(connection: AiConnection) {
    if (pendingRemove !== connection.id) {
      pendingRemove = connection.id;
      return;
    }
    pendingRemove = '';
    apply(await removeAiConnection(connection.id));
  }

  function applyOpenRouter(state: OpenRouterConnectState) {
    const wasConnected = openRouter.status === 'connected';
    openRouter = state;
    if (state.status === 'connected' && !wasConnected) void refresh();
  }

  async function connectOpenRouter() {
    applyOpenRouter(await startOpenRouterConnect());
  }

  async function cancelOpenRouter() {
    applyOpenRouter(await cancelOpenRouterConnect());
  }

  async function reopenOpenRouter() {
    applyOpenRouter(await reopenOpenRouterConnect());
  }

  async function pollOpenRouter() {
    if (openRouter.status !== 'waiting') return;
    const state = await openRouterConnectStatus();
    if (state.status !== 'waiting' || openRouter.status === 'waiting') applyOpenRouter(state);
  }

  $effect(() => {
    if (openRouter.status !== 'waiting') return;
    const timer = setInterval(() => void pollOpenRouter(), 1500);
    const onFocus = () => void pollOpenRouter();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  });

  function keyInput(): AiConnectionInput {
    return input({ kind: keyKind, key: keyValue, baseUrl: keyKind === 'compatible' ? keyBaseURL : '', model: keyModel });
  }

  function resetKeyForm() {
    keyValue = '';
    keyBaseURL = '';
    keyError = '';
    keyModels = [];
    keyModel = '';
  }

  async function testKey() {
    keyBusy = true;
    keyError = '';
    const result = await testAiConnection(keyInput());
    keyBusy = false;
    if (!result.ok) {
      keyError = result.error ?? 'Kurlo could not check the key.';
      keyModels = [];
      return;
    }
    keyModels = result.models;
    if (!keyModel) keyModel = firstUsableModel(result.models);
  }

  async function saveKey() {
    keyBusy = true;
    keyError = '';
    const state = await saveAiConnection(keyInput());
    keyBusy = false;
    if (state.error) {
      keyError = state.error;
      return;
    }
    apply(state);
    resetKeyForm();
    addMode = 'none';
  }

  async function findLocal() {
    localBusy = true;
    localError = '';
    const discovery = await discoverLocalAiServers();
    localBusy = false;
    localSearched = true;
    localServers = discovery.servers ?? [];
    const choice: Record<string, string> = {};
    for (const server of localServers) choice[server.baseUrl] = firstUsableModel(server.models);
    localChoice = choice;
  }

  async function useLocal(name: string, baseUrl: string, model: string) {
    localError = '';
    const state = await saveAiConnection(input({ kind: 'local', label: name, baseUrl, model }));
    if (state.error) {
      localError = state.error;
      return;
    }
    apply(state);
    addMode = 'none';
    localSearched = false;
    localManualModels = [];
  }

  async function checkManualLocal() {
    localBusy = true;
    localError = '';
    const result = await testAiConnection(input({ kind: 'local', baseUrl: localManualURL }));
    localBusy = false;
    if (!result.ok) {
      localError = result.error ?? 'Kurlo could not reach that server.';
      localManualModels = [];
      return;
    }
    localManualModels = result.models;
    localManualModel = firstUsableModel(result.models);
  }

  let addForm = $state<HTMLElement>();

  async function openAdd(mode: 'key' | 'local') {
    addMode = addMode === mode ? 'none' : mode;
    if (mode === 'local' && !localSearched && addMode === 'local') void findLocal();
    if (addMode === 'none') return;
    await tick();
    if (!addForm) return;
    const reduced = window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
    addForm.scrollIntoView({ behavior: reduced ? 'auto' : 'smooth', block: 'nearest' });
    addForm.querySelector<HTMLElement>(mode === 'key' ? '#ai-key-value' : '#ai-local-url')?.focus({ preventScroll: true });
  }

  onMount(() => {
    void refresh();
    if (!codexConnectionStore.loaded) void codexConnectionStore.refresh();
    if (!claudeConnectionStore.loaded) void claudeConnectionStore.refresh();
    const intent = aiConnectionsStore.intent;
    aiConnectionsStore.intent = '';
    if (intent) void openAdd(intent);
    void openRouterConnectStatus().then(state => {
      if (state.status === 'waiting') openRouter = state;
    });
    return onOpenRouterConnect(state => applyOpenRouter(state));
  });
</script>

<div class="settings-body ai-connections" id="settings-panel-ai" role="tabpanel">
  <header class="settings-page-head">
    <div class="settings-page-head-text">
      <h3 class="settings-page-title">AI</h3>
      <p class="settings-page-desc">Agents and models for the Agent tab and AI requests.</p>
    </div>
  </header>

  <Disclosure title="Your agents" summary={agentsSummary} storageKey="settings-ai-agents" reveal={revealed === 'agents'} conceal={revealed === 'models'} defaultOpen={codexConnectionStore.loaded && claudeConnectionStore.loaded && !codexConnectionStore.status.connected && !claudeConnectionStore.status.connected} variant="settings">
    <CodexConnectionSettings />
    <ClaudeConnectionSettings />
    <p class="settings-group-note">Agents on this computer run with their own account and reach this workspace through Kurlo's tools. Changes still wait for your approval.</p>
  </Disclosure>

  <Disclosure title="Kurlo agent" summary={kurloSummary} storageKey="settings-ai-kurlo" reveal={revealed === 'kurlo' || revealed === 'models'} defaultOpen={loaded && !connections.length} forceOpen={addMode !== 'none' || openRouter.status === 'waiting'} variant="settings">
    {#if listError}<p class="settings-group-note error" role="alert">{listError}</p>{/if}
    {#if loaded && connections.length}
      <ul class="settings-group ai-connection-list" aria-label="AI connections">
        {#each connections as connection (connection.id)}
          <li class="settings-row ai-connection-row">
            <span class="settings-glyph" aria-hidden="true">{agentKindMonogram(connection.kind)}</span>
            <div class="settings-row-text">
              <span class="settings-row-title ai-connection-name">
                {connection.label}
                {#if connection.default}<span class="settings-pill accent">Default</span>{/if}
              </span>
              <span class="settings-row-desc ai-connection-meta">{connectionKind(connection)}<span class="ai-mono">{connectionDetail(connection)}</span></span>
            </div>
            <div class="settings-row-control">
              <div class="ai-connection-model">
                <AiModelCombobox
                  models={modelsWithCurrent(modelLists[connection.id] ?? [], connection.model)}
                  value={connection.model}
                  loading={modelLoading[connection.id] ?? false}
                  error={modelErrors[connection.id] ?? ''}
                  ariaLabel={`Model for ${connection.label}`}
                  onOpen={() => { if (!modelLists[connection.id]) void loadModels(connection); }}
                  onChange={value => chooseModel(connection, value)}
                />
              </div>
              <div class="ai-connection-actions">
                {#if !connection.default}
                  <button class="btn btn-ghost btn-sm" type="button" onclick={() => makeDefault(connection)}>Make default</button>
                {/if}
                <button class="btn btn-ghost btn-sm" class:btn-danger={pendingRemove === connection.id} type="button" onclick={() => remove(connection)} onblur={() => pendingRemove === connection.id && (pendingRemove = '')}>
                  {pendingRemove === connection.id ? 'Remove?' : 'Remove'}
                </button>
              </div>
            </div>
          </li>
        {/each}
      </ul>
    {/if}
    <p class="settings-group-note">The Kurlo agent and AI requests run on these. Keys are encrypted with the key in your system keychain and never written to workspace files; AI requests can also keep their own URL and key.{#if connections.length}{' '}{connections.length} of {AI_CONNECTION_LIMIT} connections.{/if}</p>
    <h4 class="settings-group-label ai-add-label">{connections.length ? 'Add another connection' : 'Connect a model'}</h4>
    {#if atLimit}
      <p class="settings-group-note ai-limit" role="status">You have {AI_CONNECTION_LIMIT} connections, the most Kurlo keeps. Remove one to add another.</p>
    {:else}
      <div class="settings-group ai-options">
        <div class="settings-row ai-option" class:ai-option-featured={!connections.length && addMode === 'none'}>
          <span class="settings-glyph" aria-hidden="true">OR</span>
          <div class="settings-row-text">
            <span class="settings-row-title">OpenRouter</span>
            <span class="settings-row-desc">Sign in and pay OpenRouter directly. Claude, GPT, Gemini and more with one account.</span>
            {#if openRouter.status === 'failed' && openRouter.error}<span class="ai-error" role="alert">{openRouter.error}</span>{/if}
            {#if openRouter.status === 'connected'}<span class="ai-ok" role="status">Connected to OpenRouter</span>{/if}
            {#if openRouter.status === 'waiting'}<span class="ai-waiting" role="status"><span class="spinner spinner-inline"></span> Finish signing in in your browser</span>{/if}
          </div>
          <div class="settings-row-control">
            {#if openRouter.status === 'waiting'}
              <button class="btn btn-secondary btn-sm" type="button" onclick={reopenOpenRouter}>Reopen browser</button>
              <button class="btn btn-ghost btn-sm" type="button" onclick={cancelOpenRouter}>Cancel</button>
            {:else}
              <button class={connections.length ? 'btn btn-secondary btn-sm' : 'btn btn-primary btn-sm'} type="button" onclick={connectOpenRouter}>
                {connections.some(connection => connection.kind === 'openrouter') ? 'Reconnect' : 'Connect OpenRouter'}
              </button>
            {/if}
          </div>
        </div>

        <div class="settings-row ai-option" class:ai-option-open={addMode === 'key'}>
          <span class="settings-glyph" aria-hidden="true">
            <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none"><circle cx="5.5" cy="10.5" r="3" stroke="currentColor" stroke-width="1.4"/><path d="M7.7 8.3 13.5 2.5M11.5 4.5l2 2" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </span>
          <div class="settings-row-text">
            <span class="settings-row-title">Your API key</span>
            <span class="settings-row-desc">Anthropic, OpenAI or any OpenAI-compatible endpoint.</span>
          </div>
          <div class="settings-row-control">
            <button class="btn btn-secondary btn-sm" type="button" aria-expanded={addMode === 'key'} onclick={() => openAdd('key')}>Add key</button>
          </div>
          {#if addMode === 'key'}
            <form class="settings-row-block ai-form" bind:this={addForm} aria-label="Add an API key" onsubmit={(event) => { event.preventDefault(); void saveKey(); }}>
              <div class="ai-form-row">
                <span class="ai-form-label">Provider</span>
                <Select value={keyKind} options={KEY_KINDS} className="ai-form-select" ariaLabel="Provider" onChange={value => { keyKind = value as KeyKind; keyModels = []; keyModel = ''; keyError = ''; }} />
              </div>
              {#if keyKind === 'compatible'}
                <div class="ai-form-row">
                  <label class="ai-form-label" for="ai-key-base-url">Base URL</label>
                  <input id="ai-key-base-url" class="field ai-form-input" type="url" spellcheck="false" autocomplete="off" placeholder="https://llm.example.com/v1" bind:value={keyBaseURL} />
                </div>
              {/if}
              <div class="ai-form-row">
                <label class="ai-form-label" for="ai-key-value">API key</label>
                <input id="ai-key-value" class="field ai-form-input ai-mono" type="password" spellcheck="false" autocomplete="off" placeholder={KEY_PLACEHOLDERS[keyKind]} bind:value={keyValue} oninput={() => { keyModels = []; }} />
              </div>
              {#if keyModels.length}
                <div class="ai-form-row">
                  <span class="ai-form-label">Model</span>
                  <AiModelCombobox models={keyModels} value={keyModel} ariaLabel="Model" onChange={value => (keyModel = value)} />
                </div>
                <span class="ai-ok ai-form-note" role="status">The key works. {keyModels.length} {keyModels.length === 1 ? 'model' : 'models'} available.</span>
              {/if}
              {#if keyError}<span class="ai-error ai-form-note" role="alert">{keyError}</span>{/if}
              <div class="ai-form-actions">
                <button class="btn btn-ghost btn-sm" type="button" onclick={() => { resetKeyForm(); addMode = 'none'; }}>Cancel</button>
                <button class="btn btn-secondary btn-sm" type="button" disabled={keyBusy} onclick={testKey}>{keyBusy ? 'Checking…' : 'Test'}</button>
                <button class="btn btn-primary btn-sm" type="submit" disabled={keyBusy}>Save</button>
              </div>
            </form>
          {/if}
        </div>

        <div class="settings-row ai-option" class:ai-option-open={addMode === 'local'}>
          <span class="settings-glyph" aria-hidden="true">
            <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none"><rect x="2" y="3" width="12" height="8" rx="1.5" stroke="currentColor" stroke-width="1.4"/><path d="M5.5 13.5h5M8 11v2.5" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          </span>
          <div class="settings-row-text">
            <span class="settings-row-title">Local model</span>
            <span class="settings-row-desc">Ollama or LM Studio on this machine. Nothing leaves your computer.</span>
          </div>
          <div class="settings-row-control">
            <button class="btn btn-secondary btn-sm" type="button" aria-expanded={addMode === 'local'} onclick={() => openAdd('local')}>Find local models</button>
          </div>
          {#if addMode === 'local'}
            <div class="settings-row-block ai-form" bind:this={addForm} aria-label="Local models">
              {#if localBusy && !localSearched}
                <span class="ai-waiting" role="status"><span class="spinner spinner-inline"></span> Looking for Ollama and LM Studio…</span>
              {:else if localSearched && !localServers.length}
                <span class="ai-option-text">No Ollama or LM Studio found on this machine. Start one, or enter the URL of an OpenAI-compatible server.</span>
              {/if}
              {#each localServers as server (server.baseUrl)}
                <div class="ai-local-server">
                  <span class="ai-ok">{server.name} <span class="ai-mono">{server.baseUrl}</span></span>
                  {#if server.models.length}
                    <div class="ai-form-row">
                      <span class="ai-form-label">Model</span>
                      <AiModelCombobox models={server.models} value={localChoice[server.baseUrl] ?? ''} ariaLabel={`${server.name} model`} onChange={value => (localChoice = { ...localChoice, [server.baseUrl]: value })} />
                      <button class="btn btn-primary btn-sm" type="button" onclick={() => useLocal(server.name, server.baseUrl, localChoice[server.baseUrl] ?? '')}>Use</button>
                    </div>
                  {:else}
                    <span class="ai-option-text">This server has no models yet. Pull one, then search again.</span>
                  {/if}
                </div>
              {/each}
              <div class="ai-form-row">
                <label class="ai-form-label" for="ai-local-url">Server URL</label>
                <input id="ai-local-url" class="field ai-form-input" type="url" spellcheck="false" autocomplete="off" placeholder="http://127.0.0.1:8080/v1" bind:value={localManualURL} />
                <button class="btn btn-secondary btn-sm" type="button" disabled={localBusy || !localManualURL.trim()} onclick={checkManualLocal}>Check</button>
              </div>
              {#if localManualModels.length}
                <div class="ai-form-row">
                  <span class="ai-form-label">Model</span>
                  <AiModelCombobox models={localManualModels} value={localManualModel} ariaLabel="Model" onChange={value => (localManualModel = value)} />
                  <button class="btn btn-primary btn-sm" type="button" onclick={() => useLocal('Local model', localManualURL, localManualModel)}>Use</button>
                </div>
              {/if}
              {#if localError}<span class="ai-error ai-form-note" role="alert">{localError}</span>{/if}
              <div class="ai-form-actions">
                <button class="btn btn-ghost btn-sm" type="button" onclick={() => (addMode = 'none')}>Close</button>
                <button class="btn btn-secondary btn-sm" type="button" disabled={localBusy} onclick={findLocal}>{localBusy ? 'Searching…' : 'Search again'}</button>
              </div>
            </div>
          {/if}
        </div>
      </div>
    {/if}
  </Disclosure>

  <AgentMcpSettings />
</div>

<style>
  .ai-mono { font-family: var(--font-mono); font-size: var(--text-caption); }
  .ai-error { color: var(--danger); font-size: var(--text-label); line-height: 1.45; overflow-wrap: anywhere; }
  .ai-add-label { margin-top: var(--space-3); }
  .ai-ok { color: var(--s2xx); font-size: var(--text-label); }
  .ai-waiting { display: inline-flex; align-items: center; gap: var(--space-1-5); font-size: var(--text-label); color: var(--text); }
  .ai-option-text { color: var(--text-2); font-size: var(--text-label); line-height: 1.5; }

  .ai-connection-name { display: inline-flex; align-items: center; gap: var(--space-1-5); }
  .ai-connection-meta { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .ai-connection-row .settings-row-text { flex-basis: 9rem; }
  .ai-connection-model { display: flex; width: 13rem; max-width: 100%; min-width: 0; }
  .ai-connection-model :global(.ai-combo) { flex: 1; min-width: 0; }
  .ai-connection-actions { display: flex; justify-content: flex-end; gap: var(--space-1); width: 10rem; }

  .ai-option-featured .settings-glyph { background: var(--accent-dim); color: var(--accent-text); }

  .ai-form {
    display: flex;
    flex-direction: column;
    gap: var(--space-2-5);
    margin-top: var(--space-1);
    padding: var(--space-3);
    border-radius: var(--radius-lg);
    background: var(--surface);
  }
  .ai-form-row { display: flex; align-items: center; gap: var(--space-2-5); }
  .ai-form-label { flex: 0 0 6rem; color: var(--text-2); font-size: var(--text-label); }
  .ai-form-input { flex: 1; min-width: 0; }
  .ai-form-row :global(.ai-form-select) { flex: 1; min-width: 0; }
  .ai-form-row :global(.ai-combo) { flex: 1; }
  .ai-form-note { padding-left: calc(6rem + var(--space-2-5)); }
  .ai-form-actions { display: flex; justify-content: flex-end; gap: var(--space-1-5); }
  .ai-local-server { display: flex; flex-direction: column; gap: var(--space-2); padding-bottom: var(--space-2-5); border-bottom: 1px solid var(--border-subtle); }
</style>
