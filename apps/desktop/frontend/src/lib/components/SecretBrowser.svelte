<script lang="ts">
  import BirdLoader from './BirdLoader.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import { browseSecretProvider } from '../secretProvidersBackend';
  import type { SecretBrowseEntry, SecretBrowseResult } from '../wire';

  let {
    workspaceId,
    providerId,
    providerName,
    onPick,
  }: {
    workspaceId: string;
    providerId: string;
    providerName: string;
    onPick: (entry: SecretBrowseEntry) => void;
  } = $props();

  type Crumb = { label: string; prefix: string };

  let trail = $state<Crumb[]>([]);
  let result = $state<SecretBrowseResult | null>(null);
  let loading = $state(false);
  let filter = $state('');
  let cache: Record<string, SecretBrowseResult> = {};
  let token = 0;

  const prefix = $derived(trail.at(-1)?.prefix ?? '');

  $effect(() => {
    providerId;
    cache = {};
    trail = [{ label: providerName || providerId, prefix: '' }];
  });

  $effect(() => {
    const current = prefix;
    if (!trail.length) return;
    void load(current);
  });

  async function load(target: string, force = false) {
    filter = '';
    const cached = cache[target];
    const request = ++token;
    if (cached && !force) {
      result = cached;
      loading = false;
      return;
    }
    loading = true;
    const outcome = await browseSecretProvider(workspaceId, providerId, target);
    if (request !== token) return;
    if (outcome.ok) cache[target] = outcome;
    result = outcome;
    loading = false;
  }

  function open(entry: SecretBrowseEntry) {
    if (!entry.browse) return;
    trail = [...trail, { label: entry.name.replace(/\/$/, ''), prefix: entry.browse }];
  }

  function back(index: number) {
    trail = trail.slice(0, index + 1);
  }

  const visible = $derived.by(() => {
    const entries = result?.entries ?? [];
    const needle = filter.trim().toLowerCase();
    return needle ? entries.filter(entry => `${entry.name} ${entry.detail ?? ''}`.toLowerCase().includes(needle)) : entries;
  });

  function choose(entry: SecretBrowseEntry) {
    if (entry.path) onPick(entry);
    else open(entry);
  }

  function inputValue(event: Event) {
    return event.currentTarget instanceof HTMLInputElement ? event.currentTarget.value : '';
  }
</script>

<div class="secret-browser" role="group" aria-label="Browse secrets">
  <div class="secret-browser-head">
    <nav class="secret-browser-trail" aria-label="Location">
      {#each trail as crumb, index (crumb.prefix)}
        {#if index > 0}<span class="secret-browser-sep" aria-hidden="true">/</span>{/if}
        {#if index === trail.length - 1}
          <span class="secret-browser-crumb current" aria-current="location">{crumb.label}</span>
        {:else}
          <button class="secret-browser-crumb" type="button" onclick={() => back(index)}>{crumb.label}</button>
        {/if}
      {/each}
    </nav>
    <button class="btn btn-ghost btn-icon btn-sm" type="button" onclick={() => load(prefix, true)} disabled={loading} aria-label="Reload list"><MenuIcon name="refresh" /></button>
  </div>
  {#if (result?.entries.length ?? 0) > 8}
    <input class="field secret-browser-filter" value={filter} placeholder="Filter" aria-label="Filter secrets" oninput={(event) => (filter = inputValue(event))} autocomplete="off" spellcheck="false" autocorrect="off" autocapitalize="none" />
  {/if}
  <div class="secret-browser-list">
    {#if loading}
      <div class="secret-browser-empty"><BirdLoader label="Loading" size="1rem" /></div>
    {:else if result && !result.ok}
      <div class="secret-browser-empty error" role="status"><MenuIcon name="warning" /><span>{result.message}</span></div>
    {:else if !visible.length}
      <div class="secret-browser-empty">{filter ? 'Nothing matches the filter.' : 'Nothing here, or no access to list it.'}</div>
    {:else}
      {#each visible as entry (`${entry.path ?? ''}#${entry.field ?? ''}#${entry.browse ?? ''}#${entry.name}`)}
        <div class="secret-browser-row">
          <button class="secret-browser-item" type="button" onclick={() => choose(entry)}>
            <MenuIcon name={entry.path ? 'key' : 'folder'} />
            <span class="secret-browser-name">{entry.name}</span>
            {#if entry.detail}<span class="secret-browser-detail">{entry.detail}</span>{/if}
          </button>
          {#if entry.path && entry.browse}
            <button class="btn btn-ghost btn-sm secret-browser-open" type="button" onclick={() => open(entry)} aria-label={`Open ${entry.name}`}>Open</button>
          {/if}
        </div>
      {/each}
    {/if}
  </div>
</div>
