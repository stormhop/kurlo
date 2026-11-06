<script lang="ts">
  import { onMount } from 'svelte';
  import { vm } from '../stores/app.svelte';
  import CodeEditor from '../CodeEditor.svelte';
  import BeautifyButton from './BeautifyButton.svelte';
  import { bodyPlaceholder } from '../bodyTemplates';
  import { rem, toLogicalPx } from '../uiScale';

  let queryGridRef: HTMLDivElement | undefined = undefined;
  let queryEditor: { format: () => boolean } | undefined = undefined;
  let fileInput = $state<HTMLInputElement | undefined>(undefined);
  let explorerWidth = $state(420);
  let fields = $derived(vm.graphQLExplorerFields);


  type ActivePanel = 'query' | 'variables';
  let activePanel = $state<ActivePanel>('query');

  const TOOLBAR_H = 38;
  const MIN_EXPLORER_WIDTH = 320;
  const MIN_EDITOR_WIDTH = 320;
  const MAX_EXPLORER_WIDTH = 560;

  let editorStackStyle = $derived(
    activePanel === 'query'
      ? `grid-template-rows: minmax(0, 1fr) ${rem(TOOLBAR_H)}`
      : `grid-template-rows: ${rem(TOOLBAR_H)} minmax(0, 1fr)`
  );

  onMount(() => {
    if (!queryGridRef) return;
    const width = toLogicalPx(queryGridRef.getBoundingClientRect().width);
    explorerWidth = Math.round(Math.min(Math.max(width * 0.38, MIN_EXPLORER_WIDTH), MAX_EXPLORER_WIDTH));
  });

  function startExplorerResize(event: PointerEvent) {
    if (!queryGridRef) return;
    event.preventDefault();
    const rect = queryGridRef.getBoundingClientRect();
    const max = Math.max(MIN_EXPLORER_WIDTH, Math.min(MAX_EXPLORER_WIDTH, toLogicalPx(rect.width) - MIN_EDITOR_WIDTH));
    const move = (next: PointerEvent) => {
      explorerWidth = Math.round(Math.min(Math.max(toLogicalPx(next.clientX - rect.left), MIN_EXPLORER_WIDTH), max));
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.classList.remove('graphql-resizing');
    };
    document.body.classList.add('graphql-resizing');
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up, { once: true });
  }

  function beautifyQuery() {
    if (!queryEditor?.format()) vm.beautifyGraphQLQuery();
  }

  function useGraphQLIntrospection() {
    void vm.fetchGraphQLSchema();
  }

  async function importGraphQLSchemaFile() {
    if (window.go?.api?.App?.OpenFileDialog && window.go?.api?.App?.ReadTextFile) {
      await vm.importGraphQLSchemaFromFile();
      return;
    }
    fileInput?.click();
  }

  async function onBrowserFileChange(event: Event) {
    const input = event.currentTarget;
    if (!(input instanceof HTMLInputElement)) return;
    const file = input.files?.[0];
    if (!file) return;
    vm.importGraphQLSchemaText(await file.text(), `Imported ${file.name}`);
    input.value = '';
  }
</script>

<div
  class="graphql-query-grid"
  bind:this={queryGridRef}
  style={`--graphql-explorer-width: ${rem(explorerWidth)};`}
