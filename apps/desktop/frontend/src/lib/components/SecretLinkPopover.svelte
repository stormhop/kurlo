<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import Select from './Select.svelte';
  import SecretBrowser from './SecretBrowser.svelte';
  import { trapFocus } from '../a11y';
  import { revealSecretRef, testSecretRef } from '../secretProvidersBackend';
  import { secretProviderTypeInfo } from '../secretProviderTypes';
  import { matchReferenceProvider, parseSecretReference } from '../secretReferenceParse';
  import { secretProviders } from '../stores/secretProviders.svelte';
  import { openAddSecretProvider, openSecretProviders } from '../secretProvidersNav';
  import type { SecretRef } from '../types/models';
  import type { SecretBrowseEntry, SecretRefTestResult } from '../wire';

  let {
    variableKey,
    current,
    workspaceId,
    anchor,
    onLink,
    onUnlink,
    onClose,
  }: {
    variableKey: string;
    current?: SecretRef;
    workspaceId: string;
    anchor: DOMRect;
    onLink: (ref: SecretRef) => void;
    onUnlink: () => void;
    onClose: () => void;
  } = $props();

  const validProviders = $derived(secretProviders.providers.filter(provider => provider.valid));
  let providerId = $state('');
  let path = $state('');
  let field = $state('');
  let version = $state('');
  let initialized = false;
  $effect(() => {
    if (initialized) return;
    initialized = true;
    providerId = current?.provider ?? validProviders[0]?.id ?? '';
    path = current?.path ?? '';
    field = current?.field ?? '';
    version = current?.version ?? '';
  });
  $effect(() => {
    if (!providerId && validProviders[0]) providerId = validProviders[0].id;
  });

  const provider = $derived(secretProviders.providers.find(item => item.id === providerId));
  const info = $derived(secretProviderTypeInfo(provider?.type ?? ''));
  const ref = $derived<SecretRef>({ provider: providerId, path: path.trim(), ...(field.trim() ? { field: field.trim() } : {}), ...(version.trim() ? { version: version.trim() } : {}) });
  const canLink = $derived(Boolean(providerId && path.trim()));
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
    if (parsed.field) field = parsed.field;
    version = parsed.version ?? '';
    recognized = `${parsed.label} · ${match.id}`;
  }

  function pick(entry: SecretBrowseEntry) {
    path = entry.path ?? path;
    field = entry.field ?? '';
    browsing = false;
  }

  let testing = $state(false);
  let result = $state<SecretRefTestResult | null>(null);
  let revealed = $state('');
  let revealError = $state('');
  let revealTimer: ReturnType<typeof setTimeout> | undefined;

  $effect(() => {
    ref.provider; ref.path; ref.field; ref.version;
    result = null;
    hideValue();
  });

  function hideValue() {
    revealed = '';
    revealError = '';
    if (revealTimer) clearTimeout(revealTimer);
  }

  async function test() {
    if (!canLink) return;
    testing = true;
    result = await testSecretRef(workspaceId, ref);
    testing = false;
  }

  async function reveal() {
    hideValue();
    const outcome = await revealSecretRef(workspaceId, ref);
    if (outcome.message) {
      revealError = outcome.message;
      return;
    }
    revealed = outcome.value;
    revealTimer = setTimeout(hideValue, 30_000);
  }

  const yaml = $derived([
    `- key: ${variableKey || 'variable'}`,
    '  secret: true',
    '  secretRef:',
    `    provider: ${ref.provider || '…'}`,
    `    path: ${ref.path || '…'}`,
    ...(ref.field ? [`    field: ${ref.field}`] : []),
    ...(ref.version ? [`    version: ${ref.version}`] : []),
  ].join('\n'));

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

