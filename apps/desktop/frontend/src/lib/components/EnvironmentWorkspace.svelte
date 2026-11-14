<script lang="ts">
  import SaveActions from './SaveActions.svelte';
  import { NAME_MAX_LENGTH, shortName } from '../constants';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import EnvironmentMatrix from './EnvironmentMatrix.svelte';
  import Select from './Select.svelte';
  import { effectiveEnvironmentRows, environmentParentCandidates, parentEnvironment, protectingAncestor } from '../environmentInheritance';
  import type { Environment, EnvironmentColor, KVRow } from '../types/models';
  import { ENVIRONMENT_COLORS, environmentColorVar } from '../environmentColors';

  let {
    activeEnvironment,
    activeEnvironmentId,
    autosave,
    environmentSaveState,
    createEnvironment,
    renameEnvironment,
    setEnvironmentProtected = () => {},
    setEnvironmentSandbox = () => {},
    setEnvironmentColor = () => {},
    setEnvironmentParent = () => {},
    deleteEnvironment,
    saveEnvironment,
    discardEnvironment = () => {},
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
    renameEnvironment: (environmentId: string, name: string) => void | Promise<void>;
    setEnvironmentProtected?: (environmentId: string, isProtected: boolean) => void;
    setEnvironmentSandbox?: (environmentId: string, sandbox: boolean) => void;
    setEnvironmentColor?: (environmentId: string, color: EnvironmentColor | '') => void;
    setEnvironmentParent?: (environmentId: string, parentId: string) => void;
    deleteEnvironment: (environmentId: string) => void;
    saveEnvironment: () => void;
    discardEnvironment?: () => void;
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

  let nameInput = $state<HTMLInputElement>();
  let nameDraft = $state('');
  let nameEnvironmentId = $state('');
  let nameEditing = $state(false);

  $effect(() => {
    const id = activeEnvironment?.id ?? '';
    const name = activeEnvironment?.name ?? '';
    if (id !== nameEnvironmentId) {
      nameEnvironmentId = id;
      nameEditing = false;
      nameDraft = name;
    } else if (!nameEditing) nameDraft = name;
  });

  function focusName() {
    nameInput?.focus();
    nameInput?.select();
  }

  function commitName() {
    if (!nameEditing) return;
    const id = nameEnvironmentId;
    const name = nameDraft.trim();
    nameEditing = false;
    if (id && name) void renameEnvironment(id, name);
    else nameDraft = activeEnvironment?.name ?? '';
  }

  function onNameKeydown(event: KeyboardEvent) {
    if (event.key === 'F2') {
      event.preventDefault();
      event.stopPropagation();
      focusName();
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      commitName();
      nameInput?.blur();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      nameEditing = false;
      nameDraft = activeEnvironment?.name ?? '';
      nameInput?.blur();
    }
  }

  let moreMenuOpen = $state(false);
  let moreMenuRoot = $state<HTMLDivElement>();
  let moreMenuButton = $state<HTMLButtonElement>();
  let variableCount = $derived((activeEnvironment?.values ?? []).filter(row => row.key.trim()).length);
  let parent = $derived(activeEnvironment ? parentEnvironment(environments, activeEnvironment) : undefined);
  let protectedBy = $derived(activeEnvironment ? protectingAncestor(environments, activeEnvironment.id) : undefined);
  let parentOptions = $derived(activeEnvironment
    ? [{ value: '', label: 'Nothing' }, ...environmentParentCandidates(environments, activeEnvironment).map(environment => ({ value: environment.id, label: environment.name, color: environmentColorVar(environment) }))]
    : []);
  let inheritedRows = $derived.by(() => {
    if (!activeEnvironment || !parent) return [];
    const own = new Set(activeEnvironment.values.filter(row => row.enabled && row.key.trim()).map(row => row.key.trim()));
    return [...effectiveEnvironmentRows(environments, activeEnvironment.id).entries()]
      .filter(([key, item]) => !own.has(key) && item.sourceId !== activeEnvironment.id)
      .map(([key, item]) => ({ key, ...item }));
  });
  let revealedInherited = $state<Set<string>>(new Set());

  function toggleInheritedReveal(key: string) {
    revealedInherited = revealedInherited.has(key)
      ? new Set([...revealedInherited].filter(item => item !== key))
      : new Set([...revealedInherited, key]);
  }

  function closeMoreMenuOnFocusOut(event: FocusEvent) {
    const current = event.currentTarget;
    const next = event.relatedTarget;
    if (!(current instanceof HTMLElement)) return;
    if (!(next instanceof Node) || !current.contains(next)) moreMenuOpen = false;
  }

  function closeMoreMenuOnOutsidePointer(event: PointerEvent) {
    if (moreMenuOpen && event.target instanceof Node && !moreMenuRoot?.contains(event.target)) moreMenuOpen = false;
  }

  function closeMoreMenuOnEscape(event: KeyboardEvent) {
    if (!moreMenuOpen || event.key !== 'Escape') return;
    event.preventDefault();
    event.stopPropagation();
    moreMenuOpen = false;
    moreMenuButton?.focus();
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
    environmentView;
    moreMenuOpen = false;
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

<svelte:document onpointerdowncapture={closeMoreMenuOnOutsidePointer} onkeydowncapture={closeMoreMenuOnEscape} />

<section class="environment-workspace" class:matrix={showMatrix}>
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
          {workspaceVariableCount} {workspaceVariableCount === 1 ? 'variable' : 'variables'} across {environments.length} environments{activeName ? ` · ${shortName(activeName)} is in use` : ''}
          {#if environmentSaveState !== 'idle'}
            <span class="env-save-indicator" class:saved={environmentSaveState === 'saved'} class:dirty={environmentSaveState === 'dirty'}> · {environmentSaveState === 'saving' ? 'Saving…' : environmentSaveState === 'dirty' ? 'Unsaved changes' : 'Saved'}</span>
          {/if}
        </p>
      </div>
      <div class="overview-actions">
        {@render viewSwitch()}
        {#if !autosave}
          <SaveActions saveDirty={environmentSaveState === 'dirty'} canRevert={environmentSaveState === 'dirty'} disabled={environmentSaveState === 'saving'} onSave={saveEnvironment} onRevert={discardEnvironment} />
        {/if}
        <button class="btn btn-primary" type="button" onclick={addVariable}><AddCloseIcon add /> Variable</button>
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
        <h1 aria-label={activeEnvironment.name}>
          {#if activeEnvironment.color}<span class="env-color-dot env-title-color" style:--env-color={environmentColorVar(activeEnvironment)} aria-hidden="true"></span>{/if}
          <span class="env-name-fit" data-value={nameDraft}>
            <input class="request-title-input env-name" size="1" maxlength={NAME_MAX_LENGTH} bind:this={nameInput} bind:value={nameDraft} aria-label="Environment name" spellcheck="false" onfocus={() => { nameEditing = true; }} onblur={commitName} onkeydown={onNameKeydown} autocomplete="off" autocorrect="off" autocapitalize="none" />
          </span>
          {#if activeEnvironment.protected}
            <span class="env-protected"><MenuIcon name="lock" />Protected</span>
          {:else if protectedBy}
            <span class="env-protected"><MenuIcon name="lock" />Protected through {shortName(protectedBy.name)}</span>
          {:else if activeEnvironment.sandbox}
            <span class="env-protected env-sandbox"><MenuIcon name="play" />Sandbox</span>
          {/if}
        </h1>
        <p>
          {variableCount} {variableCount === 1 ? 'variable' : 'variables'}{#if parent}{` · ${inheritedRows.length} inherited from ${shortName(parent.name)}`}{/if} · use them in requests as {'{{variableName}}'}
          {#if environmentSaveState !== 'idle'}
            <span class="env-save-indicator" class:saved={environmentSaveState === 'saved'} class:dirty={environmentSaveState === 'dirty'}> · {environmentSaveState === 'saving' ? 'Saving…' : environmentSaveState === 'dirty' ? 'Unsaved changes' : 'Saved'}</span>
          {/if}
        </p>
      </div>
      <div class="overview-actions">
        {@render viewSwitch()}
        {#if !autosave}
          <SaveActions saveDirty={environmentSaveState === 'dirty'} canRevert={environmentSaveState === 'dirty'} disabled={environmentSaveState === 'saving'} onSave={saveEnvironment} onRevert={discardEnvironment} />
        {/if}
        <div class="env-more" bind:this={moreMenuRoot} onfocusout={closeMoreMenuOnFocusOut}>
          <button class="btn btn-ghost btn-icon env-more-btn" bind:this={moreMenuButton} type="button" aria-label="More environment actions" aria-haspopup="menu" aria-expanded={moreMenuOpen} onclick={() => (moreMenuOpen = !moreMenuOpen)}>•••</button>
          {#if moreMenuOpen}
            <div class="menu request-menu env-more-menu" role="menu">
              <button class="menu-item" type="button" role="menuitem" onclick={() => runMenuAction(focusName)}><MenuIcon name="rename" />Rename</button>
              <button class="menu-item" type="button" role="menuitemcheckbox" aria-checked={Boolean(activeEnvironment.protected || protectedBy)} disabled={Boolean(protectedBy && !activeEnvironment.protected)} onclick={() => runMenuAction(() => setEnvironmentProtected(activeEnvironment.id, !activeEnvironment.protected))}><MenuIcon name="lock" />{activeEnvironment.protected ? 'Unprotect from AI agents' : 'Protect from AI agents'}</button>
              <button class="menu-item" type="button" role="menuitemcheckbox" aria-checked={Boolean(activeEnvironment.sandbox)} disabled={Boolean(activeEnvironment.protected || protectedBy)} onclick={() => runMenuAction(() => setEnvironmentSandbox(activeEnvironment.id, !activeEnvironment.sandbox))}><MenuIcon name="play" />{activeEnvironment.sandbox ? 'Stop treating as a sandbox' : 'Sandbox for the agent'}</button>
              <div class="menu-separator" role="separator"></div>
              <div class="menu-label">Color</div>
              <div class="env-color-swatches" role="group" aria-label="Environment color">
                <button class="env-color-swatch env-color-swatch-none" type="button" role="menuitemradio" aria-checked={!activeEnvironment.color} aria-label="No color" onclick={() => runMenuAction(() => setEnvironmentColor(activeEnvironment.id, ''))}></button>
                {#each ENVIRONMENT_COLORS as color (color.value)}
                  <button class="env-color-swatch" type="button" role="menuitemradio" aria-checked={activeEnvironment.color === color.value} aria-label={color.label} style:--env-color={color.cssVar} onclick={() => runMenuAction(() => setEnvironmentColor(activeEnvironment.id, color.value))}></button>
                {/each}
              </div>
              <div class="menu-separator" role="separator"></div>
              <button class="menu-item" type="button" role="menuitem" onclick={() => runMenuAction(() => importEnvFromFile(activeEnvironment.id))}><MenuIcon name="import" />Import .env</button>
              <button class="menu-item" type="button" role="menuitem" onclick={() => runMenuAction(() => exportEnvironment(activeEnvironment.id))}><MenuIcon name="export" />Export…</button>
              <div class="menu-separator" role="separator"></div>
              <button class="menu-item danger" type="button" role="menuitem" onclick={() => runMenuAction(() => deleteEnvironment(activeEnvironment.id))}><MenuIcon name="trash" />Delete</button>
            </div>
          {/if}
        </div>
      </div>
    </div>
    {#if parentOptions.length > 1}
      <div class="env-parent">
        <span class="env-parent-label">Inherits from</span>
        <Select value={activeEnvironment.parentId ?? ''} options={parentOptions} className="env-parent-select" searchable={parentOptions.length > 8} searchPlaceholder="Search environments" ariaLabel="Inherits from" onChange={value => setEnvironmentParent(activeEnvironment.id, value)} />
        <span class="env-parent-hint">{parent ? `Variables not set here come from ${shortName(parent.name)}.` : 'Pick an environment to take the variables this one does not set.'}</span>
      </div>
    {/if}
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
        <div class="kv-row env-kv-row" data-testid="environment-variable-row" class:inactive-row={!row.enabled && (row.key || row.value || row.description)}>
          <input type="checkbox" class="check" checked={row.enabled} onchange={(event) => updateEnvironmentRow(activeEnvironment.id, i, { enabled: inputChecked(event) })} aria-label="Enable variable" disabled={!row.key && !row.value} />
          <input class="field field-bare kv-input" value={row.key} placeholder="Add variable" aria-label="Environment variable key" oninput={(event) => updateEnvironmentRow(activeEnvironment.id, i, { key: inputValue(event) })} spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="none" />
          <button
            class="env-type-toggle"
            class:secret={row.secret}
            type="button"
            onclick={() => updateEnvironmentRow(activeEnvironment.id, i, { secret: !row.secret })}
            disabled={!row.key && !row.value}
          >
            {row.secret ? 'Secret' : 'Default'}
          </button>
          <input class="field field-bare kv-input" type={row.secret ? 'password' : 'text'} value={row.value} placeholder="Value" aria-label="Environment variable value" oninput={(event) => updateEnvironmentRow(activeEnvironment.id, i, { value: inputValue(event) })} spellcheck="false" autocomplete="off" autocorrect="off" autocapitalize="none" />
          <input class="field field-bare kv-input kv-desc" value={row.description} placeholder="Description" aria-label="Environment variable description" oninput={(event) => updateEnvironmentRow(activeEnvironment.id, i, { description: inputValue(event) })} autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} />
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
      {#if inheritedRows.length}
        <div class="env-inherited-head">Inherited</div>
        {#each inheritedRows as item (item.key)}
          <div class="kv-row env-kv-row env-inherited-row" data-testid="environment-inherited-row">
            <span></span>
            <span class="env-inherited-key">{item.key}</span>
            {#if item.row.secret}
              <button class="env-type-toggle secret" type="button" onclick={() => toggleInheritedReveal(item.key)}>Secret</button>
            {:else}
              <span class="env-inherited-type">Default</span>
            {/if}
            <span class="env-inherited-value">{item.row.secret && !revealedInherited.has(item.key) ? '••••••••' : item.row.value || 'empty'}</span>
            <span class="env-inherited-source">
              <span>from {item.sourceName}</span>
              <button class="btn btn-ghost btn-sm" type="button" aria-label={`Override ${item.key} in ${activeEnvironment.name}`} onclick={() => setMatrixValue(activeEnvironment.id, item.key, item.row.value)}>Override</button>
            </span>
            <span></span>
          </div>
        {/each}
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

<style>
  .environment-workspace-head > .environment-title { flex: 1 1 auto; min-width: 0; }
  .environment-title h1 { display: flex; align-items: center; min-width: 0; }
  .environment-title p { overflow-wrap: anywhere; }
  .env-name-fit {
    display: inline-grid;
    flex: 0 1 auto;
    min-width: 0;
    margin-left: calc(var(--space-1-5) * -1);
  }
  .env-name-fit::after {
    content: attr(data-value) ' ';
    grid-area: 1 / 1;
    height: 0;
    padding: 0 var(--space-1-5);
    border: 1px solid transparent;
    overflow: hidden;
    visibility: hidden;
    white-space: pre;
  }
  .environment-title .env-name {
    grid-area: 1 / 1;
    width: 100%;
    min-width: 4rem;
    max-width: none;
    height: 2rem;
    font-size: inherit;
    font-weight: inherit;
    letter-spacing: inherit;
  }
  .environment-title h1 :global(.env-protected) {
    flex-shrink: 0;
  }
</style>
