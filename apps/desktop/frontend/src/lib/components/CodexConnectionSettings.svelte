<script lang="ts">
  import BirdSpinner from './BirdSpinner.svelte';
  import AgentGlyph from './AgentGlyph.svelte';
  import { onMount } from 'svelte';
  import { aiErrorView, aiConnectionProblem } from '../stores/features/ai';
  import Select from './Select.svelte';
  import { openExternalURL } from '../externalLinks';
  import { codexConnectionStore } from '../stores/codex.svelte';
  import { agentQuotaWindows } from '../agent';
  import { cancelCodexLogin, connectCodex, openFileDialog, removeCodexConnection, startCodexLogin } from '../backend';

  let path = $state('');
  let model = $state('');
  let lastDetectedPath = $state('');
  let busy = $state(false);
  let error = $state('');
  const status = $derived(codexConnectionStore.status);
  const working = $derived(busy || codexConnectionStore.checking);
  const ready = $derived(status.authenticated && status.models.length > 0 && !status.error);
  const connectionLabel = $derived(status.waiting ? 'Signing in…' : status.error && status.installed ? 'Unavailable' : status.connected && ready ? 'Connected' : status.authenticated ? 'Signed in' : status.installed ? 'CLI detected' : codexConnectionStore.loaded ? 'Not installed' : 'Not checked');
  const quotaWindows = $derived(agentQuotaWindows(status.rateLimits ?? []));
  const options = $derived(status.models.map(item => ({ value: item.id, label: item.name || item.id })));

  $effect(() => {
    if (status.path && status.path !== lastDetectedPath) {
      path = status.path;
      lastDetectedPath = status.path;
    }
  });

  onMount(() => { if (!codexConnectionStore.loaded) void codexConnectionStore.refresh(); });

  async function act(action: () => Promise<void>) {
    if (working) return;
    busy = true;
    error = '';
    try { await action(); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); } finally { busy = false; }
  }

  async function chooseExecutable() {
    const selected = await openFileDialog('Choose Codex executable');
    if (!selected) return;
    path = selected;
    await codexConnectionStore.refresh(path);
  }

  async function signIn() {
    const result = await startCodexLogin(path || status.path);
    codexConnectionStore.apply(result);
    if (result.authUrl) await openExternalURL(result.authUrl);
  }

  async function save() {
    codexConnectionStore.apply(await connectCodex({ path: path || status.path, model: model || status.model }));
  }

  async function disconnect() {
    const result = await removeCodexConnection();
    if (!result.ok) { error = result.error ?? 'Could not remove the connection.'; return; }
    codexConnectionStore.apply({ ...status, connected: false, rateLimits: [] });
    model = '';
    await codexConnectionStore.refresh(path || status.path);
  }

  $effect(() => {
    if (!status.waiting) return;
    const timer = setInterval(() => void codexConnectionStore.refresh(path || status.path), 2500);
    return () => clearInterval(timer);
  });
</script>

