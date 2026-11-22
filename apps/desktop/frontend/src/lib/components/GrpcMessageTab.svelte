<script lang="ts">
  import CodeEditor from '../CodeEditor.svelte';
  import BeautifyButton from './BeautifyButton.svelte';
  import { DEFAULT_GRPC_MESSAGE } from '../requestBodyDefaults';
  import { vm } from '../stores/app.svelte';

  let editorRef = $state<CodeEditor>();
  let selectedMethod = $derived(vm.grpcServiceDefinition.methods.find(method => method.fullName === vm.grpcMethod));

  function onKeydown(event: KeyboardEvent) {
    if (vm.shortcutForEvent(event) === 'send-request') {
      event.preventDefault();
      event.stopPropagation();
      void vm.invokeGrpc();
    }
  }
</script>

<div class="body-section">
  <div class="body-editor-wrap grpc-message-editor-wrap" role="presentation" onkeydowncapture={onKeydown}>
    <div class="body-editor-toolbar grpc-message-toolbar">
      <div class="grpc-method-summary">
        {#if selectedMethod}
          <strong>{selectedMethod.name}</strong>
          <span>{selectedMethod.requestType} -> {selectedMethod.responseType}</span>
        {:else if vm.grpcMethod}
          <strong>{vm.grpcMethod}</strong>
          <span>Selected method</span>
        {:else}
          <strong>Message</strong>
        {/if}
      </div>

      <div class="grpc-message-actions">
        <button class="btn btn-secondary btn-sm toolbar-btn" type="button" onclick={vm.useGrpcExampleMessage}>
          Use example message
        </button>
        <BeautifyButton onbeautify={() => editorRef?.format()} beautified={vm.beautifiedBody} disabled={vm.bodyLang !== 'json'} title="Beautify message" />
      </div>
    </div>

    <CodeEditor
      bind:this={editorRef}
      bind:value={vm.bodyContent}
      language="json"
      placeholder={DEFAULT_GRPC_MESSAGE}
      fillHeight={true}
      compact={true}
      testId="grpc-message-editor"
      ariaLabel="gRPC message editor"
      variableSuggestions={vm.variableSuggestions}
      onformat={vm.markBodyFormatted}
    />
  </div>
</div>

<style>
  .grpc-message-toolbar {
    justify-content: space-between;
    gap: var(--space-2-5);
  }

  .grpc-message-actions {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    flex-shrink: 0;
  }

  .grpc-method-summary {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    min-width: 0;
    margin-right: auto;
  }

  .grpc-method-summary strong {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text);
    font-size: var(--text-label);
    font-weight: var(--weight-semibold);
  }

  .grpc-method-summary span {
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    color: var(--text-3);
    font-family: var(--font-mono);
    font-size: var(--text-caption);
  }

  .grpc-message-editor-wrap {
    min-height: 0;
  }
</style>
