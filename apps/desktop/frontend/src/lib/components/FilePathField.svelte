<script lang="ts">
  import { inspectRequestFile, openFileDialog, revealRequestFile, type RequestFileInfo } from '../backend';
  import { addFileDropZone } from '../fileDrop';
  import { binaryContentType, fileBaseName, isRemoteFileSource, requestFileDetails, resolveFilePathTemplate } from '../filePathField';
  import { fileManagerLabel } from '../utils';
  import type { VariableSuggestion } from '../variables';
  import VariableInput from './VariableInput.svelte';

  let {
    value = $bindable(''),
    variant = 'field',
    dialogTitle = 'Select file',
    placeholder = 'path/to/file',
    ariaLabel = 'File path',
    disabled = false,
    keepAbsolute = false,
    allowUrl = false,
    checkFile = true,
    suggestions = [],
    contentTypeHeader = undefined,
    onUseContentType = undefined,
    onchange = undefined,
    testId = undefined,
  }: {
    value?: string;
    variant?: 'field' | 'panel';
    dialogTitle?: string;
    placeholder?: string;
    ariaLabel?: string;
    disabled?: boolean;
    keepAbsolute?: boolean;
    allowUrl?: boolean;
    checkFile?: boolean;
    suggestions?: VariableSuggestion[];
    contentTypeHeader?: string;
    onUseContentType?: (contentType: string) => void;
    onchange?: (value: string) => void;
    testId?: string;
  } = $props();

  let root = $state<HTMLElement>();
  let info = $state<RequestFileInfo | null>(null);
  let usesVariables = $state(false);
  let revealError = $state('');
  let inspectSeq = 0;

  const trimmed = $derived(value.trim());
  const remote = $derived(allowUrl && isRemoteFileSource(trimmed));
  const missing = $derived(Boolean(info && !info.exists));
  const details = $derived(info ? requestFileDetails(info) : '');
  const outsideWorkspace = $derived(Boolean(!keepAbsolute && info?.exists && !info.insideWorkspace));
  const revealLabel = fileManagerLabel();
  const contentType = $derived(variant === 'panel' ? binaryContentType(contentTypeHeader, info?.contentType) : null);

  $effect(() => {
    const current = trimmed;
    const list = suggestions;
    const seq = ++inspectSeq;
    revealError = '';
    if (!current || remote || !checkFile) {
      info = null;
      usesVariables = false;
      return;
    }
    const resolved = resolveFilePathTemplate(current, list);
    usesVariables = resolved.path !== current || resolved.unresolved;
    if (resolved.unresolved) {
      info = null;
      return;
    }
    const timer = setTimeout(async () => {
      const next = await inspectRequestFile(resolved.path);
      if (seq === inspectSeq) info = next;
    }, 150);
    return () => clearTimeout(timer);
  });

  $effect(() => {
    const element = root;
    if (!element || disabled) return;
    return addFileDropZone(element, paths => { void accept(paths[0]); });
  });

  function commit(next: string) {
    value = next;
    onchange?.(next);
  }

  async function accept(path: string | undefined) {
    if (!path || disabled) return;
    if (keepAbsolute) {
      commit(path);
      return;
    }
    const inspected = await inspectRequestFile(path);
    commit(inspected?.path || path);
  }

  async function choose() {
    const path = await openFileDialog(dialogTitle);
    await accept(path);
  }

  function clear() {
    commit('');
  }

  async function reveal() {
    revealError = await revealRequestFile(trimmed);
  }
</script>

