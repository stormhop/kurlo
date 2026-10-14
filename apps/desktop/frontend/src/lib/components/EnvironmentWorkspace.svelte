<script lang="ts">
  import MenuIcon from './MenuIcon.svelte';
  import EnvironmentMatrix from './EnvironmentMatrix.svelte';
  import type { Environment, KVRow } from '../types/models';

  let {
    activeEnvironment,
    activeEnvironmentId,
    autosave,
    environmentSaveState,
    createEnvironment,
    renameEnvironment,
    setEnvironmentProtected = () => {},
    useEnvironment,
    deleteEnvironment,
    saveEnvironment,
    updateEnvironmentRow,
    removeEnvironmentRow,
    importEnvFromFile,
    exportEnvironment,
    environments = [],
    environmentView = 'single',
    setEnvironmentView = () => {},
    openEnvironment = () => {},
    setMatrixValue = () => {},
    unsetMatrixValue = () => {},
    setVariableSecret = () => {},
    renameVariable = () => '',
    addVariable = () => {},
    removeVariable = () => {},
  }: {
    activeEnvironment: Environment | undefined;
    activeEnvironmentId: string;
    autosave: boolean;
    environmentSaveState: 'idle' | 'dirty' | 'saving' | 'saved';
    createEnvironment: () => void;
    renameEnvironment: (environmentId: string) => void;
    setEnvironmentProtected?: (environmentId: string, isProtected: boolean) => void;
    useEnvironment: (environmentId: string) => void;
    deleteEnvironment: (environmentId: string) => void;
    saveEnvironment: () => void;
    updateEnvironmentRow: (environmentId: string, index: number, patch: Partial<KVRow>) => void;
    removeEnvironmentRow: (environmentId: string, index: number) => void;
    importEnvFromFile: (environmentId: string) => void;
    exportEnvironment: (environmentId: string) => void;
    environments?: Environment[];
    environmentView?: 'single' | 'matrix';
    setEnvironmentView?: (view: 'single' | 'matrix') => void;
    openEnvironment?: (environmentId: string) => void;
    setMatrixValue?: (environmentId: string, key: string, value: string) => void;
    unsetMatrixValue?: (environmentId: string, key: string) => void;
    setVariableSecret?: (key: string, secret: boolean) => void;
    renameVariable?: (from: string, to: string) => string;
    addVariable?: () => void;
    removeVariable?: (key: string) => void;
  } = $props();

  let showMatrix = $derived(environmentView === 'matrix' && environments.length > 1);
  let activeName = $derived(environments.find(environment => environment.id === activeEnvironmentId)?.name ?? '');
  let workspaceVariableCount = $derived(new Set(environments.flatMap(environment => environment.values.map(row => row.key.trim()).filter(Boolean))).size);

  let moreMenuOpen = $state(false);
  let variableCount = $derived((activeEnvironment?.values ?? []).filter(row => row.key.trim()).length);

  function closeMoreMenuOnFocusOut(event: FocusEvent) {
    const current = event.currentTarget;
    const next = event.relatedTarget;
    if (!(current instanceof HTMLElement)) return;
    if (!(next instanceof Node) || !current.contains(next)) moreMenuOpen = false;
  }

  function runMenuAction(action: () => void) {
    moreMenuOpen = false;
    action();
  }

  const ENVIRONMENT_ROW_PAGE_SIZE = 100;
  let valuePage = $state(0);
  let valuePageCount = $derived(pageCount(activeEnvironment?.values.length ?? 0, ENVIRONMENT_ROW_PAGE_SIZE));
  let visibleEnvironmentRows = $derived.by(() => {
    const values = activeEnvironment?.values ?? [];
    const start = valuePage * ENVIRONMENT_ROW_PAGE_SIZE;
    return values.slice(start, start + ENVIRONMENT_ROW_PAGE_SIZE).map((row, index) => ({ row, index: start + index }));
  });

  $effect(() => {
    activeEnvironment?.id;
    valuePage = 0;
  });

  $effect(() => {
    activeEnvironment?.values.length;
    if (valuePage >= valuePageCount) valuePage = Math.max(0, valuePageCount - 1);
  });

  function pageCount(total: number, size: number): number {
    return Math.max(1, Math.ceil(total / size));
  }

  function rangeLabel(page: number, size: number, total: number): string {
    if (!total) return '0 of 0';
    const start = page * size + 1;
    const end = Math.min(total, (page + 1) * size);
    return `${start}-${end} of ${total}`;
  }

  function inputValue(event: Event): string {
    const target = event.currentTarget;
    return target instanceof HTMLInputElement ? target.value : '';
  }

  function inputChecked(event: Event): boolean {
    const target = event.currentTarget;
    return target instanceof HTMLInputElement ? target.checked : false;
  }
