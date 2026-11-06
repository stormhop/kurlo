<script lang="ts" module>
  import { rem } from '../uiScale';
  let autoHeadersOpen = $state(false);
</script>

<script lang="ts">
  import { onMount } from 'svelte';
  import { vm } from '../stores/app.svelte';
  import { guardTrailing, removeRow, activeCount } from '../utils';
  import { HEADER_PICKER_NAMES, validateHeaderRow } from '../headers';
  import VariableInput from './VariableInput.svelte';
  import BulkEditPanel from './BulkEditPanel.svelte';
  import type { KVRow, PreviewHeader } from '../types/models';

  type HeaderDetail = {
    kind: 'auto' | 'custom';
    key: string;
    note: string;
    rowIndex: number | null;
  };

  let headerDetail = $state<HeaderDetail | null>(null);
  let headerDetailValue = $state('');
  let headerDetailTop = $state(0);
  let headerDetailLeft = $state(0);
  let headerDetailWidth = $state(420);
  let tableEl = $state<HTMLDivElement>();
  let headerPopoverEl = $state<HTMLDivElement>();
  let headerDetailTextarea = $state<HTMLTextAreaElement>();
  let headerTemplateValues = $derived(vm.environmentValuesForRequest(vm.snapshotActiveRequest()));

  onMount(() => {
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (!headerDetail) return;
      const target = event.target;
      if (target instanceof Node && headerPopoverEl?.contains(target)) return;
      closeHeaderDetail();
    };

    document.addEventListener('pointerdown', closeOnOutsidePointer, true);
    return () => document.removeEventListener('pointerdown', closeOnOutsidePointer, true);
  });

  function positionHeaderDetail(anchor: HTMLElement | null) {
    if (!anchor || !tableEl) {
      headerDetailTop = 48;
      headerDetailLeft = 48;
      headerDetailWidth = 420;
      return;
    }

    const tableRect = tableEl.getBoundingClientRect();
    const anchorRect = anchor.getBoundingClientRect();
    const row = anchor.closest('.kv-row');
    const rowRect = row instanceof HTMLElement ? row.getBoundingClientRect() : anchorRect;
    const scrollerCandidate = anchor.closest('.tab-content');
    const scroller = scrollerCandidate instanceof HTMLElement ? scrollerCandidate : null;
    const scrollerRect = scroller?.getBoundingClientRect();
    const visibleLeft = scrollerRect ? scrollerRect.left - tableRect.left + 8 : 8;
    const visibleRight = scroller ? visibleLeft + scroller.clientWidth - 16 : tableRect.width - 8;
    const maxVisibleWidth = Math.max(280, visibleRight - visibleLeft);
    const desiredWidth = Math.min(680, maxVisibleWidth, Math.max(360, anchorRect.width));
    const left = anchorRect.left - tableRect.left;

    headerDetailTop = Math.max(32, rowRect.top - tableRect.top - 1);
    headerDetailLeft = Math.max(visibleLeft, Math.min(left, visibleRight - desiredWidth));
    headerDetailWidth = desiredWidth;
  }

  function openHeaderDetail(detail: HeaderDetail, value: string, anchor: HTMLElement | null = null) {
    if (!value) return;
    headerDetail = detail;
    headerDetailValue = value;
    positionHeaderDetail(anchor);
    setTimeout(() => {
      if (!headerDetailTextarea) return;
      headerDetailTextarea.scrollLeft = 0;
      headerDetailTextarea.scrollTop = 0;
    }, 0);
  }

  function maybeOpenCustomHeaderDetail(row: KVRow, index: number, anchor: HTMLElement | null = null) {
    if (!anchor || anchor.scrollWidth <= anchor.clientWidth) return;
    openHeaderDetail({ kind: 'custom', key: row.key || 'Header value', note: 'custom header', rowIndex: index }, row.value, anchor);
  }

  function maybeOpenCustomHeaderDetailFromEvent(row: KVRow, index: number, event: MouseEvent) {
    const target = event.currentTarget;
    maybeOpenCustomHeaderDetail(row, index, target instanceof HTMLElement ? target : null);
  }

  function maybeOpenAutoHeaderDetail(header: PreviewHeader, event: MouseEvent) {
    const target = event.currentTarget;
    if (!(target instanceof HTMLElement) || target.scrollWidth <= target.clientWidth) return;
    openHeaderDetail(
      { kind: 'auto', key: header.key, note: header.overridden ? 'overridden by custom header' : header.note, rowIndex: null },
      header.value,
      target,
    );
  }

  function textAreaValue(event: Event): string {
    const target = event.currentTarget;
    return target instanceof HTMLTextAreaElement ? target.value : '';
  }

  function headerValidationMessage(row: KVRow, field: 'key' | 'value') {
    const issue = validateHeaderRow({
      ...row,
      key: vm.resolveTemplate(row.key, headerTemplateValues),
      value: vm.resolveTemplate(row.value, headerTemplateValues),
    });
    return issue?.field === field ? issue.message : '';
  }

  function updateHeaderDetailValue(value: string) {
    headerDetailValue = value;
    if (headerDetail?.kind === 'custom' && headerDetail.rowIndex !== null) {
      vm.reqHeaders[headerDetail.rowIndex].value = value;
      guardTrailing(vm.reqHeaders, headerDetail.rowIndex);
    }
  }

  function closeHeaderDetail() {
    headerDetail = null;
    headerDetailValue = '';
  }

  function onHeaderDetailKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      closeHeaderDetail();
    }
  }
</script>

