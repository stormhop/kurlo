<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import BirdLoader from './BirdLoader.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import Select from './Select.svelte';
  import SecretBrowser from './SecretBrowser.svelte';
  import { trapFocus } from '../a11y';
  import { secretProviderTypeInfo } from '../secretProviderTypes';
  import { matchReferenceProvider, parseSecretReference } from '../secretReferenceParse';
  import { secretProviders } from '../stores/secretProviders.svelte';
  import { loadKeysForSource } from '../stores/secretImports.svelte';
  import { openAddSecretProvider, openSecretProviders } from '../secretProvidersNav';
  import type { SecretSource } from '../types/models';
  import type { SecretBrowseEntry, SecretImportKeysResult } from '../wire';

  let {
    workspaceId,
    anchor,
    existing = [],
    onImport,
    onClose,
  }: {
    workspaceId: string;
    anchor: DOMRect;
    existing?: SecretSource[];
    onImport: (source: SecretSource) => void;
    onClose: () => void;
  } = $props();

  const validProviders = $derived(secretProviders.providers.filter(provider => provider.valid));
  let providerId = $state('');
  let path = $state('');
  let version = $state('');
  let prefix = $state('');
  $effect(() => {
    if (!providerId && validProviders[0]) providerId = validProviders[0].id;
  });

  const provider = $derived(secretProviders.providers.find(item => item.id === providerId));
  const info = $derived(secretProviderTypeInfo(provider?.type ?? ''));
  const source = $derived<SecretSource>({ provider: providerId, path: path.trim(), ...(version.trim() ? { version: version.trim() } : {}), ...(prefix.trim() ? { prefix: prefix.trim() } : {}) });
  const duplicate = $derived(existing.some(item => item.provider === source.provider && item.path === source.path && (item.version ?? '') === (source.version ?? '')));
  const canLoad = $derived(Boolean(providerId && path.trim() && provider?.trusted && !duplicate));

  let loading = $state(false);
  let result = $state<SecretImportKeysResult | null>(null);
  const canBrowse = $derived(Boolean(info?.browse && provider?.trusted));
  let browsing = $state(false);
  $effect(() => {
    providerId;
    browsing = false;
  });

  let recognized = $state('');

  function onPathPaste(event: ClipboardEvent) {
    const text = event.clipboardData?.getData('text/plain') ?? '';
    const parsed = parseSecretReference(text);
    if (!parsed) return;
    event.preventDefault();
    const match = matchReferenceProvider(parsed, validProviders, providerId);
    if (!match) {
      path = text.trim();
      recognized = `This is a ${parsed.label}. Add a ${secretProviderTypeInfo(parsed.type)?.name ?? parsed.type} provider${parsed.host ? ` for ${parsed.host}` : parsed.region ? ` in ${parsed.region}` : ''} to use it.`;
      return;
    }
    providerId = match.id;
    path = parsed.path;
    
    version = parsed.version ?? '';
    recognized = `${parsed.label} · ${match.id}`;
  }

  function pick(entry: SecretBrowseEntry) {
    path = entry.path ?? path;
    browsing = false;
  }

  $effect(() => {
    source.provider; source.path; source.version;
    result = null;
  });

  async function loadKeys() {
    if (!canLoad) return;
    loading = true;
    result = await loadKeysForSource(workspaceId, source);
    loading = false;
  }

  let popover = $state<HTMLDivElement>();
  let height = $state(0);
  $effect(() => {
    if (!popover) return;
    const observer = new ResizeObserver(() => { height = popover?.offsetHeight ?? 0; });
    observer.observe(popover);
    return () => observer.disconnect();
  });

  const style = $derived.by(() => {
    const width = Math.min(416, window.innerWidth - 32);
    const left = Math.max(16, Math.min(anchor.right - width, window.innerWidth - width - 16));
    const below = anchor.bottom + 6;
    const fitsBelow = below + height <= window.innerHeight - 16;
    const top = fitsBelow ? below : Math.max(16, Math.min(anchor.top - 6 - height, window.innerHeight - 16 - height));
    return `left: ${left}px; top: ${top}px; max-height: calc(100vh - 32px); overflow-y: auto;`;
  });

  const yaml = $derived([
    'secretSources:',
    `  - provider: ${source.provider || '…'}`,
    `    path: ${source.path || '…'}`,
    ...(source.version ? [`    version: ${source.version}`] : []),
    ...(source.prefix ? [`    prefix: ${source.prefix}`] : []),
  ].join('\n'));

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  }

  function onPointerDown(event: PointerEvent) {
    const target = event.target;
    if (target instanceof Element && (target.closest('.secret-popover') || target.closest('.app-select-menu'))) return;
    onClose();
  }

  function inputValue(event: Event) {
    return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value : '';
  }
</script>

<svelte:document onpointerdowncapture={onPointerDown} />

