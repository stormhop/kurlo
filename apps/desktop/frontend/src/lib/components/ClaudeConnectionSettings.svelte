<script lang="ts">
  import { onMount } from 'svelte';
  import AgentGlyph from './AgentGlyph.svelte';
  import Select from './Select.svelte';
  import { aiErrorView, aiConnectionProblem } from '../stores/features/ai';
  import { agentQuotaWindows } from '../agent';
  import { claudeConnectionStore as claude } from '../stores/claude.svelte';
  import { connectClaudeCode, openFileDialog, removeClaudeCodeConnection } from '../backend';

  let path = $state('');
  let model = $state('');
  let lastDetectedPath = $state('');
  let busy = $state(false);
  let error = $state('');
  const status = $derived(claude.status);
  const working = $derived(busy || claude.checking || claude.signingIn);
  const ready = $derived(status.authenticated && !status.error);
  const signedOut = $derived(status.connected && status.installed && !status.authenticated && !status.error);
  const label = $derived(claude.checking ? 'Checking…' : claude.signingIn ? 'Signing in…' : status.error && status.installed ? 'Unavailable' : status.connected && ready ? 'Connected' : signedOut ? 'Signed out' : status.authenticated ? 'Signed in' : status.installed ? 'CLI detected' : claude.loaded ? 'Not installed' : 'Not checked');
  const quotaWindows = $derived(agentQuotaWindows(status.rateLimits ?? []));
  const options = $derived(claude.models.map(item => ({ value: item.id, label: item.name || item.id })));

  $effect(() => {
    if (status.path && status.path !== lastDetectedPath) {
      path = status.path;
      lastDetectedPath = status.path;
    }
  });

  onMount(() => { if (!claude.loaded) void claude.refresh(); });

  async function act(action: () => Promise<void>) {
    if (working) return;
    busy = true;
    error = '';
    try { await action(); } catch (cause) { error = cause instanceof Error ? cause.message : String(cause); } finally { busy = false; }
  }

  async function chooseExecutable() {
    const selected = await openFileDialog('Choose Claude Code executable');
    if (!selected) return;
    path = selected;
    await claude.refresh(path);
  }

  async function save() {
    claude.apply(await connectClaudeCode({ path: path || status.path, model: model || status.model }));
  }

  async function disconnect() {
    const result = await removeClaudeCodeConnection();
    if (!result.ok) { error = result.error ?? 'Could not remove the connection.'; return; }
    claude.apply({ ...status, connected: false, rateLimits: [] });
    model = '';
    await claude.refresh(path || status.path);
  }
</script>

