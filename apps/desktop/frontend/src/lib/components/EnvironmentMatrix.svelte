<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import { tick } from 'svelte';
  import { buildEnvironmentMatrix, type MatrixRow } from '../environmentMatrix';
  import { effectiveEnvironmentRows, parentEnvironment } from '../environmentInheritance';
  import { readMatrixColumns, toggleMatrixColumn, visibleMatrixEnvironments, writeMatrixColumns } from '../environmentMatrixColumns';
  import type { Environment } from '../types/models';

  let {
    environments,
    activeEnvironmentId,
    onSetValue,
    onUnsetValue,
    onSetSecret,
    onRename,
    onRemove,
    onOpenEnvironment,
  }: {
    environments: Environment[];
    activeEnvironmentId: string;
    onSetValue: (environmentId: string, key: string, value: string) => void;
    onUnsetValue: (environmentId: string, key: string) => void;
    onSetSecret: (key: string, secret: boolean) => void;
    onRename: (from: string, to: string) => string;
    onRemove: (key: string) => void;
    onOpenEnvironment: (environmentId: string) => void;
  } = $props();

  let filter = $state('');
  let revealed = $state<Set<string>>(new Set());
  let renameError = $state<{ key: string; message: string } | null>(null);
  let gridEl = $state<HTMLDivElement>();
  let columnsOpen = $state(false);
  let columnsQuery = $state('');
  let columnsRoot = $state<HTMLDivElement>();
  let columnsButton = $state<HTMLButtonElement>();
  let workspaceId = $derived(environments[0]?.workspaceId ?? '');
  let chosenColumns = $derived<string[] | null>(readMatrixColumns(workspaceId));

  let shown = $derived(visibleMatrixEnvironments(environments, chosenColumns, activeEnvironmentId));
  let shownIds = $derived(new Set(shown.map(environment => environment.id)));
  let columnChoices = $derived.by(() => {
    const query = columnsQuery.trim().toLowerCase();
    return query ? environments.filter(environment => environment.name.toLowerCase().includes(query)) : environments;
  });

  function setColumns(ids: string[] | null) {
    chosenColumns = ids;
    writeMatrixColumns(workspaceId, ids);
  }

  function toggleColumn(environmentId: string) {
    setColumns(toggleMatrixColumn(environments, chosenColumns, activeEnvironmentId, environmentId));
  }

  function closeColumns(focusButton = false) {
    columnsOpen = false;
    columnsQuery = '';
    if (focusButton) columnsButton?.focus();
  }

  function closeColumnsOnFocusOut(event: FocusEvent) {
    const next = event.relatedTarget;
    if (columnsOpen && (!(next instanceof Node) || !columnsRoot?.contains(next))) closeColumns();
  }

  function closeColumnsOnOutsidePointer(event: PointerEvent) {
    if (columnsOpen && event.target instanceof Node && !columnsRoot?.contains(event.target)) closeColumns();
  }

  function onColumnsKeydown(event: KeyboardEvent) {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    closeColumns(true);
  }

  function fitToWindow(node: HTMLElement) {
    const fit = () => {
      const top = node.getBoundingClientRect().top;
      const bottom = node.closest('.environment-workspace')?.getBoundingClientRect().bottom ?? window.innerHeight;
      node.style.maxHeight = `${Math.max(160, bottom - top - 12)}px`;
    };
    fit();
    window.addEventListener('resize', fit);
    return { destroy: () => window.removeEventListener('resize', fit) };
  }

  function focusOnMount(node: HTMLInputElement) {
    node.focus();
  }

  let rows = $derived(buildEnvironmentMatrix(environments));
  let effective = $derived(new Map(environments.map(environment => [environment.id, effectiveEnvironmentRows(environments, environment.id)])));
  let parents = $derived(new Map(environments.map(environment => [environment.id, parentEnvironment(environments, environment)])));

  function inheritedCell(environmentId: string, key: string) {
    const item = effective.get(environmentId)?.get(key);
    return item && item.sourceId !== environmentId ? item : undefined;
  }
  let visibleRows = $derived.by(() => {
    const query = filter.trim().toLowerCase();
    return query ? rows.filter(row => row.key.toLowerCase().includes(query)) : rows;
  });

  function inputValue(event: Event): string {
    const target = event.currentTarget;
    return target instanceof HTMLInputElement ? target.value : '';
  }

  function toggleReveal(key: string) {
    revealed = revealed.has(key)
      ? new Set([...revealed].filter(item => item !== key))
      : new Set([...revealed, key]);
  }

  function commitRename(row: MatrixRow, event: Event) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement)) return;
    const problem = onRename(row.key, target.value);
    if (problem) {
      renameError = { key: row.key, message: problem };
      target.value = row.key;
    } else {
      renameError = null;
    }
  }

  function onNameKeydown(event: KeyboardEvent) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLInputElement)) return;
    if (event.key === 'Enter') target.blur();
    if (event.key === 'Escape') {
      target.value = target.defaultValue;
      target.blur();
    }
  }

  let editingUnset = $state<{ environmentId: string; key: string } | null>(null);

  async function startSetting(environmentId: string, key: string) {
    editingUnset = { environmentId, key };
    await tick();
    gridEl?.querySelector<HTMLInputElement>(`[data-unset-cell="${CSS.escape(environmentId)}:${CSS.escape(key)}"]`)?.focus();
  }

  function onUnsetInput(environmentId: string, key: string, event: Event) {
    const value = inputValue(event);
    if (value === '') return;
    editingUnset = null;
    onSetValue(environmentId, key, value);
  }