</script>

<section class="environment-workspace">
  {#snippet viewSwitch()}
    {#if environments.length > 1}
      <div class="segmented env-view-switch" role="radiogroup" aria-label="Environment view">
        <button class="segmented-item" type="button" role="radio" aria-checked={showMatrix} class:active={showMatrix} onclick={() => setEnvironmentView('matrix')}>Matrix</button>
        <button class="segmented-item" type="button" role="radio" aria-checked={!showMatrix} class:active={!showMatrix} onclick={() => setEnvironmentView('single')}>Single</button>
      </div>
    {/if}
  {/snippet}
  {#if showMatrix}
    <div class="environment-workspace-head">
      <div class="environment-title">
        <h1>Variables</h1>
        <p>
          {workspaceVariableCount} {workspaceVariableCount === 1 ? 'variable' : 'variables'} across {environments.length} environments{activeName ? ` · ${activeName} is in use` : ''}
          {#if environmentSaveState !== 'idle'}
            <span class="env-save-indicator" class:saved={environmentSaveState === 'saved'} class:dirty={environmentSaveState === 'dirty'}> · {environmentSaveState === 'saving' ? 'Saving…' : environmentSaveState === 'dirty' ? 'Unsaved changes' : 'Saved'}</span>
          {/if}
        </p>
      </div>
      <div class="overview-actions">
        {@render viewSwitch()}
        {#if !autosave}
          <button class="btn btn-secondary" type="button" onclick={saveEnvironment} disabled={environmentSaveState !== 'dirty'}>Save</button>
        {/if}
        <button class="btn btn-primary" type="button" onclick={addVariable}>+ Variable</button>
      </div>
    </div>
    <EnvironmentMatrix
      {environments}
      {activeEnvironmentId}
      onSetValue={setMatrixValue}
      onUnsetValue={unsetMatrixValue}
      onSetSecret={setVariableSecret}
      onRename={renameVariable}
      onRemove={removeVariable}
      onOpenEnvironment={(id) => { openEnvironment(id); setEnvironmentView('single'); }}
    />
  {:else if activeEnvironment}
    <div class="environment-workspace-head">
      <div class="environment-title">
        <h1>
          {activeEnvironment.name}
          {#if activeEnvironment.protected}
            <span class="env-protected" title="AI agents connected through kurlo mcp cannot send requests with this environment or change it"><MenuIcon name="lock" />Protected</span>
          {/if}
        </h1>
        <p>
          {variableCount} {variableCount === 1 ? 'variable' : 'variables'} · use them in requests as {'{{variableName}}'}
          {#if environmentSaveState !== 'idle'}
            <span class="env-save-indicator" class:saved={environmentSaveState === 'saved'} class:dirty={environmentSaveState === 'dirty'}> · {environmentSaveState === 'saving' ? 'Saving…' : environmentSaveState === 'dirty' ? 'Unsaved changes' : 'Saved'}</span>
          {/if}
        </p>
      </div>
      <div class="overview-actions">
        {@render viewSwitch()}
        {#if !autosave}
          <button class="btn btn-secondary" type="button" onclick={saveEnvironment} disabled={environmentSaveState !== 'dirty'}>Save</button>
        {/if}
        {#if activeEnvironmentId === activeEnvironment.id}
          <button class="env-in-use" type="button" onclick={() => useEnvironment(activeEnvironment.id)} title="This environment's values are applied to requests">In use</button>
        {:else}
          <button class="btn btn-primary" type="button" onclick={() => useEnvironment(activeEnvironment.id)}>Use environment</button>
        {/if}
        <div class="env-more" onfocusout={closeMoreMenuOnFocusOut}>
          <button class="btn btn-ghost btn-icon env-more-btn" type="button" aria-label="More environment actions" aria-haspopup="menu" aria-expanded={moreMenuOpen} onclick={() => (moreMenuOpen = !moreMenuOpen)}>•••</button>
          {#if moreMenuOpen}
            <div class="menu request-menu env-more-menu" role="menu">
              <button class="menu-item" type="button" role="menuitem" onclick={() => runMenuAction(() => renameEnvironment(activeEnvironment.id))}><MenuIcon name="rename" />Rename</button>
              <button class="menu-item" type="button" role="menuitemcheckbox" aria-checked={Boolean(activeEnvironment.protected)} title="AI agents connected through kurlo mcp cannot send requests with a protected environment or change it" onclick={() => runMenuAction(() => setEnvironmentProtected(activeEnvironment.id, !activeEnvironment.protected))}><MenuIcon name="lock" />{activeEnvironment.protected ? 'Unprotect from AI agents' : 'Protect from AI agents'}</button>
              <div class="menu-separator" role="separator"></div>
              <button class="menu-item" type="button" role="menuitem" title="Import variables from a .env file" onclick={() => runMenuAction(() => importEnvFromFile(activeEnvironment.id))}><MenuIcon name="import" />Import .env</button>
              <button class="menu-item" type="button" role="menuitem" onclick={() => runMenuAction(() => exportEnvironment(activeEnvironment.id))}><MenuIcon name="export" />Export…</button>
              <div class="menu-separator" role="separator"></div>
              <button class="menu-item danger" type="button" role="menuitem" onclick={() => runMenuAction(() => deleteEnvironment(activeEnvironment.id))}><MenuIcon name="trash" />Delete</button>
            </div>
          {/if}
        </div>
      </div>
    </div>
    <div class="environment-editor-card">
      <div class="kv-head env-kv-head">
        <span></span>
        <span>Variable</span>
        <span>Type</span>
        <span>Value</span>
        <span>Description</span>
        <span></span>
      </div>
      {#each visibleEnvironmentRows as item (item.row.id)}
        {@const row = item.row}
        {@const i = item.index}
        <div class="kv-row env-kv-row" data-testid="environment-variable-row" class:inactive-row={!row.enabled && (row.key || row.value || row.description)} title={!row.enabled && (row.key || row.value || row.description) ? 'Disabled variables are not applied to requests' : ''}>
          <input type="checkbox" class="check" checked={row.enabled} onchange={(event) => updateEnvironmentRow(activeEnvironment.id, i, { enabled: inputChecked(event) })} aria-label="Enable variable" disabled={!row.key && !row.value} />
          <input class="field field-bare kv-input" value={row.key} placeholder="Add variable" aria-label="Environment variable key" oninput={(event) => updateEnvironmentRow(activeEnvironment.id, i, { key: inputValue(event) })} spellcheck="false" />
          <button
            class="env-type-toggle"
            class:secret={row.secret}
            type="button"
            title={row.secret ? 'Secret variables are masked in UI, logs, and snippets' : 'Default variable'}
            onclick={() => updateEnvironmentRow(activeEnvironment.id, i, { secret: !row.secret })}
            disabled={!row.key && !row.value}
          >
            {row.secret ? 'Secret' : 'Default'}
          </button>
          <input class="field field-bare kv-input" type={row.secret ? 'password' : 'text'} value={row.value} placeholder="Value" aria-label="Environment variable value" oninput={(event) => updateEnvironmentRow(activeEnvironment.id, i, { value: inputValue(event) })} spellcheck="false" autocomplete="off" />
          <input class="field field-bare kv-input kv-desc" value={row.description} placeholder="Description" aria-label="Environment variable description" oninput={(event) => updateEnvironmentRow(activeEnvironment.id, i, { description: inputValue(event) })} />
          <button class="btn btn-ghost btn-icon btn-sm kv-del" type="button" onclick={() => removeEnvironmentRow(activeEnvironment.id, i)} aria-label="Remove variable">✕</button>
        </div>
      {/each}
      {#if activeEnvironment.values.length > ENVIRONMENT_ROW_PAGE_SIZE}
        <div class="environment-pagination" aria-label="Environment variable pages">
          <span>Variables {rangeLabel(valuePage, ENVIRONMENT_ROW_PAGE_SIZE, activeEnvironment.values.length)}</span>
          <div class="environment-page-buttons">
            <button class="btn btn-secondary btn-sm" type="button" onclick={() => (valuePage = Math.max(0, valuePage - 1))} disabled={valuePage === 0}>Prev</button>
            <span>{valuePage + 1}/{valuePageCount}</span>
            <button class="btn btn-secondary btn-sm" type="button" onclick={() => (valuePage = Math.min(valuePageCount - 1, valuePage + 1))} disabled={valuePage + 1 >= valuePageCount}>Next</button>
          </div>
        </div>
      {/if}
    </div>
  {:else}
    <div class="empty-state environment-empty-main">
      <span class="empty-state-title">No environment selected</span>
      <small class="empty-state-text">Create an environment to reuse variables in URLs, headers, params, auth, and bodies.</small>
      <button class="btn btn-primary" type="button" onclick={createEnvironment}>Create environment</button>
    </div>
  {/if}
</section>
