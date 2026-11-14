<script lang="ts">
  import BirdSpinner from './BirdSpinner.svelte';
  import { vm } from '../stores/app.svelte';
  import CodeEditor from '../CodeEditor.svelte';

  let schemaUrl = $state('');
  let fileInput = $state<HTMLInputElement | undefined>(undefined);
  let showImportPanel = $state(false);
  let importPanelUrl = $state('');

  let schemaLanguage = $derived(
    (vm.graphqlSchema.trim().startsWith('{') || vm.graphqlSchema.trim().startsWith('[')
      ? 'json'
      : 'graphql') as 'json' | 'graphql'
  );

  async function importUrl() {
    if (!schemaUrl.trim()) return;
    await vm.importGraphQLSchemaFromUrl(schemaUrl);
  }

  async function importFile() {
    if (window.go?.api?.App?.OpenFileDialog && window.go?.api?.App?.ReadTextFile) {
      await vm.importGraphQLSchemaFromFile();
      showImportPanel = false;
      return;
    }
    fileInput?.click();
  }

  async function importPanelUrlSubmit() {
    if (!importPanelUrl.trim()) return;
    await vm.importGraphQLSchemaFromUrl(importPanelUrl);
    showImportPanel = false;
    importPanelUrl = '';
  }

  function onImportPanelUrlKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') void importPanelUrlSubmit();
    if (event.key === 'Escape') showImportPanel = false;
  }

  async function onBrowserFileChange(event: Event) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    if (!file) return;
    vm.importGraphQLSchemaText(await file.text(), `Imported ${file.name}`);
    input.value = '';
  }

  function onUrlKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter' && schemaUrl.trim()) void importUrl();
  }
</script>