<div class="request-section-bar">
  <span class="request-section-title">Headers</span>
  <span class="request-section-meta">{activeCount(vm.reqHeaders)} custom · {vm.autoRequestHeaders.length} auto</span>
  <button
    class="btn btn-secondary btn-xs bulk-edit-toggle"
    type="button"
    aria-pressed={vm.bulkEditTables.headers}
    onclick={() => (vm.bulkEditTables.headers = !vm.bulkEditTables.headers)}
  >
    {vm.bulkEditTables.headers ? 'Key-value edit' : 'Bulk edit'}
  </button>
</div>
{#if vm.bulkEditTables.headers}
  <BulkEditPanel rows={vm.reqHeaders} apply={(next) => (vm.reqHeaders = next)} />
{:else}
<div class="kv-table headers-kv-table" bind:this={tableEl} style="--kw: {rem(vm.kvKeyW)}; --vw: {rem(vm.kvValW)}">
  <div class="kv-head">
    <span></span>
    <span class="kv-head-cell">Key</span>
    <span class="kv-head-cell">Value</span>
    <span class="kv-head-cell">Description</span>
    <span></span>
  </div>
  <button class="kv-col-resizer kv-col-resizer--key" type="button" onmousedown={(e) => vm.startColResize('key', e)} aria-label="Resize key column"></button>
  <button class="kv-col-resizer kv-col-resizer--value" type="button" onmousedown={(e) => vm.startColResize('val', e)} aria-label="Resize value column"></button>
  {#if vm.autoRequestHeaders.length}
    <button class="kv-auto-toggle" type="button" aria-expanded={autoHeadersOpen} onclick={() => (autoHeadersOpen = !autoHeadersOpen)}>
      <svg class:open={autoHeadersOpen} width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true"><path d="M3.5 2L6.5 5L3.5 8" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
      {vm.autoRequestHeaders.length} {vm.autoRequestHeaders.length === 1 ? 'header' : 'headers'} added by Kurlo
      <span class="kv-auto-toggle-keys">{vm.autoRequestHeaders.filter(h => !h.overridden).map(h => h.key).join(', ')}</span>
    </button>
  {/if}
  {#each autoHeadersOpen ? vm.autoRequestHeaders : [] as header, eachIndex (eachIndex)}
    <div class="kv-row kv-row--auto" class:kv-row--overridden={header.overridden}>
      <span class="kv-auto-badge"><svg width="0.6875rem" height="0.6875rem" viewBox="0 0 12 12" fill="none" aria-hidden="true"><rect x="2.5" y="5.2" width="7" height="5" rx="1.2" stroke="currentColor" stroke-width="1.1"/><path d="M4 5.2V3.9a2 2 0 014 0v1.3" stroke="currentColor" stroke-width="1.1"/></svg><span class="sr-only">Added by Kurlo</span></span>
      <span class="kv-cell kv-auto-key">{header.key}</span>
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <span
        class="kv-cell kv-auto-value kv-value-open"
        ondblclick={(event) => maybeOpenAutoHeaderDetail(header, event)}
      >
        {header.value}
      </span>
      <span class="kv-cell kv-auto-note">{header.overridden ? 'overridden by custom header' : header.note}</span>
      <span></span>
    </div>
  {/each}
  {#each vm.reqHeaders as row, i (row.id)}
    <div class="kv-row" data-testid="request-header-row" class:inactive-row={!row.enabled && (row.key || row.value || row.description)}>
      <input type="checkbox" class="check" bind:checked={row.enabled} aria-label="Enable" disabled={!row.key && !row.value} />
      <VariableInput
        className="field field-bare kv-input"
        bind:value={row.key}
        suggestions={vm.variableSuggestions}
        placeholder="Key"
        pickerOptions={HEADER_PICKER_NAMES}
        pickerLabel="Header names"
        validationMessage={headerValidationMessage(row, 'key')}
        oninput={() => { guardTrailing(vm.reqHeaders, i); vm.onHeaderKeyInput(row); }}
      />
      <VariableInput
        className="field field-bare kv-input kv-value-input"
        bind:value={row.value}
        suggestions={vm.variableSuggestions}
        placeholder="Value"
        pickerOptions={vm.headerValueSuggestions}
        pickerLabel="Header values"
        validationMessage={headerValidationMessage(row, 'value')}
        oninput={() => guardTrailing(vm.reqHeaders, i)}
        onfocus={() => { vm.onHeaderKeyInput(row); }}
        ondblclick={(event) => maybeOpenCustomHeaderDetailFromEvent(row, i, event)}
      />
      <input class="field field-bare kv-input kv-desc" bind:value={row.description} placeholder="Description" />
      <button class="btn btn-ghost btn-icon btn-sm kv-del" type="button" onclick={() => removeRow(vm.reqHeaders, i)} aria-label="Remove">✕</button>
    </div>
  {/each}

  {#if headerDetail}
    <div
      class="header-value-popover"
      bind:this={headerPopoverEl}
      style="--hv-top: {headerDetailTop}px; --hv-left: {headerDetailLeft}px; --hv-width: {headerDetailWidth}px"
      role="dialog"
      aria-label="{headerDetail.key} full value"
    >
      <textarea class="field field-area"
        bind:this={headerDetailTextarea}
        value={headerDetailValue}
        readonly={headerDetail.kind === 'auto'}
        spellcheck="false"
        wrap="soft"
        aria-label="Full header value"
        oninput={(event) => updateHeaderDetailValue(textAreaValue(event))}
        onkeydown={onHeaderDetailKeydown}
      ></textarea>
    </div>
  {/if}
</div>
{/if}
