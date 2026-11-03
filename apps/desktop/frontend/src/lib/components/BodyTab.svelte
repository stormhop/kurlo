<script lang="ts">
  import { rem } from '../uiScale';
  import { vm } from '../stores/app.svelte';
  import { guardTrailing, removeRow } from '../utils';
  import CodeEditor from '../CodeEditor.svelte';
  import VariableInput from './VariableInput.svelte';
  import BulkEditPanel from './BulkEditPanel.svelte';
  import { jsonKeyGhost, jsonKeySchema } from '../ghostText';

  let bodyEditorRef = $state<CodeEditor>();

  const bodyKeySchema = $derived(vm.bodyLang === 'json'
    ? jsonKeySchema(vm.requestExamples.map(example => example.snapshot.bodyContent))
    : new Map<string, string[]>());
  const bodyGhost = $derived(bodyKeySchema.size ? (doc: string, pos: number) => jsonKeyGhost(doc, pos, bodyKeySchema) : undefined);

  const FORM_TYPE_MENU_HEIGHT = 132;
  let formTypeMenuPos = $state({ top: 0, left: 0 });

  function portal(node: HTMLElement) {
    document.body.appendChild(node);
    return {
      destroy() {
        node.remove();
      },
    };
  }

  function openFormTypeMenu(rowId: number, event: MouseEvent) {
    const rect = (event.currentTarget as HTMLElement).getBoundingClientRect();
    const roomBelow = window.innerHeight - rect.bottom;
    formTypeMenuPos = {
      top: roomBelow >= FORM_TYPE_MENU_HEIGHT + 8
        ? rect.bottom + 4
        : Math.max(8, rect.top - FORM_TYPE_MENU_HEIGHT - 4),
      left: rect.left,
    };
    vm.toggleFormTypeMenu(rowId, event);
  }

  $effect(() => {
    const ref = bodyEditorRef;
    vm.registerBodyEditorFormat(ref ? () => ref.format() : null);
    return () => vm.registerBodyEditorFormat(null);
  });
</script>