{#if variant === 'panel'}
  <div class="file-panel" class:file-panel-empty={!trimmed} bind:this={root} data-testid={testId}>
    {#if !trimmed}
      <div class="file-drop" style="--wails-drop-target: drop">
        <svg class="file-drop-icon" width="1.75rem" height="1.75rem" viewBox="0 0 24 24" fill="none" aria-hidden="true">
          <path d="M12 15V4M7.5 8.5L12 4l4.5 4.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
          <path d="M4 14v4a2 2 0 002 2h12a2 2 0 002-2v-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
        <strong>Drop a file here</strong>
        <button class="btn btn-secondary" type="button" onclick={choose} {disabled}>Choose file…</button>
        <p class="file-drop-hint">Files in the workspace folder are saved with a relative path, so the request works on every machine.</p>
      </div>
    {:else}
      <div class="file-card" class:file-card-missing={missing} style="--wails-drop-target: drop">
        <div class="file-card-head">
          <svg class="file-card-icon" width="1.5rem" height="1.5rem" viewBox="0 0 24 24" fill="none" aria-hidden="true">
            <path d="M14 3H7a2 2 0 00-2 2v14a2 2 0 002 2h10a2 2 0 002-2V8l-5-5z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            <path d="M14 3v5h5" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
          </svg>
          <div class="file-card-copy">
            <strong class="file-card-name">{info?.name || fileBaseName(trimmed)}</strong>
            {#if missing}
              <span class="file-card-meta file-card-error" role="alert">{info?.error}</span>
            {:else if details}
              <span class="file-card-meta">{details}</span>
            {:else if usesVariables}
              <span class="file-card-meta">The path uses variables and is checked when you send.</span>
            {/if}
          </div>
          <div class="file-card-actions">
            <button class="btn btn-secondary btn-sm" type="button" onclick={choose} {disabled}>Replace…</button>
            {#if info?.exists && revealLabel}
              <button class="btn btn-ghost btn-sm" type="button" onclick={reveal}>{revealLabel}</button>
            {/if}
            <button class="btn btn-ghost btn-sm" type="button" onclick={clear} {disabled}>Remove</button>
          </div>
        </div>
        <VariableInput
          className="field field-mono file-path-input"
          bind:value
          {suggestions}
          {placeholder}
          {ariaLabel}
          {disabled}
          oninput={() => onchange?.(value)}
        />
        {#if info?.exists && info.error}
          <p class="file-card-note file-card-error">{info.error}</p>
        {/if}
        {#if outsideWorkspace}
          <p class="file-card-note">This file is outside the workspace folder, so the saved path only works on this computer.</p>
        {/if}
        {#if revealError}
          <p class="file-card-note file-card-error" role="alert">{revealError}</p>
        {/if}
        {#if contentType}
          <div class="file-card-type">
            <span>Sent as <code>{contentType.sent}</code>{contentType.fromHeader ? ' from the Content-Type header' : ''}</span>
            {#if contentType.suggestion && onUseContentType}
              <button class="btn btn-link btn-sm" type="button" onclick={() => onUseContentType?.(contentType.suggestion)}>Use {contentType.suggestion}</button>
            {/if}
          </div>
        {/if}
      </div>
    {/if}
  </div>
{:else}
  <div class="file-field" bind:this={root} style="--wails-drop-target: drop" data-testid={testId}>
    <div class="file-field-row">
      <VariableInput
        className="field field-mono file-path-input"
        bind:value
        {suggestions}
        {placeholder}
        {ariaLabel}
        {disabled}
        oninput={() => onchange?.(value)}
      />
      <button class="btn btn-secondary" type="button" onclick={choose} {disabled}>Choose file…</button>
      {#if trimmed}
        <button class="btn btn-ghost btn-icon" type="button" onclick={clear} {disabled} aria-label={`Clear ${ariaLabel.toLowerCase()}`}>
          <svg width="0.75rem" height="0.75rem" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="M3 3l6 6M9 3l-6 6" stroke="currentColor" stroke-width="1.4" stroke-linecap="round"/></svg>
        </button>
      {:else}
        <span class="btn btn-ghost btn-icon file-field-clear-slot" aria-hidden="true"></span>
      {/if}
    </div>
    {#if missing}
      <span class="file-field-meta file-card-error" role="alert">{info?.error}</span>
    {:else if details}
      <span class="file-field-meta">{details}</span>
    {/if}
    {#if outsideWorkspace}
      <span class="file-field-meta">Outside the workspace folder: this path only works on this computer.</span>
    {/if}
  </div>
{/if}
