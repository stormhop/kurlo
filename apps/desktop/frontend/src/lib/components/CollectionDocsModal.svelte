<script lang="ts">
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { trapFocus } from '../a11y';
  import type { Collection, SavedRequest } from '../types/models';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import RequestTypeBadge from './RequestTypeBadge.svelte';
  import Select from './Select.svelte';

  let { collection, requests, linkScopes, onGenerate, onClose }: {
    collection: Collection;
    requests: SavedRequest[];
    linkScopes: string[] | null;
    onGenerate: (ids?: string[], linkBaseUrl?: string) => void;
    onClose: () => void;
  } = $props();

  let selection = $state(false);
  let query = $state('');
  let folder = $state('');
  let selected = $state<string[]>([]);
  let linkBaseUrl = $state('');
  const showLinkBase = $derived(linkScopes?.some(id => !id || !selection || checked.has(id)) ?? false);
  const validLinkBase = $derived.by(() => {
    const value = linkBaseUrl.trim();
    if (!showLinkBase || !value) return true;
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
      <div class="docs-title">
        <h2 class="modal-title" id="docs-dialog-title">Generate documentation</h2>
        <span class="stats"><span class="collection-name">{collection.name}</span> · {requests.length} {requests.length === 1 ? 'request' : 'requests'} · {folders.length} {folders.length === 1 ? 'folder' : 'folders'}{#if collection.environmentIds?.length}{' · '}{collection.environmentIds.length} pinned {collection.environmentIds.length === 1 ? 'environment' : 'environments'}{/if}</span>
      </div>
      <button class="btn btn-ghost btn-icon" aria-label="Close dialog" onclick={onClose}><AddCloseIcon /></button>
    </div>
    <div class="docs-body">
      <fieldset class="scope">
        <legend>Requests to include</legend>
        <div class="segmented segmented-md">
          <label class="segmented-item"><input type="radio" name="docs-request-scope" bind:group={selection} value={false} />All requests</label>
          <label class="segmented-item"><input type="radio" name="docs-request-scope" bind:group={selection} value={true} disabled={!requests.length} />Select requests</label>
        </div>
      </fieldset>
      {#if selection}
        <div class="selection">
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
              <button type="button" class="btn-link" disabled={!visible.length} onclick={toggleVisible}>{allVisible ? 'Clear visible' : 'Select visible'}</button>
            </div>
            <div class="choices">
              {#each visible as req (req.id)}
                <label class="choice">
                  <input class="check" type="checkbox" checked={checked.has(req.id)} onchange={(event) => selected = event.currentTarget.checked ? [...selected, req.id] : selected.filter(id => id !== req.id)} />
                  <RequestTypeBadge request={req} variant="search" />
                  <span class="request-name">{req.name}</span>
                  {#if req.folderPath?.length}<span class="request-folder">{req.folderPath.join(' / ')}</span>{/if}
                </label>
              {:else}
                <p class="empty-state">No matching requests</p>
              {/each}
            </div>
          </div>
        </div>
      {/if}
      {#if showLinkBase}
        <div class="link-base">
          <label for="docs-link-base">Base URL for relative links</label>
          <input id="docs-link-base" class="field" type="url" bind:value={linkBaseUrl} placeholder="https://docs.example.com" aria-describedby="docs-link-hint" aria-invalid={!validLinkBase} spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="none" />
          <small id="docs-link-hint">{validLinkBase ? 'Optional. Leave empty to keep links relative in the exported HTML.' : 'Enter an HTTP or HTTPS URL without credentials.'}</small>
        </div>
      {/if}
    </div>
    <div class="modal-foot">
      <span class="export-hint">Opens in your browser and works offline.</span>
      <button type="button" class="btn btn-secondary" onclick={onClose}>Cancel</button>
      <button type="button" class="btn btn-primary" disabled={linkScopes === null || !validLinkBase || (selection && !selected.length)} onclick={() => onGenerate(selection ? selected : undefined, (showLinkBase && linkBaseUrl.trim()) || undefined)}>Generate</button>
    </div>
  </div>
</div>

<style>
  .docs-modal { width: min(34rem, 94vw); max-height: 90vh; }
  .docs-title { display: grid; gap: var(--space-0-5); flex: 1 1 auto; min-width: 0; }
  .stats { overflow: hidden; color: var(--text-3); font-size: var(--text-label); text-overflow: ellipsis; white-space: nowrap; }
  .collection-name { color: var(--text-2); font-weight: var(--weight-medium); }
  .docs-body { display: grid; gap: var(--space-4); padding: var(--space-4); overflow: auto; }
  .scope { min-width: 0; border: 0; padding: 0; margin: 0; }
  .scope legend { padding: 0; margin-bottom: var(--space-2); color: var(--text-2); font-size: var(--text-label); font-weight: var(--weight-medium); }
  .filters { display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); gap: var(--space-2); }
  .selection { display: grid; gap: var(--space-2); min-width: 0; }
  .request-picker { overflow: hidden; border: 1px solid var(--border-subtle); border-radius: var(--radius-md); }
  .list-tools {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--space-2);
    min-height: var(--control-md);
    padding: 0 var(--space-3);
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-3);
    font-size: var(--text-label);
  }
  .choices { max-height: min(17rem, 38vh); overflow: auto; overscroll-behavior: none; }
  .choice {
    display: flex;
    align-items: center;
    gap: var(--space-2-5);
    min-height: var(--control-lg);
    padding: var(--space-1) var(--space-3);
    cursor: pointer;
  }
  .choice + .choice { border-top: 1px solid var(--border-subtle); }
  .choice:hover { background: color-mix(in srgb, var(--hover) 50%, transparent); }
  .choice:has(.check:checked) { background: color-mix(in srgb, var(--accent-dim) 45%, transparent); }
  .request-name { flex: 0 1 auto; min-width: 0; overflow: hidden; color: var(--text); text-overflow: ellipsis; white-space: nowrap; }
  .request-folder { flex: 1 1 0; min-width: 4rem; overflow: hidden; color: var(--text-3); font-size: var(--text-label); text-align: right; text-overflow: ellipsis; white-space: nowrap; }
  .choices .empty-state { margin: 0; padding: var(--space-4); }
  .link-base { color: var(--text-2); font-size: var(--text-label); }
  .link-base label { font-weight: var(--weight-medium); }
  .link-base small { display: block; margin-top: var(--space-1-5); color: var(--text-3); }
  .link-base .field { width: 100%; margin-top: var(--space-2); }
  .modal-foot { flex-wrap: wrap; }
  .export-hint { margin-right: auto; color: var(--text-3); font-size: var(--text-label); }

  @media (max-width: 440px) {
    .filters { grid-template-columns: minmax(0, 1fr); }
  }
</style>