<div class="secret-popover" bind:this={popover} role="dialog" aria-modal="false" aria-labelledby="secret-source-title" style={style} onkeydown={onKeydown} tabindex="-1" use:trapFocus>
  <div class="secret-popover-head">
    <h3 id="secret-source-title">Import from a secret</h3>
    <button class="btn btn-ghost btn-icon btn-sm" type="button" onclick={onClose} aria-label="Close"><AddCloseIcon /></button>
  </div>
  {#if !validProviders.length}
    <div class="secret-popover-body">
      <p class="secret-popover-note">This workspace has no secret providers yet. Add Vault, 1Password or a cloud secret manager first.</p>
    </div>
    <div class="secret-popover-foot">
      <span class="spacer"></span>
      <button class="btn btn-secondary btn-sm" type="button" onclick={onClose}>Cancel</button>
      <button class="btn btn-primary btn-sm" type="button" onclick={() => { onClose(); openAddSecretProvider(); }} data-autofocus=""><AddCloseIcon add /> Add provider</button>
    </div>
  {:else}
    <div class="secret-popover-body">
      <div class="secret-popover-field">
        <span>Provider</span>
        <Select value={providerId} options={validProviders.map(item => ({ value: item.id, label: `${item.name || item.id} · ${secretProviderTypeInfo(item.type)?.short ?? item.type}` }))} ariaLabel="Secret provider" onChange={value => (providerId = value)} />
        {#if provider && !provider.trusted}
          <small>Not trusted on this device yet. <button class="btn-link" type="button" onclick={() => { onClose(); openSecretProviders(provider.id); secretProviders.trustPromptId = provider.id; }}>Review</button></small>
        {/if}
      </div>
      <div class="secret-popover-field">
        <label for="secret-source-path">Secret</label>
        <div class="secret-path-row">
          <input id="secret-source-path" class="field field-mono" value={path} placeholder={info?.sourcePlaceholder ?? info?.pathPlaceholder ?? ''} oninput={(event) => { path = inputValue(event); recognized = ''; }} onpaste={onPathPaste} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" data-autofocus="" />
          {#if info?.browse}
            <button class="btn btn-secondary btn-sm" type="button" onclick={() => (browsing = !browsing)} disabled={!canBrowse} aria-expanded={browsing} aria-label="Browse the secrets of this provider"><MenuIcon name="folder" />Browse</button>
          {/if}
        </div>
        {#if browsing && provider}
          <SecretBrowser {workspaceId} providerId={provider.id} providerName={provider.name || provider.id} onPick={pick} />
        {/if}
        {#if recognized}<small class="secret-recognized" role="status">{recognized}</small>{:else}<small>{info?.sourceHint ?? 'A secret with several keys.'}</small>{/if}
      </div>
      <div class="secret-popover-pair">
        <label class="secret-popover-field">
          <span>Prefix</span>
          <input class="field field-mono" value={prefix} placeholder="None" oninput={(event) => (prefix = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" />
        </label>
        <label class="secret-popover-field">
          <span>{info?.versionLabel ?? 'Version'}</span>
          <input class="field field-mono" value={version} placeholder={info?.versionPlaceholder ?? 'Latest'} disabled={!info?.versionHint} oninput={(event) => (version = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" />
        </label>
      </div>
      {#if duplicate}
        <div class="secret-popover-result error" role="status"><MenuIcon name="warning" /><span>This environment already imports this secret.</span></div>
      {:else if result}
        <div class="secret-popover-result" class:ok={result.ok} class:error={!result.ok} role="status">
          <MenuIcon name={result.ok ? 'shield' : 'warning'} />
          <span>
            {#if result.ok}
              {`${result.keys.length} ${result.keys.length === 1 ? 'key' : 'keys'}: ${result.keys.map(key => `${source.prefix ?? ''}${key}`).join(', ')}`}
            {:else}
              {result.message}
            {/if}
          </span>
        </div>
      {/if}
      <pre class="secret-popover-yaml" aria-label="Saved in the environment file">{yaml}</pre>
      <p class="secret-popover-note">Only the reference is saved, and the environment is saved right away.</p>
    </div>
    <div class="secret-popover-foot">
      <span class="spacer"></span>
      <button class="btn btn-secondary btn-sm" type="button" onclick={loadKeys} disabled={!canLoad || loading}>{#if loading}<BirdLoader label="Loading keys" size="1rem" />{:else}<MenuIcon name="refresh" />{/if}Load keys</button>
      <button class="btn btn-secondary btn-sm" type="button" onclick={onClose}>Cancel</button>
      <button class="btn btn-primary btn-sm" type="button" onclick={() => onImport(source)} disabled={!providerId || !path.trim() || duplicate || (result !== null && !result.ok)}><MenuIcon name="import" />Import</button>
    </div>
  {/if}
</div>
