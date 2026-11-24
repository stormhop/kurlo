<script module lang="ts">
  import { autocompletion } from '@codemirror/autocomplete';
  import { search, searchKeymap } from '@codemirror/search';
  import { EditorView, keymap } from '@codemirror/view';

  const fileExtensions = [
    search({ top: true }), keymap.of(searchKeymap), EditorView.lineWrapping,
    autocompletion({ activateOnCompletion: option => option.type === 'property' }),
  ];
</script>

<script lang="ts">
  import { onDestroy, untrack } from 'svelte';
  import CodeEditor from '../CodeEditor.svelte';
  import BeautifyButton from './BeautifyButton.svelte';
  import BirdLoader from './BirdLoader.svelte';
  import { Prec } from '@codemirror/state';
  import { checkWorkspaceYAML, formatRequestFileYAML } from '../backend';
  import { readRequestFileBar, releaseRequestFileBarCache } from '../requestFileBar';
  import { requestFileEditor } from '../requestFileEditor';
  import { requestYamlCompletion } from '../requestYamlCompletion';
  import type { RequestFileDraft } from '../requestFileDraft.svelte';

  let { draft }: { draft: RequestFileDraft } = $props();
  let lineEnding = $derived(draft.content.includes('\r\n') ? '\r\n' : '\n');
  let validationSequence = 0;
  let managedHint = $state('');
  const yamlEditor = requestFileEditor(() => draft.savedContent, message => { managedHint = message; });

  let editor = $state<{ applyFormattedText: (text: string) => boolean }>();
  let formatting = $state(false);
  let destroyed = false;
  onDestroy(() => {
    destroyed = true;
    releaseRequestFileBarCache();
  });
  type FileIssue = { draft: RequestFileDraft; content: string; message: string; line?: number };
  let validationIssue = $state<FileIssue | null>(null);
  let formatIssue = $state<FileIssue | null>(null);
  let invalid = $derived(validationIssue?.draft === draft && validationIssue.content === draft.content ? validationIssue : null);
  let formatError = $derived(!invalid && formatIssue?.draft === draft && formatIssue.content === draft.content ? formatIssue : null);
  let fileError = $derived(invalid && draft.errorLine && !draft.readFailed ? '' : draft.error);

  async function formatFile() {
    if (formatting || draft.loading || draft.saving || !draft.ready) return;
    const target = draft;
    const content = target.content;
    const generation = target.documentGeneration;
    formatting = true;
    try {
      const result = await formatRequestFileYAML(content);
      if (destroyed || target !== draft || target.content !== content || target.documentGeneration !== generation || target.saving) return;
      if (result.ok) {
        formatIssue = null;
        if (result.content !== content) editor?.applyFormattedText(result.content.replace(/\r\n/g, '\n'));
      } else {
        formatIssue = { draft: target, content, message: result.error || 'Could not format YAML.', line: result.line };
      }
    } catch (error) {
      if (!destroyed && target === draft && target.documentGeneration === generation && target.content === content) {
        formatIssue = { draft: target, content, message: String(error) };
      }
    } finally {
      formatting = false;
    }
  }

  const formatKey = Prec.high(keymap.of([{ key: 'Alt-Shift-f', stopPropagation: true, run: () => { void formatFile(); return true; } }]));

  async function validate(text: string) {
    if (!draft.dirty) {
      draft.clearValidationError();
      return null;
    }
    const target = draft;
    const content = draft.content;
    const sequence = ++validationSequence;
    const path = draft.path;
    const result = await checkWorkspaceYAML(path, text);
    if (destroyed || sequence !== validationSequence || target !== draft || content !== draft.content || path !== draft.path) return null;
    validationIssue = result.ok ? null : { draft: target, content, message: result.message, line: result.line };
    if (result.ok) draft.clearValidationError();
    return result.ok ? null : { line: result.line, message: result.message };
  }

  $effect(() => {
    const target = draft;
    if (!target.needsBarIndex) return;
    const content = target.content;
    let worker: Worker | undefined;
    const timer = setTimeout(() => {
      try {
        worker = new Worker(new URL('../requestFileBar.worker.ts', import.meta.url), { type: 'module' });
        worker.onmessage = event => target.acceptBarIndex(content, event.data);
        worker.onerror = () => {
          if (target.content === content) target.acceptBarIndex(content, readRequestFileBar(content, { includeRanges: true }));
        };
        worker.postMessage(content);
      } catch {
        target.acceptBarIndex(content, readRequestFileBar(content, { includeRanges: true }));
      }
    }, 100);
    return () => {
      clearTimeout(timer);
      worker?.terminate();
    };
  });

  $effect(() => {
    const currentDraft = draft;
    managedHint = '';
    formatIssue = null;
    validationIssue = null;
    void untrack(() => currentDraft.open());
    return () => currentDraft.releaseBarIndex();
  });