{#if vm.graphqlSchema}

  <div class="graphql-schema-panel">
    <div class="graphql-schema-loaded-toolbar">
      <span class="graphql-schema-loaded-title">Schema</span>
      {#if vm.graphqlSchemaStatus}
        <span class="graphql-schema-status">{vm.graphqlSchemaStatus}</span>
      {/if}
      <div class="graphql-schema-loaded-actions">
        <button
          class="btn btn-secondary"
          type="button"
          onclick={() => vm.fetchGraphQLSchema()}
          disabled={vm.graphqlSchemaLoading || !vm.url.trim()}
        >
          {#if vm.graphqlSchemaLoading}<BirdSpinner />{/if}
          Refresh introspection
        </button>
        <button
          class="btn btn-secondary"
          type="button"
          onclick={() => vm.clearGraphQLSchema()}
        >Clear</button>
      </div>
    </div>
    {#if vm.graphqlSchemaError}
      <div class="graphql-schema-error-card" role="alert">
        <div class="graphql-schema-error-header">
          <svg class="graphql-schema-error-icon" width="1.125rem" height="1.125rem" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M9 1L17 9L9 17L1 9L9 1Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
            <path d="M9 6v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
            <circle cx="9" cy="12.5" r="0.9" fill="currentColor"/>
          </svg>
          <span class="graphql-schema-error-title">Could not load GraphQL schema.</span>
        </div>
        <p class="graphql-schema-error-detail">{vm.graphqlSchemaError}</p>
      </div>
    {/if}
    <CodeEditor
      bind:value={vm.graphqlSchema}
      language={schemaLanguage}
      placeholder={'type Query { viewer: User }'}
      fillHeight={true}
      compact={true}
      variableSuggestions={vm.variableSuggestions}
    />
  </div>
{:else}

  <div class="graphql-schema-panel graphql-schema-empty-panel">
    <div class="graphql-schema-import-wrap">


      {#if vm.graphqlSchemaError}
        <div class="graphql-schema-error-card" role="alert">
          <div class="graphql-schema-error-header">
            <svg class="graphql-schema-error-icon" width="1.125rem" height="1.125rem" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M9 1L17 9L9 17L1 9L9 1Z" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/>
              <path d="M9 6v4" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/>
              <circle cx="9" cy="12.5" r="0.9" fill="currentColor"/>
            </svg>
            <span class="graphql-schema-error-title">Could not load GraphQL schema.</span>
          </div>
          <p class="graphql-schema-error-detail">{vm.graphqlSchemaError}</p>
          <button
            class="btn btn-secondary btn-danger btn-sm graphql-schema-error-retry"
            type="button"
            onclick={() => vm.fetchGraphQLSchema()}
            disabled={vm.graphqlSchemaLoading}
          >
            {#if vm.graphqlSchemaLoading}<BirdSpinner />{/if}
            Try again
          </button>
        </div>
      {/if}


      {#if !showImportPanel}
        <div class="graphql-schema-select-wrap">
          <div class="graphql-schema-select-row">
            <div class="graphql-schema-select-field">
              <input class="field"
                bind:value={schemaUrl}
                placeholder="Select a schema or paste link to one"
                spellcheck="false"
                autocomplete="off"
                onkeydown={onUrlKeydown}
                autocorrect="off"
                autocapitalize="none"
              />
              <button
                class="btn btn-ghost btn-icon btn-sm graphql-select-toggle"
                type="button"
                aria-label="Import pasted GraphQL schema URL"
                onclick={importUrl}
                disabled={!schemaUrl.trim() || vm.graphqlSchemaLoading}
              >
                <svg width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none" aria-hidden="true">
                  <path d="M3 5l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
              </button>
            </div>
            {#if schemaUrl.trim()}
              <button
                class="btn btn-primary"
                type="button"
                onclick={importUrl}
                disabled={vm.graphqlSchemaLoading}
              >
                {#if vm.graphqlSchemaLoading}<BirdSpinner />{/if}
                Import
              </button>
            {/if}
          </div>
        </div>
      {/if}

      <div class="graphql-import-link-row">
        <button
          class="btn-link graphql-import-link-btn"
          type="button"
          onclick={() => (showImportPanel = !showImportPanel)}
          disabled={vm.graphqlSchemaLoading}
        >
          Import a GraphQL schema
        </button>
      </div>

      {#if showImportPanel}
        <div class="graphql-import-panel">
          <p class="graphql-import-panel-hint">Import from your local system or from the URL where it's hosted.</p>
          <div class="graphql-import-panel-row">
            <button
              class="btn btn-secondary"
              type="button"
              onclick={importFile}
              disabled={vm.graphqlSchemaLoading}
            >Choose a file</button>
            <span class="graphql-import-panel-or">or</span>
            <input
              class="field field-md graphql-import-panel-url"
              bind:value={importPanelUrl}
              placeholder="Enter a URL"
              spellcheck="false"
              autocomplete="off"
              onkeydown={onImportPanelUrlKeydown}
              autocorrect="off"
              autocapitalize="none"
            />
            {#if importPanelUrl.trim()}
              <button
                class="btn btn-primary"
                type="button"
                onclick={importPanelUrlSubmit}
                disabled={vm.graphqlSchemaLoading}
              >Import</button>
            {/if}
          </div>
        </div>
      {/if}

      <div class="graphql-schema-or-row" aria-hidden="true">
        <span>or</span>
      </div>


      <div class="graphql-introspection-row">
        <button
          class="graphql-introspection-status"
          type="button"
          onclick={() => vm.fetchGraphQLSchema()}
          disabled={vm.graphqlSchemaLoading}
        >
          {#if vm.graphqlSchemaLoading}
            <BirdSpinner />
          {:else}
            <span class="graphql-introspection-check" aria-hidden="true">
              <svg width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none">
                <path d="M3.2 7.1l2.4 2.4 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
              </svg>
            </span>
          {/if}
          Using GraphQL introspection.
        </button>
        <button
          class="btn btn-ghost btn-icon graphql-introspection-refresh"
          type="button"
          aria-label="Refresh GraphQL introspection"
          onclick={() => vm.fetchGraphQLSchema()}
          disabled={vm.graphqlSchemaLoading}
        >
          <svg width="1.125rem" height="1.125rem" viewBox="0 0 18 18" fill="none" aria-hidden="true">
            <path d="M14.5 8.2A5.6 5.6 0 0 0 4.2 5.5L3 7.2M3.5 3.6v3.6h3.6M3.5 9.8a5.6 5.6 0 0 0 10.3 2.7l1.2-1.7M14.5 14.4v-3.6h-3.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>

      {#if vm.graphqlSchemaStatus && !vm.graphqlSchemaError}
        <span class="graphql-schema-status graphql-schema-status--standalone">{vm.graphqlSchemaStatus}</span>
      {/if}
    </div>

    <input
      bind:this={fileInput}
      class="visually-hidden-file"
      type="file"
      accept=".graphql,.gql,.json,.txt,application/json,text/plain"
      onchange={onBrowserFileChange}
    />
  </div>
{/if}
