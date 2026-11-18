<script lang="ts">
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { trapFocus } from '../a11y';
  import type { Collection, SavedRequest } from '../types/models';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import RequestTypeBadge from './RequestTypeBadge.svelte';
  import Select from './Select.svelte';

  let { collection, requests, onGenerate, onClose }: {
    collection: Collection;
    requests: SavedRequest[];
    onGenerate: (ids?: string[], linkBaseUrl?: string) => void;
    onClose: () => void;
  } = $props();

  let selection = $state(false);
  let query = $state('');
  let folder = $state('');
  let selected = $state<string[]>([]);
  let linkBaseUrl = $state('');
  const validLinkBase = $derived.by(() => {
    const value = linkBaseUrl.trim();
    if (!value) return true;
    if (!/^https?:\/\//i.test(value)) return false;
    try {
      const url = new URL(value);
      return ['http:', 'https:'].includes(url.protocol) && Boolean(url.hostname) && !url.username && !url.password;
    } catch {
      return false;
    }
  });

  const folders = $derived.by(() => {
    const paths = new SvelteMap<string, string>();
    for (const path of [...(collection.folderPaths ?? []), ...requests.map(req => req.folderPath ?? [])]) {
      for (let depth = 1; depth <= path.length; depth++) {
        const parts = path.slice(0, depth);
        paths.set(JSON.stringify(parts), parts.join(' / '));
      }
    }
    return [...paths].sort((a, b) => a[1].localeCompare(b[1]));
  });
  const folderOptions = $derived([
    { value: '', label: 'All folders' },
    ...(requests.some(req => !req.folderPath?.length) ? [{ value: '[]', label: 'Collection root' }] : []),
    ...folders.map(([value, label]) => ({ value, label })),
  ]);
  const visible = $derived.by(() => {
    const path: string[] = folder ? JSON.parse(folder) : [];
    const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
    return requests.filter(req => {
      const parts = req.folderPath ?? [];
      if (folder === '[]' && parts.length) return false;
      if (!path.every((part, i) => parts[i] === part)) return false;
      const text = [req.name, req.method, req.requestType, req.url, parts.join(' / ')].join(' ').toLowerCase();
      return words.every(word => text.includes(word));
    });
  });
  const checked = $derived(new Set(selected));
  const allVisible = $derived(visible.length > 0 && visible.every(req => checked.has(req.id)));

  function toggleVisible() {
    const next = new SvelteSet(selected);
    for (const req of visible) {
      if (allVisible) next.delete(req.id);
      else next.add(req.id);
    }
    selected = [...next];
  }
</script>

<div class="dialog-backdrop" role="presentation" onmousedown={(event) => event.target === event.currentTarget && onClose()}>
  <div class="modal docs-modal" role="dialog" aria-modal="true" aria-labelledby="docs-dialog-title" tabindex="-1" use:trapFocus
    onkeydown={(event) => { if (event.key === 'Escape') { event.stopPropagation(); onClose(); } }}>
    <div class="modal-head">
      <h2 class="modal-title" id="docs-dialog-title">Generate documentation</h2>
      <button class="btn btn-ghost btn-icon" aria-label="Close dialog" onclick={onClose}><AddCloseIcon /></button>
    </div>
    <div class="docs-body">
      <div class="collection-summary">
        <div class="collection-icon"><MenuIcon name="docs" /></div>
        <div>
          <div class="collection-title">{collection.name}</div>
          <div class="stats">{requests.length} {requests.length === 1 ? 'request' : 'requests'} · {folders.length} {folders.length === 1 ? 'folder' : 'folders'}{#if collection.environmentIds?.length}{' · '}{collection.environmentIds.length} pinned {collection.environmentIds.length === 1 ? 'environment' : 'environments'}{/if}</div>
        </div>
        <span class="tag format">HTML</span>
      </div>
      <fieldset class="scope">
        <legend>Requests to include</legend>
        <div class="segmented segmented-md">
          <label class="segmented-item"><input type="radio" name="docs-request-scope" bind:group={selection} value={false} />All requests</label>
          <label class="segmented-item"><input type="radio" name="docs-request-scope" bind:group={selection} value={true} disabled={!requests.length} />Select requests</label>
        </div>
      </fieldset>
      {#if selection}
        <div class="filters">
          <div class="field field-wrap">
            <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" aria-hidden="true"><circle cx="7" cy="7" r="4" /><path d="m10 10 3 3" /></svg>
            <input type="search" aria-label="Filter requests" placeholder="Search requests…" bind:value={query} autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" />
          </div>
          <Select className="setting-select" bind:value={folder} options={folderOptions} ariaLabel="Filter by folder" searchable={folderOptions.length > 8} searchPlaceholder="Search folders…" floating />
        </div>
        <div class="request-picker">
          <div class="list-tools">
            <span aria-live="polite">{selected.length} of {requests.length} selected</span>
            <button type="button" class="btn btn-ghost btn-sm" disabled={!visible.length} onclick={toggleVisible}>{allVisible ? 'Clear visible' : 'Select visible'}</button>
          </div>
          <div class="choices">
            {#each visible as req (req.id)}
              <label class="choice">
                <input class="check" type="checkbox" checked={checked.has(req.id)} onchange={(event) => selected = event.currentTarget.checked ? [...selected, req.id] : selected.filter(id => id !== req.id)} />
                <RequestTypeBadge request={req} variant="search" />
                <span class="request-name">
                  <span>{req.name}</span>
                  {#if req.folderPath?.length}<small>{req.folderPath.join(' / ')}</small>{/if}
                </span>
              </label>
            {:else}
              <p class="empty-state">No matching requests</p>
            {/each}
          </div>
        </div>
      {/if}
      <details class="link-settings">
        <summary>Link settings</summary>
        <label for="docs-link-base">Documentation URL</label>
        <input id="docs-link-base" class="field" type="url" bind:value={linkBaseUrl} placeholder="https://docs.example.com" aria-describedby="docs-link-hint" aria-invalid={!validLinkBase} spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="none" />
        <small id="docs-link-hint">{validLinkBase ? 'Used to open relative links in documentation.' : 'Enter an HTTP or HTTPS URL without credentials.'}</small>
      </details>
    </div>
    <div class="modal-foot">
      <span class="export-hint">Opens in your browser and works offline.</span>
      <button type="button" class="btn btn-ghost" onclick={onClose}>Cancel</button>
      <button type="button" class="btn btn-primary" disabled={!validLinkBase || (selection && !selected.length)} onclick={() => onGenerate(selection ? selected : undefined, linkBaseUrl.trim() || undefined)}>Generate</button>
    </div>
  </div>
</div>

<style>
  .docs-modal { width: min(34rem, 94vw); max-height: 90vh; }
  .modal-head .btn { margin-left: auto; }
  .docs-body { display: grid; gap: var(--space-3); padding: var(--space-4); overflow: auto; }
  .collection-summary {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    gap: var(--space-3);
    align-items: center;
    padding: var(--space-3);
    background: var(--surface);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
  }
  .collection-icon {
    display: grid;
    place-items: center;
    width: 2.25rem;
    height: 2.25rem;
    border-radius: var(--radius-md);
    color: var(--accent-text);
    background: var(--accent-dim);
  }
  .collection-icon :global(svg) { width: 1.125rem; height: 1.125rem; }
  .collection-title { font-weight: var(--weight-semibold); overflow-wrap: anywhere; }
  .stats, .list-tools, .export-hint { color: var(--text-2); font-size: var(--text-label); }
  .stats { margin-top: var(--space-0-5); }
  .format { font-family: var(--font-mono); }
  .scope { min-width: 0; border: 0; padding: 0; margin: 0; }
  .scope legend { padding: 0; margin-bottom: var(--space-2); color: var(--text-2); font-size: var(--text-label); }
  .filters { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: var(--space-2); }
  .request-picker { overflow: hidden; background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius-lg); }
  .list-tools {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    padding: var(--space-1) var(--space-2-5);
    border-bottom: 1px solid var(--border);
    background: var(--elevated);
  }
  .choices { max-height: min(15rem, 34vh); overflow: auto; }
  .choice {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--control-lg);
    padding: var(--space-1-5) var(--space-3);
    cursor: pointer;
  }
  .choice + .choice { border-top: 1px solid var(--border-subtle); }
  .choice:hover { background: color-mix(in srgb, var(--hover) 30%, var(--surface)); }
  .choice:has(.check:checked) { background: color-mix(in srgb, var(--accent-dim) 35%, transparent); }
  .request-name { display: grid; gap: var(--space-0-5); overflow-wrap: anywhere; font-size: var(--text-label); }
  .request-name small { color: var(--text-2); font-size: var(--text-micro); }
  .choices .empty-state { margin: 0; padding: var(--space-4); }
  .link-settings { color: var(--text-2); font-size: var(--text-label); }
  .link-settings summary { cursor: pointer; }
  .link-settings label, .link-settings small { display: block; margin-top: var(--space-2); }
  .link-settings .field { width: 100%; margin-top: var(--space-1); }
  .modal-foot { flex-wrap: wrap; border-top: 1px solid var(--border-subtle); }
  .export-hint { margin-right: auto; }

  @media (max-width: 440px) {
    .filters { grid-template-columns: minmax(0, 1fr); }
  }
</style>
