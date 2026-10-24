<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import { docsReference, type DocsReferenceRow } from '../docsReference';
  import { methodColor } from '../utils';
  import Markdown from './Markdown.svelte';

  let editing = $state(false);
  let requestId = $state('');
  let textarea = $state<HTMLTextAreaElement>();

  $effect(() => {
    if (vm.activeRequestId === requestId) return;
    requestId = vm.activeRequestId;
    editing = !vm.requestNotes.trim();
  });

  const reference = $derived(docsReference({
    requestType: vm.requestType,
    method: vm.method,
    url: vm.url,
    params: vm.params,
    pathParams: vm.pathParams,
    headers: vm.reqHeaders,
    bodyType: vm.bodyType,
    rawBodyType: vm.rawBodyType,
    bodyContent: vm.bodyContent,
    formRows: vm.formRows,
    graphqlQuery: vm.graphqlQuery,
    authType: vm.authType,
  }));

  async function edit() {
    editing = true;
    await Promise.resolve();
    textarea?.focus();
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && vm.requestNotes.trim()) {
      event.preventDefault();
      editing = false;
    }
  }
</script>

{#snippet table(title: string, rows: DocsReferenceRow[])}
  {#if rows.length}
    <section class="docs-ref-section">
      <h4 class="docs-ref-title">{title}</h4>
      <div class="docs-ref-table">
        {#each rows as row, index (index)}
          <div class="docs-ref-row">
            <span class="docs-ref-key">{row.key}</span>
            <span class="docs-ref-value">{row.value}</span>
            {#if row.description}<span class="docs-ref-desc">{row.description}</span>{/if}
          </div>
        {/each}
      </div>
    </section>
  {/if}
{/snippet}

<div class="docs-tab" class:docs-editing={editing}>
  <div class="docs-toolbar">
    <div class="segmented" role="radiogroup" aria-label="Docs view">
      <button class="segmented-item" type="button" role="radio" aria-checked={!editing} class:active={!editing} onclick={() => (editing = false)}>Preview</button>
      <button class="segmented-item" type="button" role="radio" aria-checked={editing} class:active={editing} onclick={edit}>Edit</button>
    </div>
    <span class="docs-hint">Markdown: # headings, **bold**, `code`, lists, tables, [links](https://…), images.</span>
  </div>

  <div class="docs-body">
    {#if editing}
      <textarea
        class="docs-textarea"
        bind:this={textarea}
        bind:value={vm.requestNotes}
        onkeydown={onKeydown}
        aria-label="Docs"
        placeholder={'# What this request does\n\nWhen to call it, what it needs, example responses, edge cases, links.'}
        spellcheck="false"
      ></textarea>
    {/if}

    <div class="docs-preview" aria-label="Docs preview">
      {#if vm.requestNotes.trim()}
        <Markdown source={vm.requestNotes} remoteImages />
      {:else if !editing}
        <div class="docs-empty">
          <p>No docs for this request yet.</p>
          <button class="btn btn-secondary btn-sm" type="button" onclick={edit}>Write docs</button>
        </div>
      {:else}
        <p class="docs-empty-preview">The preview appears here as you type.</p>
      {/if}

      {#if !editing}
        <div class="docs-ref">
          <div class="docs-ref-endpoint">
            <span class="docs-ref-method {methodColor(reference.method)}">{reference.method}</span>
            <span class="docs-ref-url">{reference.url || 'No URL yet'}</span>
          </div>
          {#if reference.auth}<p class="docs-ref-auth">Auth · {reference.auth}</p>{/if}
          {@render table('Path parameters', reference.pathParams)}
          {@render table('Query parameters', reference.params)}
          {@render table('Headers', reference.headers)}
          {#if reference.body}
            <section class="docs-ref-section">
              <h4 class="docs-ref-title">Body <span class="docs-ref-badge">{reference.body.label}</span></h4>
              {#if reference.body.rows.length}
                {@render table('', reference.body.rows)}
              {:else}
                <pre class="docs-ref-code">{reference.body.text}</pre>
              {/if}
            </section>
          {/if}
        </div>
      {/if}
    </div>
  </div>
</div>

<style>
  .docs-tab {
    container-type: inline-size;
    display: flex;
    flex-direction: column;
    flex: 1;
    height: 100%;
    min-height: 0;
  }
  .docs-toolbar {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    padding: var(--space-2) var(--space-4);
    border-bottom: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }
  .docs-hint {
    min-width: 0;
    overflow: hidden;
    color: var(--text-3);
    font-size: var(--text-caption);
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .docs-tab:not(.docs-editing) .docs-hint {
    visibility: hidden;
  }
  .docs-body {
    display: flex;
    flex: 1;
    min-height: 0;
  }
  .docs-textarea {
    flex: 1 1 50%;
    min-width: 0;
    padding: var(--space-3) var(--space-4);
    border: 0;
    border-right: 1px solid var(--border-subtle);
    outline: none;
    resize: none;
    background: transparent;
    color: var(--text);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    line-height: var(--leading-relaxed);
    caret-color: var(--accent);
  }
  .docs-textarea::placeholder {
    color: var(--text-3);
  }
  .docs-preview {
    flex: 1 1 50%;
    min-width: 0;
    padding: var(--space-4) var(--space-5) var(--space-6);
    overflow: auto;
  }
  .docs-tab:not(.docs-editing) .docs-preview > :global(.md) {
    max-width: 48rem;
  }
  .docs-empty {
    display: flex;
    align-items: center;
    gap: var(--space-3);
    color: var(--text-2);
    font-size: var(--text-body);
  }
  .docs-empty p,
  .docs-empty-preview {
    margin: 0;
  }
  .docs-empty-preview {
    color: var(--text-3);
    font-size: var(--text-label);
  }
  .docs-ref {
    max-width: 48rem;
    margin-top: var(--space-6);
    padding-top: var(--space-4);
    border-top: 1px solid var(--border-subtle);
  }
  .docs-ref-endpoint {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    user-select: text;
  }
  .docs-ref-method {
    flex: 0 0 auto;
    font-weight: var(--weight-semibold);
  }
  .docs-ref-url {
    min-width: 0;
    color: var(--text);
    overflow-wrap: anywhere;
  }
  .docs-ref-auth {
    margin: var(--space-2) 0 0;
    color: var(--text-3);
    font-size: var(--text-label);
  }
  .docs-ref-section {
    margin-top: var(--space-4);
  }
  .docs-ref-section .docs-ref-section {
    margin-top: 0;
  }
  .docs-ref-title {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    margin: 0 0 var(--space-1-5);
    color: var(--text-2);
    font-size: var(--text-label);
    font-weight: var(--weight-semibold);
  }
  .docs-ref-title:empty {
    display: none;
  }
  .docs-ref-badge {
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
    font-weight: var(--weight-regular);
  }
  .docs-ref-table {
    border-top: 1px solid var(--border-subtle);
  }
  .docs-ref-row {
    display: grid;
    grid-template-columns: minmax(8rem, 14rem) minmax(0, 1fr);
    column-gap: var(--space-4);
    row-gap: var(--space-0-5);
    padding: var(--space-1-5) 0;
    border-bottom: 1px solid var(--border-subtle);
    font-size: var(--text-label);
    user-select: text;
  }
  .docs-ref-key {
    color: var(--text);
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
  .docs-ref-value {
    color: var(--text-2);
    font-family: var(--font-mono);
    overflow-wrap: anywhere;
  }
  .docs-ref-desc {
    grid-column: 2;
    color: var(--text-3);
  }
  .docs-ref-code {
    margin: 0;
    max-height: 18rem;
    padding: var(--space-2-5) var(--space-3);
    overflow: auto;
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-md);
    background: var(--surface);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-code);
    line-height: var(--leading-relaxed);
    user-select: text;
  }
  @container (max-width: 40rem) {
    .docs-editing .docs-preview {
      display: none;
    }
  }
</style>