>
  <aside class="graphql-explorer-panel">
    {#if fields.length}
      <div class="graphql-explorer-toolbar">
        <span>Explore</span>
        <button class="btn btn-secondary" type="button" onclick={() => vm.fetchGraphQLSchema()} disabled={vm.graphqlSchemaLoading || !vm.url.trim()}>
          {#if vm.graphqlSchemaLoading}<span class="spinner spinner-inline"></span>{/if}
          Refresh
        </button>
      </div>
      <div class="graphql-explorer-list">
        {#each fields as field (field.name)}
          <button
            class="graphql-explorer-field"
            type="button"
            onclick={() => vm.applyGraphQLExplorerField(field)}
          >
            <span class="graphql-field-main">
              <span class="graphql-field-name">{field.name}</span>
              <span class="graphql-field-type">{field.type}</span>
            </span>
            {#if field.args.length}
              <span class="graphql-field-args">
                {field.args.map(arg => `${arg.name}: ${arg.type}`).join(', ')}
              </span>
            {/if}
          </button>
        {/each}
      </div>
    {:else}
      <div class="graphql-explorer-empty">
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
              onclick={useGraphQLIntrospection}
              disabled={vm.graphqlSchemaLoading}
            >
              {#if vm.graphqlSchemaLoading}<span class="spinner spinner-inline"></span>{/if}
              Try again
            </button>
          </div>
        {/if}
        <div class="graphql-explorer-empty-main">
          <strong>Explore what the server offers</strong>
          <button
            class="graphql-explorer-introspection-link"
            type="button"
            onclick={useGraphQLIntrospection}
            disabled={vm.graphqlSchemaLoading}
          >
            {#if vm.graphqlSchemaLoading}
              <span class="spinner spinner-inline"></span>
            {:else}
              <svg width="1.25rem" height="1.25rem" viewBox="0 0 20 20" fill="none" aria-hidden="true">
                <path d="M10 3v3M10 14v3M3 10h3M14 10h3M5.8 5.8l2.1 2.1M12.1 12.1l2.1 2.1M14.2 5.8l-2.1 2.1M7.9 12.1l-2.1 2.1" stroke="currentColor" stroke-width="1.7" stroke-linecap="round"/>
                <circle cx="10" cy="10" r="2.6" stroke="currentColor" stroke-width="1.7"/>
              </svg>
            {/if}
            Use GraphQL introspection
          </button>
          {#if vm.graphqlSchemaStatus && !vm.graphqlSchemaError}
            <span class="graphql-schema-status">{vm.graphqlSchemaStatus}</span>
          {/if}
        </div>
        <div class="graphql-explorer-empty-footer">
          <button class="graphql-explorer-footer-action" type="button" onclick={() => (vm.requestTab = 'schema')}>
            <svg width="1.125rem" height="1.125rem" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M5 2.5h5l3 3v10H5v-13Z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
              <path d="M10 2.5v3h3M7 9h4M7 12h4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Use a GraphQL spec
          </button>
          <button class="graphql-explorer-footer-action" type="button" onclick={importGraphQLSchemaFile} disabled={vm.graphqlSchemaLoading}>
            <svg width="1.125rem" height="1.125rem" viewBox="0 0 18 18" fill="none" aria-hidden="true">
              <path d="M6.5 3h6a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-8a2 2 0 0 1-2-2V7" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
              <path d="M3 3h3v3M3 3l5 5M11.5 6.5v4h-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
            Import a GraphQL schema
          </button>
        </div>
      </div>
    {/if}
    <input
      bind:this={fileInput}
      class="visually-hidden-file"
      type="file"
      accept=".graphql,.gql,.json,.txt,application/json,text/plain"
      onchange={onBrowserFileChange}
    />
  </aside>

  <button
    class="graphql-column-resizer"
    type="button"
    aria-label="Resize GraphQL explorer"
    onpointerdown={startExplorerResize}
  ></button>

  <section class="graphql-editor-stack" style={editorStackStyle}>

    <section
      class="graphql-editor-panel graphql-editor-panel--query"
      class:collapsed={activePanel !== 'query'}
    >
      <div class="graphql-panel-toolbar">
        <button
          class="graphql-panel-tab-btn"
          class:active={activePanel === 'query'}
          type="button"
          onclick={() => { activePanel = 'query'; }}
        >Query editor</button>
        {#if activePanel === 'query'}
          <BeautifyButton onbeautify={beautifyQuery} />
        {/if}
        <button
          class="btn btn-ghost btn-icon btn-sm graphql-panel-toggle"
          type="button"
          aria-label={activePanel === 'query' ? 'Collapse query editor' : 'Expand query editor'}
          onclick={() => { activePanel = activePanel === 'query' ? 'variables' : 'query'; }}
        >
          <svg
            class="graphql-chevron"
            class:open={activePanel === 'query'}
            width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none" aria-hidden="true"
          >
            <path d="M3 5l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div class="graphql-editor-body">
        <CodeEditor
          bind:this={queryEditor}
          bind:value={vm.graphqlQuery}
          language="graphql"
          placeholder={bodyPlaceholder('graphql')}
          fillHeight={true}
          compact={true}
          testId="graphql-query-editor"
          ariaLabel="GraphQL query editor"
          variableSuggestions={vm.variableSuggestions}
        />
      </div>
    </section>


    <section
      class="graphql-editor-panel graphql-editor-panel--variables"
      class:collapsed={activePanel !== 'variables'}
    >
      <div class="graphql-panel-toolbar">
        <button
          class="graphql-panel-tab-btn"
          class:active={activePanel === 'variables'}
          type="button"
          onclick={() => { activePanel = 'variables'; }}
        >Variables</button>
        <button
          class="btn btn-ghost btn-icon btn-sm graphql-panel-toggle"
          type="button"
          aria-label={activePanel === 'variables' ? 'Collapse variables' : 'Expand variables'}
          onclick={() => { activePanel = activePanel === 'variables' ? 'query' : 'variables'; }}
        >
          <svg
            class="graphql-chevron"
            class:open={activePanel === 'variables'}
            width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none" aria-hidden="true"
          >
            <path d="M3 5l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
          </svg>
        </button>
      </div>
      <div class="graphql-editor-body">
        <CodeEditor
          bind:value={vm.graphqlVariables}
          language="json"
          placeholder={bodyPlaceholder('json', 'variables')}
          fillHeight={true}
          compact={true}
          testId="graphql-variables-editor"
          ariaLabel="GraphQL variables editor"
          variableSuggestions={vm.variableSuggestions}
        />
      </div>
    </section>
  </section>
</div>