<div class="body-section">
  {#if vm.bodyType === 'none'}
    <p class="body-none-hint">This request has no body.</p>

  {:else if vm.bodyType === 'form'}
    <div class="request-section-bar">
      <span class="request-section-title">Form data</span>
      <button class="btn btn-secondary btn-xs bulk-edit-toggle" type="button" aria-pressed={vm.bulkEditTables.form} onclick={() => (vm.bulkEditTables.form = !vm.bulkEditTables.form)}>
        {vm.bulkEditTables.form ? 'Key-value edit' : 'Bulk edit'}
      </button>
    </div>
    {#if vm.bulkEditTables.form}
      <BulkEditPanel
        rows={vm.formRows}
        apply={(next) => (vm.formRows = next)}
        hint="One key:value per line. Prefix a line with // to disable it. Attached files stay with their key."
      />
    {:else}
    <div class="kv-table form-kv-table headers-kv-table" style="--kw: {rem(vm.kvKeyW)}; --tw: {rem(vm.kvTypeW)}; --vw: {rem(vm.kvValW)}">
      <div class="kv-head form-kv-head">
        <span></span>
        <span class="kv-head-cell">Key</span>
        <span class="kv-head-cell">Type</span>
        <span class="kv-head-cell">Value</span>
        <span class="kv-head-cell">Description</span>
        <span></span>
      </div>
      <button class="kv-col-resizer kv-col-resizer--key" type="button" onmousedown={(e) => vm.startColResize('key', e)} aria-label="Resize key column"></button>
      <button class="kv-col-resizer kv-col-resizer--form-type" type="button" onmousedown={(e) => vm.startColResize('type', e)} aria-label="Resize type column"></button>
      <button class="kv-col-resizer kv-col-resizer--form-value" type="button" onmousedown={(e) => vm.startColResize('val', e)} aria-label="Resize value column"></button>
      {#each vm.formRows as row, i (row.id)}
        <div class="kv-row form-kv-row" class:inactive-row={!row.enabled && (row.key || row.value || row.description || row.isFile)}>
          <input type="checkbox" class="check" bind:checked={row.enabled} aria-label="Enable" disabled={!row.key && !row.value} />
          <VariableInput className="field field-bare kv-input" bind:value={row.key} suggestions={vm.variableSuggestions} placeholder="Key" oninput={() => guardTrailing(vm.formRows, i)} />
          <div class="form-type-cell">
            <div class="form-type-menu">
              <button
                class="field field-sm select-trigger form-type-trigger"
                type="button"
                onclick={(e) => openFormTypeMenu(row.id, e)}
                aria-label="Field type"
                aria-expanded={vm.openFormTypeMenuId === row.id}
              >
                <span>{row.isFile ? 'File' : 'Text'}</span>
                <svg width="0.5625rem" height="0.375rem" viewBox="0 0 9 6" fill="none" aria-hidden="true">
                  <path d="M1 1.4l3.5 3.2L8 1.4" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
              {#if vm.openFormTypeMenuId === row.id}
                <div class="menu form-type-options" use:portal style="top: {formTypeMenuPos.top}px; left: {formTypeMenuPos.left}px;">
                  <button class="menu-item" class:active={!row.isFile} type="button" onclick={() => vm.setFormRowKind(row, 'text', i)}>
                    <span class="form-type-check">{!row.isFile ? '✓' : ''}</span>
                    Text
                  </button>
                  <button class="menu-item" class:active={row.isFile} type="button" onclick={() => vm.setFormRowKind(row, 'file', i)}>
                    <span class="form-type-check">{row.isFile ? '✓' : ''}</span>
                    File
                  </button>
                  <div
                    class="form-type-content-type"
                    role="none"
                    onclick={(e) => e.stopPropagation()}
                    onkeydown={(e) => e.stopPropagation()}
                  >
                    <label for="form-part-type-{row.id}">Content-Type</label>
                    <input
                      id="form-part-type-{row.id}"
                      class="field field-bare kv-input"
                      bind:value={row.contentType}
                      placeholder={row.isFile ? 'application/octet-stream' : 'auto'}
                      oninput={() => guardTrailing(vm.formRows, i)}
                    />
                  </div>
                </div>
              {/if}
            </div>
          </div>
          {#if row.isFile}
            <button class="kv-file-value" type="button" onclick={() => vm.pickFileForRow(row, i)}>
              {#if row.value}
                <span class="kv-file-name">{row.fileName ?? row.value}</span>
              {:else}
                <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="M6.5 2v6.5M4 4.5L6.5 2 9 4.5M2.5 10.5h8" stroke="currentColor" stroke-width="1.35" stroke-linecap="round" stroke-linejoin="round"/></svg>
                Attach file
              {/if}
            </button>
          {:else}
            <VariableInput className="field field-bare kv-input" bind:value={row.value} suggestions={vm.variableSuggestions} placeholder="Value" oninput={() => guardTrailing(vm.formRows, i)} />
          {/if}
          <input class="field field-bare kv-input kv-desc" bind:value={row.description} placeholder="Description" />
          <button class="btn btn-ghost btn-icon btn-sm kv-del" type="button" onclick={() => removeRow(vm.formRows, i)} aria-label="Remove">✕</button>
        </div>
      {/each}
    </div>
    {/if}

  {:else if vm.bodyType === 'urlencoded'}
    <div class="request-section-bar">
      <span class="request-section-title">URL-encoded</span>
      <button class="btn btn-secondary btn-xs bulk-edit-toggle" type="button" aria-pressed={vm.bulkEditTables.form} onclick={() => (vm.bulkEditTables.form = !vm.bulkEditTables.form)}>
        {vm.bulkEditTables.form ? 'Key-value edit' : 'Bulk edit'}
      </button>
    </div>
    {#if vm.bulkEditTables.form}
      <BulkEditPanel rows={vm.formRows} apply={(next) => (vm.formRows = next)} />
    {:else}
    <div class="kv-table headers-kv-table" style="--kw: {rem(vm.kvKeyW)}; --vw: {rem(vm.kvValW)}">
      <div class="kv-head">
        <span></span>
        <span class="kv-head-cell">Key</span>
        <span class="kv-head-cell">Value</span>
        <span class="kv-head-cell">Description</span>
        <span></span>
      </div>
      <button class="kv-col-resizer kv-col-resizer--key" type="button" onmousedown={(e) => vm.startColResize('key', e)} aria-label="Resize key column"></button>
      <button class="kv-col-resizer kv-col-resizer--value" type="button" onmousedown={(e) => vm.startColResize('val', e)} aria-label="Resize value column"></button>
      {#each vm.formRows as row, i (row.id)}
        <div class="kv-row" class:inactive-row={!row.enabled && (row.key || row.value || row.description)}>
          <input type="checkbox" class="check" bind:checked={row.enabled} aria-label="Enable" disabled={!row.key && !row.value} />
          <VariableInput className="field field-bare kv-input" bind:value={row.key} suggestions={vm.variableSuggestions} placeholder="Key" oninput={() => guardTrailing(vm.formRows, i)} />
          <VariableInput className="field field-bare kv-input" bind:value={row.value} suggestions={vm.variableSuggestions} placeholder="Value" oninput={() => { row.isFile = false; row.fileName = undefined; guardTrailing(vm.formRows, i); }} />
          <input class="field field-bare kv-input kv-desc" bind:value={row.description} placeholder="Description" />
          <button class="btn btn-ghost btn-icon btn-sm kv-del" type="button" onclick={() => removeRow(vm.formRows, i)} aria-label="Remove">✕</button>
        </div>
      {/each}
    </div>
    {/if}

  {:else if vm.bodyType === 'binary'}
    <div class="binary-body">
      {#if vm.bodyFilePath}
        <div class="binary-file-info">
          <svg width="1rem" height="1rem" viewBox="0 0 16 16" fill="none"><rect x="2" y="1" width="10" height="13" rx="1.5" stroke="currentColor" stroke-width="1.3"/><path d="M5 5h5M5 8h5M5 11h3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          <span>{vm.bodyFileName}</span>
          <button class="btn btn-ghost btn-icon btn-sm kv-del" type="button" onclick={() => { vm.bodyFilePath = ''; vm.bodyFileName = ''; }}>✕</button>
        </div>
      {:else}
        <button class="btn btn-dashed btn-lg btn-file-pick" type="button" onclick={vm.pickBinaryFile}>
          <svg width="1rem" height="1rem" viewBox="0 0 16 16" fill="none"><path d="M8 2v8M5 5l3-3 3 3" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/><path d="M2 12h12" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
          Choose file…
        </button>
      {/if}
    </div>

  {:else}
    <div class="body-editor-wrap">
      <CodeEditor
        bind:this={bodyEditorRef}
        bind:value={vm.bodyContent}
        language={vm.bodyLang}
        placeholder={vm.requestBodyPlaceholder()}
        fillHeight={true}
        compact={true}
        testId="request-body-editor"
        ariaLabel="Request body editor"
        variableSuggestions={vm.variableSuggestions}
        onformat={vm.markBodyFormatted}
        ghost={bodyGhost}
      />
    </div>
  {/if}
</div>