</script>

<section class="file-tab" aria-label="Request file">
  <div class="file-tab-toolbar">
    <div class="file-tab-location">
      <svg width="0.875rem" height="0.875rem" viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3 1.75h6l4 4v8.5H3z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round" />
        <path d="M9 1.75v4h4M5.5 8.5h5M5.5 11h5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round" />
      </svg>
      <span>{draft.path || 'Request file'}</span>
    </div>
    <div class="file-tab-actions">
      {#if draft.dirty}
        <span class="file-tab-dirty" aria-label="Unsaved changes">Unsaved changes</span>
      {:else if draft.ready && !draft.loading && !draft.error && !draft.conflicted}
        <span class="file-tab-saved">Saved</span>
      {/if}
      <BeautifyButton onbeautify={formatFile} title="Beautify YAML" disabled={!draft.ready || draft.loading || draft.saving || formatting} busy={formatting} />
      <button class="btn btn-secondary btn-xs" type="button" onclick={() => draft.discard()} disabled={!draft.canRevert || draft.saving || draft.loading}>Revert</button>
      <button class="btn btn-primary btn-xs" type="button" onclick={() => draft.save()} disabled={!draft.dirty || !!invalid || formatting || draft.saving || draft.loading || draft.conflicted} aria-busy={draft.saving}>
        {draft.saving ? 'Saving…' : 'Save'}
      </button>
    </div>
  </div>

  {#if draft.conflicted}
    <div class="file-tab-notice file-tab-conflict" role="alert">
      <div>
        <strong>This file changed on disk.</strong>
        <span>Your edits are still here. Choose which version to keep.</span>
      </div>
      <div class="file-tab-notice-actions">
        <button class="btn btn-secondary btn-xs" type="button" onclick={() => draft.reloadRemote()} disabled={draft.loading || draft.saving}>Reload from disk</button>
        <button class="btn btn-secondary btn-xs" type="button" onclick={() => draft.keepLocalChanges()} disabled={draft.loading || draft.saving || draft.remoteRevision === undefined}>Keep my edits</button>
      </div>
    </div>
    <details class="file-tab-disk-version">
      <summary>View version on disk</summary>
      <pre>{draft.remoteContent ?? 'Read the current disk version before choosing which changes to keep.'}</pre>
    </details>
  {/if}

  {#if draft.loading && !draft.ready}
    <div class="file-tab-editor-state"><BirdLoader label="Loading request file" /></div>
  {:else if managedHint || formatError || fileError || draft.barIssue}
    <div class="file-tab-feedback" class:over-editor={draft.ready}>
      {#if draft.barIssue}<div class="file-tab-managed-hint" role="alert">{draft.barIssue}</div>{/if}
      {#if managedHint}<div class="file-tab-managed-hint" role="status">{managedHint}</div>{/if}
      {#if formatError || fileError}
        <div class="file-tab-notice file-tab-error" role="alert">
          <div>
            <strong>{formatError?.message ?? fileError}</strong>
            {#if formatError?.line ?? draft.errorLine}<span>Line {formatError?.line ?? draft.errorLine}</span>{/if}
          </div>
          {#if draft.readFailed}
            <button class="btn btn-secondary btn-xs" type="button" onclick={() => draft.open()} disabled={draft.loading}>Retry</button>
          {/if}
        </div>
      {/if}
    </div>
  {/if}

  {#if draft.ready}
    <div class="file-tab-editor" class:editor-loading={draft.loading}>
      {#key draft}
        {#key draft.documentGeneration}
          <CodeEditor
            bind:this={editor}
            bind:value={() => draft.content.replace(/\r\n?/g, '\n'), value => draft.edit(lineEnding === '\n' ? value.replace(/\r\n?/g, '\n') : value.replace(/\r\n?/g, '\n').replace(/\n/g, lineEnding))}
            editorExtensions={[fileExtensions, yamlEditor, formatKey]}
            language="yaml"
            completionSource={requestYamlCompletion}
            includeVariableCompletions
            fillHeight={true}
            compact={true}
            testId="request-file-editor"
            ariaLabel="Request file YAML editor"
            {validate}
          />
        {/key}
      {/key}
    </div>
  {:else if !draft.loading && !draft.error}
    <div class="file-tab-editor-state" role="status">The request file is not ready to edit.</div>
  {/if}
</section>

<style>
  .file-tab {
    position: relative;
    display: flex;
    flex: 1;
    flex-direction: column;
    min-width: 0;
    min-height: 0;
    overflow: hidden;
    container-type: inline-size;
  }

  .file-tab-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    min-height: 2.5rem;
    padding: 0 var(--space-3);
    border-bottom: 1px solid var(--border);
  }

  .file-tab-location,
  .file-tab-actions,
  .file-tab-notice-actions {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    min-width: 0;
  }

  .file-tab-location {
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }

  .file-tab-location span {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .file-tab-actions {
    flex-shrink: 0;
  }

  .file-tab-dirty,
  .file-tab-saved {
    color: var(--text-3);
    font-size: var(--text-caption);
  }

  .file-tab-dirty {
    color: var(--warning);
  }

  .file-tab-editor {
    display: flex;
    flex: 1;
    min-height: 0;
  }

  .file-tab-editor :global(.cm-wrap) {
    flex: 1;
    min-height: 0;
  }

  .file-tab-editor :global(.cm-content),
  .file-tab-editor :global(.cm-line) {
    box-sizing: border-box;
    max-width: 100%;
    min-width: 0;
  }

  .file-tab-editor :global(.cm-line) {
    overflow-wrap: anywhere;
    word-break: normal;
  }

  .file-tab-editor.editor-loading {
    opacity: 0.65;
  }

  .file-tab-editor :global(.cm-kurlo-field-lock) {
    display: inline-block;
    width: 0.75rem;
    height: 0.75rem;
    margin-inline: var(--space-1) var(--space-0-5);
    vertical-align: -0.1em;
    background: var(--text-3);
    mask: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16' fill='none' stroke='black' stroke-width='1.4'%3E%3Crect x='3.5' y='7' width='9' height='7' rx='1.5'/%3E%3Cpath d='M5.5 7V5a2.5 2.5 0 0 1 5 0v2'/%3E%3C/svg%3E") center / contain no-repeat;
  }

  .file-tab-managed-hint {
    padding: var(--space-2) var(--space-3);
    background: var(--elevated);
    color: var(--text-2);
    font-size: var(--text-caption);
  }

  .file-tab-feedback.over-editor {
    position: absolute;
    z-index: 2;
    inset: auto var(--space-2) var(--space-2) auto;
    max-width: calc(100% - 2 * var(--space-2));
    overflow: hidden;
    overflow-wrap: anywhere;
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--surface);
    pointer-events: none;
  }

  .file-tab-feedback.over-editor button {
    pointer-events: auto;
  }

  .file-tab-feedback.over-editor .file-tab-notice {
    border-bottom: 0;
  }

  .file-tab-editor-state {
    display: grid;
    flex: 1;
    min-height: 0;
    place-items: center;
    color: var(--text-2);
    font-size: var(--text-caption);
  }

  .file-tab-disk-version {
    border-bottom: 1px solid var(--border);
    color: var(--text-2);
    font-size: var(--text-caption);
  }

  .file-tab-disk-version summary {
    padding: var(--space-2) var(--space-3);
    cursor: pointer;
  }

  .file-tab-disk-version pre {
    max-height: 10rem;
    overflow: auto;
    margin: 0;
    padding: 0 var(--space-3) var(--space-3);
    color: var(--text);
    font-family: var(--font-mono);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    user-select: text;
    -webkit-user-select: text;
  }

  .file-tab-notice {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-3);
    border-bottom: 1px solid var(--border);
    font-size: var(--text-caption);
  }

  .file-tab-notice > div:first-child {
    display: flex;
    flex-direction: column;
    gap: var(--space-1);
  }

  .file-tab-notice span {
    color: var(--text-2);
  }

  .file-tab-conflict {
    background: var(--warning-bg);
  }

  .file-tab-error {
    background: var(--danger-bg);
    color: var(--danger-text);
  }

  @container (max-width: 34rem) {
    .file-tab-toolbar {
      align-items: flex-start;
      flex-direction: column;
      padding-block: var(--space-2);
    }

    .file-tab-actions {
      width: 100%;
      justify-content: flex-end;
    }

    .file-tab-notice {
      align-items: flex-start;
      flex-direction: column;
    }
  }
</style>