<section class="settings-group codex-connection" aria-label="Codex connection">
  <div class="settings-row">
    <span class="settings-glyph codex-glyph" aria-hidden="true"><AgentGlyph driver="codex" size="1.25rem" /></span>
    <div class="settings-row-text">
      <span class="settings-row-title codex-title">Codex <span class="settings-pill" class:ok={status.connected && ready} class:warn={!status.installed && codexConnectionStore.loaded}>{#if codexConnectionStore.checking}<BirdSpinner size="0.875rem" />{:else}{connectionLabel}{/if}</span></span>
      {#if codexConnectionStore.checking}
        <span class="settings-row-desc"><BirdSpinner label="Checking Codex" /></span>
      {:else if status.installed}
        <span class="settings-row-desc">Codex CLI detected · {status.version}{#if status.authenticated}{' · '}Signed in: {status.account || status.authType}{/if}</span>
      {:else if codexConnectionStore.loaded}
        <span class="settings-row-desc">Install Codex CLI, then check again or choose its executable: <code>npm install -g @openai/codex</code></span>
      {:else}
        <span class="settings-row-desc">Uses your ChatGPT plan or API billing.</span>
      {/if}
    </div>
    <div class="settings-row-control">
      {#if status.installed && !status.waiting}
        <button class="btn btn-secondary btn-sm" type="button" onclick={() => void act(async () => { await codexConnectionStore.refresh(path || status.path); })} disabled={working}>{working ? 'Connecting…' : 'Reconnect'}</button>
      {/if}
      {#if options.length && !status.waiting}
        <Select value={model || status.model} {options} ariaLabel="Codex model" disabled={working} onChange={value => { model = value; if (status.connected) void act(save); }} />
      {/if}
      {#if status.waiting}
        <button class="btn btn-secondary btn-sm" type="button" onclick={() => void act(async () => { await openExternalURL(status.authUrl); })} disabled={working}>Reopen browser</button>
        <button class="btn btn-ghost btn-sm" type="button" onclick={() => void act(async () => { await cancelCodexLogin(); codexConnectionStore.apply({ ...status, waiting: false, authUrl: '' }); })} disabled={working}>Cancel sign-in</button>
      {:else if status.connected}
        <button class="btn btn-ghost btn-sm" type="button" onclick={() => void act(disconnect)} disabled={working}>Remove connection</button>
      {:else if status.authenticated}
        <button class="btn btn-primary btn-sm" type="button" onclick={() => void act(save)} disabled={working || !ready}>Use this account</button>
      {:else if status.installed}
        <button class="btn btn-primary btn-sm" type="button" onclick={() => void act(signIn)} disabled={working}>Sign in</button>
      {/if}
    </div>
  </div>

  {#if status.waiting}
    <div class="settings-row codex-note" role="status">Complete sign-in in your browser.</div>
  {/if}
  {#if error || status.error}
    {@const raw = error || status.error || ''}
    {@const view = aiErrorView(raw)}
    <div class="settings-row codex-error" role="alert">
      <div class="settings-row-text">
        <strong>{view.title}</strong>
        <span>{view.message}</span>
        {#if view.hint}<span class="settings-row-desc">{view.hint}</span>{/if}
        {#if aiConnectionProblem(raw)}<details><summary>Technical details</summary><span>{raw}</span></details>{/if}
      </div>
      {#if aiConnectionProblem(raw) === 'auth'}<button class="btn btn-secondary btn-sm" type="button" onclick={() => void act(signIn)} disabled={working}>Sign in again</button>{/if}
    </div>
  {/if}

  {#if status.connected && quotaWindows.length}
    <div class="settings-row codex-limits" aria-label="Codex plan limits">
      {#each quotaWindows as window, index (`${window.label}:${index}`)}
        <div class="codex-limit">
          <span class="codex-limit-head">
            <span>{window.duration === '5h' ? '5-hour window' : window.duration === '7d' ? 'Weekly' : window.label}</span>
            <span class="codex-limit-value">{window.remaining}% left{#if window.resetsAt > 0}{' · '}resets {new Date(window.resetsAt * 1000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}{/if}</span>
          </span>
          <span class="codex-limit-bar" aria-hidden="true"><span class="codex-limit-fill" class:low={window.remaining < 30} style:width={`${window.remaining}%`}></span></span>
        </div>
      {/each}
    </div>
  {/if}

  <details class="codex-advanced" open={!status.connected}>
    <summary class="codex-advanced-summary">Executable <span class="codex-path-hint">{status.path || 'codex'}</span></summary>
    <div class="codex-advanced-body">
      <input class="field field-md codex-path" bind:value={path} placeholder={status.path || 'codex'} aria-label="Codex executable" disabled={working || status.waiting} autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} />
      <button class="btn btn-secondary btn-sm" type="button" onclick={() => void codexConnectionStore.refresh(path)} disabled={working}>Check again</button>
      <button class="btn btn-ghost btn-sm" type="button" onclick={() => void act(chooseExecutable)} disabled={working}>Choose executable</button>
    </div>
  </details>
</section>

<style>
  .codex-glyph { background: var(--text); color: var(--bg); }
  .codex-title { display: inline-flex; align-items: center; gap: var(--space-2); }
  code { font-family: var(--font-mono); font-size: var(--text-caption); color: var(--text-2); user-select: text; -webkit-user-select: text; }
  .codex-note { color: var(--text-2); font-size: var(--text-label); }
  .codex-error { color: var(--danger); font-size: var(--text-label); overflow-wrap: anywhere; }
  .codex-limits { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: var(--space-4); padding-left: calc(var(--space-3) + 2rem + var(--space-4)); }
  .codex-limit { display: flex; flex-direction: column; gap: var(--space-1-5); min-width: 0; }
  .codex-limit-head { display: flex; justify-content: space-between; gap: var(--space-2); color: var(--text-3); font-size: var(--text-label); }
  .codex-limit-value { color: var(--text); font-variant-numeric: tabular-nums; }
  .codex-limit-bar { display: block; height: 0.375rem; overflow: hidden; border-radius: var(--radius-full); background: var(--border-subtle); }
  .codex-limit-fill { display: block; height: 100%; background: var(--accent); }
  .codex-limit-fill.low { background: var(--s4xx); }
  .codex-advanced { border-top: 1px solid var(--border-subtle); }
  .codex-advanced-summary { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2-5) var(--space-3); color: var(--text-2); font-size: var(--text-label); cursor: pointer; list-style: none; }
  .codex-advanced-summary::-webkit-details-marker { display: none; }
  .codex-advanced-summary:focus-visible { outline: var(--focus-outline); outline-offset: -2px; border-radius: var(--radius-md); }
  .codex-path-hint { overflow: hidden; color: var(--text); font-family: var(--font-mono); font-size: var(--text-caption); text-overflow: ellipsis; white-space: nowrap; }
  .codex-advanced-body { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1-5); padding: 0 var(--space-3) var(--space-3); }
  .codex-path { flex: 1 1 14rem; min-width: 0; font-family: var(--font-mono); font-size: var(--text-label); }
</style>