<section class="settings-group claude-connection" aria-label="Claude Code connection">
  <div class="settings-row">
    <span class="settings-glyph claude-glyph" aria-hidden="true"><AgentGlyph driver="claude-code" size="1.25rem" /></span>
    <div class="settings-row-text">
      <span class="settings-row-title claude-title">Claude Code <span class="settings-pill" class:ok={status.connected && ready} class:warn={(!status.installed && claude.loaded) || signedOut} role="status">{label}</span></span>
      {#if claude.signingIn}
        <span class="settings-row-desc">Complete sign-in with Claude in your browser.</span>
      {:else if claude.checking && !claude.loaded}
        <span class="settings-row-desc">Checking Claude Code…</span>
      {:else if status.installed}
        <span class="settings-row-desc">Claude Code CLI detected · {status.version}{#if status.authenticated}{' · '}Signed in: {status.account}{:else if signedOut}{' · '}Signed out. Sign in to use your Claude subscription again.{/if}</span>
      {:else if claude.loaded}
        <span class="settings-row-desc">Install Claude Code, then check again or choose its executable: <code>npm install -g @anthropic-ai/claude-code</code></span>
      {:else}
        <span class="settings-row-desc">Uses your Claude subscription, API key or cloud provider.</span>
      {/if}
    </div>
    <div class="settings-row-control">
      {#if claude.signingIn}
        <button class="btn btn-ghost btn-sm" type="button" onclick={() => void claude.cancelSignIn()}>Cancel sign-in</button>
      {:else}
        {#if status.installed}
          <button class="btn btn-secondary btn-sm" type="button" onclick={() => void act(async () => { await claude.refresh(path || status.path); })} disabled={working}>{working ? 'Connecting…' : 'Reconnect'}</button>
        {/if}
        {#if options.length && status.authenticated}
          <Select value={model || status.model} {options} ariaLabel="Claude Code model" disabled={working} onChange={value => { model = value; if (status.connected) void act(save); }} />
        {/if}
        {#if signedOut}
          <button class="btn btn-primary btn-sm" type="button" onclick={() => void claude.signIn(path || status.path)} disabled={working}>Sign in</button>
        {/if}
        {#if status.connected}
          <button class="btn btn-ghost btn-sm" type="button" onclick={() => void act(disconnect)} disabled={working}>Remove connection</button>
        {:else if status.authenticated}
          <button class="btn btn-primary btn-sm" type="button" onclick={() => void act(save)} disabled={working || !ready}>Use this account</button>
        {:else if status.installed}
          <button class="btn btn-primary btn-sm" type="button" onclick={() => void claude.signIn(path || status.path)} disabled={working}>Sign in</button>
        {/if}
      {/if}
    </div>
  </div>

  {#if !claude.signingIn && (error || claude.signInError || status.error)}
    {@const raw = error || claude.signInError || status.error || ''}
    {@const view = aiErrorView(raw)}
    <div class="settings-row claude-error" role="alert">
      <div class="settings-row-text">
        <strong>{view.title}</strong>
        <span>{view.message}</span>
        {#if view.hint}<span class="settings-row-desc">{view.hint}</span>{/if}
        {#if aiConnectionProblem(raw)}<details><summary>Technical details</summary><span>{raw}</span></details>{/if}
      </div>
    </div>
  {/if}

  {#if status.connected && ready && quotaWindows.length}
    <div class="settings-row claude-limits" aria-label="Claude plan limits">
      {#each quotaWindows as window, index (`${window.label}:${index}`)}
        <div class="claude-limit">
          <span class="claude-limit-head">
            <span>{window.duration === '5h' ? '5-hour window' : window.duration === '7d' ? 'Weekly' : window.label}</span>
            <span class="claude-limit-value">{window.remaining}% left{#if window.resetsAt > 0}{' · '}resets {new Date(window.resetsAt * 1000).toLocaleString('en-US', { weekday: 'short', hour: 'numeric', minute: '2-digit' })}{/if}</span>
          </span>
          <span class="claude-limit-bar" aria-hidden="true"><span class="claude-limit-fill" class:low={window.remaining < 30} style:width={`${window.remaining}%`}></span></span>
        </div>
      {/each}
    </div>
  {/if}

  <details class="claude-advanced" open={!status.connected}>
    <summary class="claude-advanced-summary">Executable <span class="claude-path-hint">{status.path || 'claude'}</span></summary>
    <div class="claude-advanced-body">
      <input class="field field-md claude-path" bind:value={path} placeholder={status.path || 'claude'} aria-label="Claude Code executable" disabled={working} />
      <button class="btn btn-secondary btn-sm" type="button" onclick={() => void claude.refresh(path)} disabled={working}>Check again</button>
      <button class="btn btn-ghost btn-sm" type="button" onclick={() => void act(chooseExecutable)} disabled={working}>Choose executable</button>
    </div>
  </details>
</section>

<style>
  .claude-connection { margin-top: var(--space-2); }
  .claude-glyph { background: var(--claude-tile); }
  .claude-title { display: inline-flex; align-items: center; gap: var(--space-2); }
  code { font-family: var(--font-mono); font-size: var(--text-caption); color: var(--text-2); user-select: text; -webkit-user-select: text; }
  .claude-error { color: var(--danger); font-size: var(--text-label); overflow-wrap: anywhere; }
  .claude-limits { display: grid; grid-template-columns: repeat(auto-fit, minmax(12rem, 1fr)); gap: var(--space-4); padding-left: calc(var(--space-3) + 2rem + var(--space-4)); }
  .claude-limit { display: flex; flex-direction: column; gap: var(--space-1-5); min-width: 0; }
  .claude-limit-head { display: flex; justify-content: space-between; gap: var(--space-2); color: var(--text-3); font-size: var(--text-label); }
  .claude-limit-value { color: var(--text); font-variant-numeric: tabular-nums; }
  .claude-limit-bar { display: block; height: 0.375rem; overflow: hidden; border-radius: var(--radius-full); background: var(--border-subtle); }
  .claude-limit-fill { display: block; height: 100%; background: var(--accent); }
  .claude-limit-fill.low { background: var(--s4xx); }
  .claude-advanced { border-top: 1px solid var(--border-subtle); }
  .claude-advanced-summary { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2-5) var(--space-3); color: var(--text-2); font-size: var(--text-label); cursor: pointer; list-style: none; }
  .claude-advanced-summary::-webkit-details-marker { display: none; }
  .claude-advanced-summary:focus-visible { outline: var(--focus-outline); outline-offset: -2px; border-radius: var(--radius-md); }
  .claude-path-hint { overflow: hidden; color: var(--text); font-family: var(--font-mono); font-size: var(--text-caption); text-overflow: ellipsis; white-space: nowrap; }
  .claude-advanced-body { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-1-5); padding: 0 var(--space-3) var(--space-3); }
  .claude-path { flex: 1 1 14rem; min-width: 0; font-family: var(--font-mono); font-size: var(--text-label); }
</style>