<div class="secret-popover" bind:this={popover} role="dialog" aria-modal="false" aria-labelledby="secret-link-title" style={style} onkeydown={onKeydown} tabindex="-1" use:trapFocus>
  <div class="secret-popover-head">
    <h3 id="secret-link-title">Link {variableKey || 'variable'}</h3>
    <button class="btn btn-ghost btn-icon btn-sm" type="button" onclick={onClose} aria-label="Close"><AddCloseIcon /></button>
  </div>
  {#if !validProviders.length}
    <div class="secret-popover-body">
      <p class="secret-popover-note">This workspace has no secret providers yet. Add Vault, 1Password, a cloud secret manager or environment variables first.</p>
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
        <label for="secret-link-path">Path</label>
        <div class="secret-path-row">
          <input id="secret-link-path" class="field field-mono" value={path} placeholder={info?.pathPlaceholder ?? ''} oninput={(event) => { path = inputValue(event); recognized = ''; }} onpaste={onPathPaste} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" data-autofocus="" />
          {#if info?.browse}
            <button class="btn btn-secondary btn-sm" type="button" onclick={() => (browsing = !browsing)} disabled={!canBrowse} aria-expanded={browsing} aria-label="Browse the secrets of this provider"><MenuIcon name="folder" />Browse</button>
          {/if}
        </div>
        {#if browsing && provider}
          <SecretBrowser {workspaceId} providerId={provider.id} providerName={provider.name || provider.id} onPick={pick} />
        {/if}
        {#if recognized}<small class="secret-recognized" role="status">{recognized}</small>{:else if info?.pathHint}<small>{info.pathHint}</small>{/if}
      </div>
      <div class="secret-popover-pair">
        <label class="secret-popover-field">
          <span>Field</span>
          <input class="field field-mono" list="secret-link-fields" value={field} placeholder={info?.fieldHint ?? 'Field'} oninput={(event) => (field = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" />
          <datalist id="secret-link-fields">
            {#each result?.fields ?? [] as name (name)}<option value={name}></option>{/each}
          </datalist>
        </label>
        <label class="secret-popover-field">
          <span>Version</span>
          <input class="field field-mono" value={version} placeholder="Latest" disabled={!info?.versionHint} oninput={(event) => (version = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" />
        </label>
      </div>
      {#if result}
        <div class="secret-popover-result" class:ok={result.ok} class:error={!result.ok} role="status">
          <MenuIcon name={result.ok ? 'shield' : 'warning'} />
          <span>
            {#if result.ok}
              {`Fetched just now · ${result.length} ${result.length === 1 ? 'character' : 'characters'}${result.fields.length ? ` · fields: ${result.fields.join(', ')}` : ''}`}
            {:else}
              {`${result.message}${result.fields.length ? ` Fields: ${result.fields.join(', ')}` : ''}`}
            {/if}
          </span>
          {#if result.ok}
            {#if revealed}
              <button class="btn btn-ghost btn-sm" type="button" onclick={hideValue}><MenuIcon name="eye" />Hide</button>
            {:else}
              <button class="btn btn-ghost btn-sm" type="button" onclick={reveal}><MenuIcon name="eye" />Reveal</button>
            {/if}
          {/if}
        </div>
        {#if revealed}
          <div class="secret-popover-result"><span class="secret-popover-reveal">{revealed}</span><small>hides in 30 s</small></div>
        {:else if revealError}
          <div class="secret-popover-result error"><span>{revealError}</span></div>
        {/if}
      {/if}
      <pre class="secret-popover-yaml" aria-label="Saved in the environment file">{yaml}</pre>
      <p class="secret-popover-note">Only the reference is saved. A value typed on this device is removed when you link, and the environment is saved right away.</p>
    </div>
    <div class="secret-popover-foot">
      {#if current}
        <button class="btn btn-ghost btn-sm secret-danger" type="button" onclick={onUnlink}><MenuIcon name="unlink" />Unlink</button>
      {/if}
      <span class="spacer"></span>
      <button class="btn btn-secondary btn-sm" type="button" onclick={test} disabled={!canLink || testing || !provider?.trusted}><MenuIcon name="refresh" />{testing ? 'Testing…' : 'Test'}</button>
      <button class="btn btn-secondary btn-sm" type="button" onclick={onClose}>Cancel</button>
      <button class="btn btn-primary btn-sm" type="button" onclick={() => onLink(ref)} disabled={!canLink}><MenuIcon name="link" />{current ? 'Update' : 'Link'}</button>
    </div>
  {/if}
</div>
