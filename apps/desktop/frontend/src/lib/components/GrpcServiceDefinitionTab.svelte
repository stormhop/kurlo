<script lang="ts">
  import BirdSpinner from './BirdSpinner.svelte';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import { vm } from '../stores/app.svelte';

  let schemaValue = $derived(vm.grpcProtoFilePath);

  function inputValue(event: Event): string {
    const target = event.currentTarget;
    return target instanceof HTMLInputElement ? target.value : '';
  }

  function onSchemaInput(event: Event) {
    vm.setGrpcProtoFilePath(inputValue(event));
  }

  function onSchemaKeydown(event: KeyboardEvent) {
    if (event.key !== 'Enter') return;
    event.preventDefault();
    if (vm.grpcProtoFilePath.trim()) void vm.discoverGrpcServices();
  }

  function useReflection() {
    const methodCount = vm.grpcSelectableMethods().length;
    vm.grpcUseReflection = true;
    vm.grpcServiceError = '';
    vm.grpcServiceStatus = methodCount
      ? `${methodCount} method${methodCount === 1 ? '' : 's'} loaded`
      : '';
    vm.scheduleActiveRequestPersist();
    void vm.discoverGrpcServices();
  }
</script>

<div class="graphql-schema-panel graphql-schema-empty-panel">
  <div class="graphql-schema-import-wrap">
    <div class="graphql-schema-select-wrap">
      <div class="graphql-schema-select-row">
        <div class="graphql-schema-select-field">
          <input class="field"
            value={schemaValue}
            placeholder="Select a Protobuf schema or paste link to one"
            spellcheck="false"
            autocomplete="off"
            aria-label="Protobuf schema"
            oninput={onSchemaInput}
            onkeydown={onSchemaKeydown}
            autocorrect="off"
            autocapitalize="none"
          />
          <button
            class="btn btn-ghost btn-icon btn-sm graphql-select-toggle"
            type="button"
            aria-label="Choose protobuf schema"
            onclick={vm.importGrpcProtoFile}
            disabled={vm.grpcServiceLoading}
          >
            <svg width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none" aria-hidden="true">
              <path d="M3 5l4 4 4-4" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
        </div>
      </div>
    </div>

    <div class="graphql-import-link-row">
      <button
        class="btn-link graphql-import-link-btn"
        type="button"
        onclick={vm.importGrpcProtoFile}
        disabled={vm.grpcServiceLoading}
      >
        Import a .proto file
      </button>
    </div>

    {#if vm.grpcProtoFileName || vm.grpcProtoImportPaths.length}
      <div class="grpc-proto-summary">
        {#if vm.grpcProtoFileName}
          <div class="grpc-proto-row">
            <span class="grpc-proto-icon" aria-hidden="true">&lt;/&gt;</span>
            <span class="grpc-proto-name">{vm.grpcProtoFileName}</span>
            <button class="btn btn-ghost btn-icon btn-sm kv-del" type="button" onclick={vm.clearGrpcProtoFile} aria-label="Clear proto file">✕</button>
          </div>
        {/if}

        <div class="grpc-import-path-actions">
          <button class="btn btn-secondary btn-sm toolbar-btn" type="button" onclick={vm.addGrpcProtoImportPath} disabled={vm.grpcServiceLoading}>Add import path</button>
          {#if vm.grpcProtoFilePath.trim()}
            <button class="btn btn-secondary btn-sm toolbar-btn" type="button" onclick={vm.discoverGrpcServices} disabled={vm.grpcServiceLoading}>
              {#if vm.grpcServiceLoading}<BirdSpinner />{/if}
              Refresh proto
            </button>
          {/if}
        </div>

        {#if vm.grpcProtoImportPaths.length}
          <div class="grpc-import-paths">
            {#each vm.grpcProtoImportPaths as path, index (index)}
              <span class="grpc-import-path">
                {path}
                <button class="btn btn-ghost btn-icon btn-xs" type="button" onclick={() => vm.removeGrpcProtoImportPath(index)} aria-label="Remove import path"><AddCloseIcon /></button>
              </span>
            {/each}
          </div>
        {/if}
      </div>
    {/if}

    <div class="graphql-schema-or-row" aria-hidden="true">
      <span>or</span>
    </div>

    <div class="graphql-introspection-row">
      <button
        class="graphql-introspection-status"
        type="button"
        onclick={useReflection}
        disabled={vm.grpcServiceLoading}
      >
        {#if vm.grpcServiceLoading}
          <BirdSpinner />
        {:else}
          <span class="graphql-introspection-check" aria-hidden="true">
            <svg width="0.875rem" height="0.875rem" viewBox="0 0 14 14" fill="none">
              <path d="M3.2 7.1l2.4 2.4 5-5" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </span>
        {/if}
        {vm.grpcUseReflection ? 'Using server reflection.' : 'Use server reflection'}
      </button>
      <button
        class="btn btn-ghost btn-icon graphql-introspection-refresh"
        type="button"
        aria-label="Refresh server reflection"
        onclick={vm.discoverGrpcServices}
        disabled={vm.grpcServiceLoading || (!vm.grpcUseReflection && !vm.grpcProtoFilePath.trim())}
      >
        <svg width="1.125rem" height="1.125rem" viewBox="0 0 18 18" fill="none" aria-hidden="true">
          <path d="M14.5 8.2A5.6 5.6 0 0 0 4.2 5.5L3 7.2M3.5 3.6v3.6h3.6M3.5 9.8a5.6 5.6 0 0 0 10.3 2.7l1.2-1.7M14.5 14.4v-3.6h-3.6" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>

    {#if vm.grpcServiceError}
      <div class="grpc-service-alert error">{vm.grpcServiceError}</div>
    {:else if vm.grpcServiceStatus}
      <span class="graphql-schema-status graphql-schema-status--standalone">
        {vm.grpcServiceStatus}{#if vm.grpcServiceDefinition.source} · {vm.grpcServiceDefinition.source}{/if}
      </span>
    {/if}
  </div>
</div>

<style>
  .grpc-proto-summary {
    display: flex;
    flex-direction: column;
    gap: var(--space-2);
    padding: var(--space-2-5);
    border: 1px solid var(--border-subtle);
    border-radius: var(--radius-lg);
    background: var(--surface);
  }

  .grpc-proto-row {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--space-2-5);
  }

  .grpc-proto-icon {
    color: var(--head);
    font-family: var(--font-mono);
    font-size: var(--text-label);
    font-weight: var(--weight-semibold);
  }

  .grpc-proto-name,
  .grpc-import-path {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .grpc-proto-name {
    color: var(--text);
    font-size: var(--text-label);
    font-weight: var(--weight-semibold);
  }

  .grpc-import-path-actions,
  .grpc-import-paths {
    display: flex;
    flex-wrap: wrap;
    gap: var(--space-1-5);
  }

  .grpc-import-path {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1-5);
    max-width: min(100%, 26.25rem);
    min-height: 1.625rem;
    padding: 0 var(--space-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-md);
    background: var(--elevated);
    color: var(--text-2);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }


  .grpc-service-alert {
    padding: var(--space-2-5) var(--space-3);
    border-radius: var(--radius-lg);
    border: 1px solid var(--danger-border);
    background: var(--danger-bg);
    color: var(--danger);
    font-size: var(--text-label);
    line-height: var(--leading-tight);
  }
</style>
