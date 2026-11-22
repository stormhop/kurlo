<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import BirdLoader from './BirdLoader.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import ProviderLogo from './ProviderLogo.svelte';
  import SecretRefChip from './SecretRefChip.svelte';
  import SecretSourcePopover from './SecretSourcePopover.svelte';
  import { effectiveEnvironmentRows } from '../environmentInheritance';
  import { relativeTime } from '../collectionRuns';
  import { sameSecretSource, secretSourceId, secretSourceMapping, toggleSecretSourceKey } from '../linkedSecrets';
  import { secretProviderState } from '../secretProviderTypes';
  import { openSecretProviders } from '../secretProvidersNav';
  import { loadSecretProviders, secretProviders } from '../stores/secretProviders.svelte';
  import { loadKeysForSource, secretImportKeyset, secretSourceLoading } from '../stores/secretImports.svelte';
  import type { Environment, SecretSource } from '../types/models';

  let {
    environment,
    environments,
    onChange,
  }: {
    environment: Environment;
    environments: Environment[];
    onChange: (sources: SecretSource[]) => void | Promise<unknown>;
  } = $props();

  const sources = $derived(environment.secretSources ?? []);
  const effective = $derived(effectiveEnvironmentRows(environments, environment.id));
  const visible = $derived(sources.length > 0 || secretProviders.providers.some(provider => provider.valid));
  let addAnchor = $state<DOMRect | null>(null);
  let menuFor = $state('');
  let errors = $state<Record<string, string>>({});
  let now = $state(Date.now());

  $effect(() => {
    const workspaceId = environment.workspaceId;
    if (workspaceId && (secretProviders.workspaceId !== workspaceId || !secretProviders.loaded)) void loadSecretProviders(workspaceId);
  });

  $effect(() => {
    const timer = setInterval(() => { now = Date.now(); }, 30_000);
    return () => clearInterval(timer);
  });

  function providerFor(source: SecretSource) {
    return secretProviders.providers.find(provider => provider.id === source.provider);
  }

  function tone(source: SecretSource): 'ok' | 'error' | 'untrusted' | 'loading' {
    const provider = providerFor(source);
    if (!provider) return secretProviders.loaded ? 'error' : 'loading';
    const state = secretProviderState(provider, secretProviders.statuses[provider.id]);
    if (state === 'untrusted') return 'untrusted';
    if (state === 'signin' || state === 'nocli' || state === 'error' || state === 'invalid') return 'error';
    return 'ok';
  }

  async function save(next: SecretSource[]) {
    await onChange(next);
    void loadSecretProviders(environment.workspaceId);
  }

  async function loadKeys(source: SecretSource) {
    const id = secretSourceId(source);
    const result = await loadKeysForSource(environment.workspaceId, source);
    errors = result.ok ? Object.fromEntries(Object.entries(errors).filter(([key]) => key !== id)) : { ...errors, [id]: result.message ?? 'Kurlo could not load the keys.' };
  }

  async function importSource(source: SecretSource) {
    addAnchor = null;
    await save([...sources, source]);
    if (providerFor(source)?.trusted && !secretImportKeyset(environment.workspaceId, source)) await loadKeys(source);
  }

  function replace(source: SecretSource, next: SecretSource) {
    void save(sources.map(item => sameSecretSource(item, source) ? next : item));
  }

  function remove(source: SecretSource) {
    menuFor = '';
    void save(sources.filter(item => !sameSecretSource(item, source)));
  }

  function setPrefix(source: SecretSource, event: Event) {
    const value = event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value.trim() : '';
    if (value === (source.prefix ?? '')) return;
    const { prefix: _prefix, ...rest } = source;
    replace(source, value ? { ...rest, prefix: value } : rest);
  }

  function prefixKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && event.currentTarget instanceof HTMLInputElement) event.currentTarget.blur();
  }

  function openAdd(event: MouseEvent) {
    if (event.currentTarget instanceof HTMLElement) addAnchor = event.currentTarget.getBoundingClientRect();
  }

  function closeMenu(event: FocusEvent) {
    const current = event.currentTarget;
    const next = event.relatedTarget;
    if (current instanceof HTMLElement && (!(next instanceof Node) || !current.contains(next))) menuFor = '';
  }

  function inputChecked(event: Event) {
    return event.currentTarget instanceof HTMLInputElement && event.currentTarget.checked;
  }
</script>