</script>

<svelte:window onpointerdown={closeColumnsOnOutsidePointer} />

<div class="env-matrix-toolbar">
  <div class="field field-md field-wrap env-matrix-filter">
    <svg width="0.75rem" height="0.75rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
      <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
      <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
    </svg>
    <input bind:value={filter} placeholder="Find variable" aria-label="Find variable" spellcheck="false" />
  </div>
  {#if renameError}
    <span class="env-matrix-error" role="alert">{renameError.message}</span>
  {/if}
  <div class="env-matrix-columns" bind:this={columnsRoot} onfocusout={closeColumnsOnFocusOut}>
    <button
      class="btn btn-secondary"
      bind:this={columnsButton}
      type="button"
      aria-haspopup="dialog"
      aria-expanded={columnsOpen}
      onclick={() => (columnsOpen ? closeColumns() : (columnsOpen = true))}
    >
      Environments <span class="env-matrix-columns-count">{shown.length} of {environments.length}</span>
    </button>
    {#if columnsOpen}
      <div class="menu env-matrix-columns-menu" role="dialog" aria-label="Environments in the matrix" tabindex="-1" onkeydown={onColumnsKeydown} use:fitToWindow>
        <div class="field field-md field-wrap env-matrix-columns-search">
          <svg width="0.75rem" height="0.75rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
            <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
            <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
          </svg>
          <input bind:value={columnsQuery} placeholder="Find environment" aria-label="Find environment" spellcheck="false" use:focusOnMount />
        </div>
        <div class="env-matrix-columns-list">
          {#each columnChoices as environment (environment.id)}
            {@const inUse = environment.id === activeEnvironmentId}
            <label class="check-label env-matrix-columns-item">
              <input
                class="check"
                type="checkbox"
                checked={shownIds.has(environment.id)}
                aria-disabled={inUse}
                onclick={(event) => { if (inUse) event.preventDefault(); }}
                onchange={() => toggleColumn(environment.id)}
              />
              <span class="env-matrix-columns-name">{environment.name}</span>
              {#if inUse}<span class="env-matrix-columns-hint">in use</span>{/if}
            </label>
          {:else}
            <p class="env-matrix-columns-empty">No environment matches.</p>
          {/each}
        </div>
        <div class="env-matrix-columns-actions">
          <button class="btn btn-ghost btn-sm" type="button" onclick={() => setColumns(environments.map(environment => environment.id))}>Show all</button>
          <button class="btn btn-ghost btn-sm" type="button" onclick={() => setColumns(null)}>Reset</button>
        </div>
      </div>
    {/if}
  </div>
</div>

<div class="env-matrix-scroll">
  <div class="env-matrix" role="table" aria-label="Variables by environment" bind:this={gridEl} style={`--env-columns: ${shown.length}`}>
    <div class="env-matrix-row env-matrix-head" role="row">
      <span class="env-matrix-name-head" role="columnheader">Variable</span>
      {#each shown as environment (environment.id)}
        <span class="env-matrix-col-head" class:in-use={environment.id === activeEnvironmentId} role="columnheader">
          <button class="btn btn-ghost btn-sm" type="button" onclick={() => onOpenEnvironment(environment.id)}>
            {#if environment.id === activeEnvironmentId}<span class="env-matrix-dot" aria-hidden="true"></span>{/if}
            <span>{environment.name}</span>
          </button>
          {#if parents.get(environment.id)}
            <span class="env-matrix-parent">↳ {parents.get(environment.id)?.name}</span>
          {/if}
        </span>
      {/each}
      <span role="columnheader" aria-label="Actions"></span>
    </div>

    {#each visibleRows as row (row.key)}
      <div class="env-matrix-row" role="row" data-testid="environment-matrix-row">
        <span class="env-matrix-name" role="rowheader">
          <input
            class="field field-bare field-md env-matrix-name-input"
            value={row.key}
            aria-label={`Name of ${row.key}`}
            spellcheck="false"
            onblur={(event) => commitRename(row, event)}
            onkeydown={onNameKeydown}
          />
          <button
            class="btn btn-ghost btn-icon btn-sm env-matrix-icon"
            class:on={row.secret}
            type="button"
            aria-pressed={row.secret}
            aria-label={row.secret ? `${row.key} is secret — make it a plain variable` : `Make ${row.key} secret`}
            onclick={() => onSetSecret(row.key, !row.secret)}
          >
            <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5" y="11" width="14" height="9" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/></svg>
          </button>
          {#if row.secret}
            <button class="btn btn-ghost btn-icon btn-sm env-matrix-icon" type="button" aria-pressed={revealed.has(row.key)} aria-label={revealed.has(row.key) ? `Hide ${row.key}` : `Show ${row.key}`} onclick={() => toggleReveal(row.key)}>
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>
            </button>
          {/if}
        </span>

        {#each shown as environment (environment.id)}
          {@const cell = row.cells[environment.id]}
          {@const inherited = cell?.enabled ? undefined : inheritedCell(environment.id, row.key)}
          <span class="env-matrix-cell" class:in-use={environment.id === activeEnvironmentId} role="cell">
            {#if cell}
              <input
                class="field field-bare field-md env-matrix-value"
                class:disabled={!cell.enabled}
                type={row.secret && !revealed.has(row.key) ? 'password' : 'text'}
                value={cell.value}
                placeholder="empty"
                aria-label={`${row.key} in ${environment.name}`}
                spellcheck="false"
                autocomplete="off"
                oninput={(event) => onSetValue(environment.id, row.key, inputValue(event))}
              />
              <button class="env-matrix-unset" type="button" aria-label={`Unset ${row.key} in ${environment.name}`} onclick={() => onUnsetValue(environment.id, row.key)}><AddCloseIcon /></button>
            {:else if editingUnset?.environmentId === environment.id && editingUnset.key === row.key}
              <input
                class="field field-bare field-md env-matrix-value"
                type={row.secret ? 'password' : 'text'}
                value=""
                placeholder="Type a value"
                aria-label={`${row.key} in ${environment.name}`}
                data-unset-cell={`${environment.id}:${row.key}`}
                spellcheck="false"
                autocomplete="off"
                oninput={(event) => onUnsetInput(environment.id, row.key, event)}
                onblur={() => (editingUnset = null)}
              />
            {:else if inherited}
              <button class="env-matrix-inherited" type="button" data-testid="environment-matrix-inherited" aria-label={`Override ${row.key} in ${environment.name}, now inherited from ${inherited.sourceName}`} onclick={() => startSetting(environment.id, row.key)}>
                <span class="env-matrix-inherited-value">{row.secret && !revealed.has(row.key) ? '••••••••' : inherited.row.value || 'empty'}</span>
                <span class="env-matrix-inherited-source">{inherited.sourceName}</span>
              </button>
            {:else}
              <button class="env-matrix-not-set" type="button" aria-label={`Set ${row.key} in ${environment.name}`} onclick={() => startSetting(environment.id, row.key)}>Not set</button>
            {/if}
          </span>
        {/each}

        <span class="env-matrix-actions" role="cell">
          <button class="btn btn-ghost btn-icon btn-sm env-matrix-icon env-matrix-remove" type="button" aria-label={`Delete ${row.key} from every environment`} onclick={() => onRemove(row.key)}>
            <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="M2 3.5h9M5 3.5V2.5h3v1M3.5 3.5l.5 7h5l.5-7" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        </span>
      </div>
    {:else}
      <div class="env-matrix-empty" role="row">
        <span role="cell">{rows.length ? 'No variable matches.' : 'No variables yet. Add one to every environment at once with + Variable.'}</span>
      </div>
    {/each}
  </div>
</div>

<style>
  .env-matrix-toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    margin: var(--space-6) 0 var(--space-2-5);
  }

  .env-matrix-filter {
    width: 15rem;
    color: var(--text-3);
  }

  .env-matrix-filter input {
    flex: 1;
    min-width: 0;
  }

  .env-matrix-columns {
    position: relative;
    margin-left: auto;
  }

  .env-matrix-columns-count {
    color: var(--text-3);
  }

  .env-matrix-columns-menu {
    position: absolute;
    top: calc(100% + var(--space-1));
    right: 0;
    z-index: 20;
    display: flex;
    flex-direction: column;
    gap: var(--space-1-5);
    width: 17.5rem;
  }

  .env-matrix-columns-search,
  .env-matrix-columns-actions {
    flex-shrink: 0;
  }

  .env-matrix-columns-search {
    color: var(--text-3);
  }

  .env-matrix-columns-search input {
    flex: 1;
    min-width: 0;
  }

  .env-matrix-columns-list {
    display: flex;
    flex: 0 1 auto;
    flex-direction: column;
    min-height: 0;
    max-height: 17.5rem;
    overflow-y: auto;
    overscroll-behavior: none;
  }

  .env-matrix-columns-item {
    gap: var(--space-2);
    min-height: var(--control-md);
    padding: 0 var(--space-2);
    border-radius: var(--radius-sm);
  }

  .env-matrix-columns-item:hover {
    background: var(--hover);
  }

  .env-matrix-columns-item .check[aria-disabled='true'] {
    opacity: var(--opacity-disabled);
    cursor: not-allowed;
  }

  .env-matrix-columns-name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .env-matrix-columns-hint,
  .env-matrix-columns-empty {
    color: var(--text-3);
    font-size: var(--text-label);
  }

  .env-matrix-columns-empty {
    margin: 0;
    padding: var(--space-2);
  }

  .env-matrix-columns-actions {
    display: flex;
    justify-content: space-between;
    padding-top: var(--space-1-5);
    border-top: 1px solid var(--border-subtle);
  }

  .env-matrix-error {
    color: var(--s5xx);
    font-size: var(--text-body);
  }

  .env-matrix-scroll {
    flex: 0 1 auto;
    min-height: 0;
    overscroll-behavior: none;
    overflow: auto;
    border-top: 1px solid var(--border-subtle);
  }

  .env-matrix {
    display: grid;
    grid-template-columns: minmax(12.5rem, 15rem) repeat(var(--env-columns), minmax(11.25rem, 1fr)) 2.25rem;
    min-width: max-content;
  }

  .env-matrix-row {
    display: contents;
  }

  .env-matrix-row > span {
    display: flex;
    align-items: center;
    min-width: 0;
    min-height: 2.375rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .env-matrix-head > span {
    position: sticky;
    top: 0;
    z-index: 2;
    background: var(--bg);
    min-height: 2.125rem;
    color: var(--text-3);
    font-size: var(--text-label);
  }

  .env-matrix-name-head {
    padding-left: var(--space-2);
  }

  .env-matrix-row > .env-matrix-name-head,
  .env-matrix-row > .env-matrix-name {
    position: sticky;
    left: 0;
    z-index: 1;
    background: var(--bg);
    box-shadow: inset -1px 0 0 var(--border-subtle);
  }

  .env-matrix-row > .env-matrix-name-head {
    z-index: 3;
  }

  .env-matrix-col-head button {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
  }

  .env-matrix-dot {
    width: 0.4375rem;
    height: 0.4375rem;
    border-radius: 50%;
    background: var(--s2xx);
  }

  .env-matrix-row > .in-use {
    background: var(--accent-dim);
  }

  .env-matrix-head > .in-use {
    background: linear-gradient(var(--accent-dim), var(--accent-dim)), var(--bg);
  }

  .env-matrix-name {
    gap: var(--space-0-5);
    padding-right: var(--space-1-5);
  }

  .env-matrix-name-input,
  .env-matrix-value {
    width: 100%;
    min-width: 0;
    font-family: var(--font-mono);
    font-size: var(--text-label);
  }

  .env-matrix-value::placeholder {
    font-family: var(--font-ui);
  }

  .env-matrix-value.disabled {
    color: var(--text-3);
    text-decoration: line-through;
  }

  .env-matrix-cell {
    position: relative;
    padding: 0 var(--space-1);
  }

  .env-matrix-icon {
    display: grid;
    flex: 0 0 auto;
    place-items: center;
    opacity: 0;
  }

  .env-matrix-icon.on,
  .env-matrix-row:hover .env-matrix-icon,
  .env-matrix-icon:focus-visible {
    opacity: 1;
  }

  .env-matrix-icon.on {
    color: var(--accent-hover);
  }

  .env-matrix-remove:hover {
    color: var(--s5xx);
  }

  .env-matrix-unset {
    position: absolute;
    right: 0.5rem;
    display: none;
    width: 1.25rem;
    height: 1.25rem;
    border: none;
    border-radius: var(--radius-sm);
    background: var(--hover);
    color: var(--text-3);
    font-size: var(--text-body);
    line-height: var(--leading-none);
  }

  .env-matrix-cell:hover .env-matrix-unset,
  .env-matrix-unset:focus-visible {
    display: grid;
    place-items: center;
  }

  .env-matrix-not-set {
    height: 1.875rem;
    padding: 0 var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-3);
    font-size: var(--text-label);
    font-style: italic;
    text-align: left;
  }

  .env-matrix-not-set:hover {
    background: var(--hover);
    color: var(--text);
  }

  .env-matrix-col-head {
    gap: var(--space-1);
  }

  .env-matrix-parent {
    overflow: hidden;
    color: var(--text-3);
    font-size: var(--text-label);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .env-matrix-inherited {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    min-width: 0;
    height: 1.875rem;
    padding: 0 var(--space-2);
    border: none;
    border-radius: var(--radius-sm);
    background: transparent;
    color: var(--text-3);
    text-align: left;
  }

  .env-matrix-inherited:hover {
    background: var(--hover);
    color: var(--text-2);
  }

  .env-matrix-inherited-value {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    font-family: var(--font-mono);
    font-size: var(--text-label);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .env-matrix-inherited-source {
    flex: 0 0 auto;
    max-width: 45%;
    overflow: hidden;
    padding: 0 var(--space-1-5);
    border-radius: var(--radius-sm);
    background: var(--hover);
    font-size: var(--text-caption);
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .env-matrix-actions {
    justify-content: center;
  }

  .env-matrix-empty {
    grid-column: 1 / -1;
    padding: var(--space-4) var(--space-2);
    color: var(--text-3);
    font-size: var(--text-body);
  }
</style>