{#if visible}
  <section class="secret-sources" aria-labelledby="secret-sources-title">
    <div class="secret-sources-head">
      <div>
        <h2 id="secret-sources-title">Imported from secret managers</h2>
        <p>Every key of a secret becomes a variable. A variable row with the same name wins.</p>
      </div>
      <button class="btn btn-secondary btn-sm" type="button" onclick={openAdd} aria-haspopup="dialog" aria-expanded={Boolean(addAnchor)}><AddCloseIcon add /> Add source</button>
    </div>
    {#each sources as source (secretSourceId(source))}
      {@const id = secretSourceId(source)}
      {@const provider = providerFor(source)}
      {@const keyset = secretImportKeyset(environment.workspaceId, source)}
      {@const mapping = secretSourceMapping(source, keyset?.keys, effective, environment.id)}
      {@const imported = mapping.filter(item => item.state === 'imported').length}
      {@const loading = secretSourceLoading(environment.workspaceId, source)}
      <div class="secret-source-card" data-testid="secret-source">
        <div class="secret-source-head">
          <ProviderLogo type={provider?.type ?? ''} size="lg" />
          <div class="secret-source-title">
            <SecretRefChip secretRef={{ provider: source.provider, path: source.path, ...(source.version ? { version: source.version } : {}) }} tone={tone(source)} />
            <small class:secret-source-error={Boolean(errors[id])}>
              {#if errors[id]}
                {errors[id]}
              {:else if !provider && secretProviders.loaded}
                {`No provider ${source.provider} in this workspace.`}
              {:else if provider && !provider.trusted}
                Not trusted on this device yet. Review the provider to load its keys.
              {:else if keyset}
                {`${keyset.keys.length} ${keyset.keys.length === 1 ? 'key' : 'keys'} · ${imported} imported · keys loaded ${relativeTime(keyset.loadedAt, now)}`}
              {:else if source.keys}
                {`${source.keys.length} ${source.keys.length === 1 ? 'key' : 'keys'} listed in the file · ${imported} imported`}
              {:else}
                Keys are not loaded on this device yet. Load them to use the variables.
              {/if}
            </small>
          </div>
          <label class="secret-source-prefix">
            <span>Prefix</span>
            <input class="field field-mono secret-input-sm" value={source.prefix ?? ''} placeholder="none" aria-label={`Prefix for ${source.path}`} onchange={(event) => setPrefix(source, event)} onkeydown={prefixKeydown} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" />
          </label>
          {#if provider && !provider.trusted}
            <button class="btn btn-secondary btn-sm" type="button" onclick={() => { openSecretProviders(provider.id); secretProviders.trustPromptId = provider.id; }}><MenuIcon name="lock" />Review</button>
          {:else}
            <button class="btn btn-ghost btn-sm" type="button" onclick={() => loadKeys(source)} disabled={loading || !provider}>{#if loading}<BirdLoader label="Loading keys" size="1rem" />{:else}<MenuIcon name="refresh" />{/if}Load keys</button>
          {/if}
          <div class="env-more" onfocusout={closeMenu}>
            <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label={`Actions for ${source.path}`} aria-haspopup="menu" aria-expanded={menuFor === id} onclick={() => (menuFor = menuFor === id ? '' : id)}>•••</button>
            {#if menuFor === id}
              <div class="menu request-menu env-more-menu" role="menu">
                {#if provider}
                  <button class="menu-item" type="button" role="menuitem" onclick={() => { menuFor = ''; openSecretProviders(provider.id); }}><MenuIcon name="open" />Open provider</button>
                {/if}
                {#if source.keys}
                  <button class="menu-item" type="button" role="menuitem" onclick={() => { menuFor = ''; const { keys: _keys, ...rest } = source; replace(source, rest); }}><MenuIcon name="import" />Import every key</button>
                {/if}
                <div class="menu-separator" role="separator"></div>
                <button class="menu-item danger" type="button" role="menuitem" onclick={() => remove(source)}><MenuIcon name="trash" />Remove source</button>
              </div>
            {/if}
          </div>
        </div>
        {#if mapping.length}
          <div class="secret-source-keys">
            {#each mapping as item (item.key)}
              <div class="secret-source-key" class:skipped={!item.included}>
                <input type="checkbox" class="check" checked={item.included} aria-label={`Import ${item.key}`} onchange={(event) => replace(source, toggleSecretSourceKey(source, item.key, inputChecked(event), keyset?.keys))} />
                <span class="secret-source-field">{item.key}</span>
                <span class="secret-source-arrow" aria-hidden="true">→</span>
                <span class="secret-source-variable">{item.variable}</span>
                <span class="secret-source-note secret-source-note-{item.state}">
                  {#if item.state === 'row' || item.state === 'replaced' || item.state === 'missing'}<MenuIcon name="warning" />{/if}
                  {item.detail}
                </span>
              </div>
            {/each}
          </div>
        {/if}
      </div>
    {/each}
    {#if addAnchor}
      <SecretSourcePopover workspaceId={environment.workspaceId} anchor={addAnchor} existing={sources} onImport={importSource} onClose={() => (addAnchor = null)} />
    {/if}
  </section>
{/if}
