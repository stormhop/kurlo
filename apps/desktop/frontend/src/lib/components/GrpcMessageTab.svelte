<script lang="ts">
  import CodeEditor from '../CodeEditor.svelte';
  import BeautifyButton from './BeautifyButton.svelte';
  import RequestShortcutHint from './RequestShortcutHint.svelte';
  import { DEFAULT_GRPC_MESSAGE } from '../requestBodyDefaults';
  import { vm } from '../stores/app.svelte';

  let editorRef = $state<CodeEditor>();
  let selectedMethod = $derived(vm.grpcServiceDefinition.methods.find(method => method.fullName === vm.grpcMethod));
  let stream = $derived(vm.grpcStreamState());
  let streamOpen = $derived(stream?.status === 'open');
  let clientStreaming = $derived(Boolean(selectedMethod?.clientStreaming || stream));

  function onKeydown(event: KeyboardEvent) {
    if (vm.shortcutForEvent(event) === 'send-request') {
      event.preventDefault();
      event.stopPropagation();
      if (streamOpen) void vm.grpcStreamSendCurrentMessage();
      else void vm.invokeGrpc();
    }
  }
</script>

<div class="body-section">
  <div class="body-editor-wrap grpc-message-editor-wrap" class:connected-message-editor={streamOpen} role="presentation" onkeydowncapture={onKeydown}>
    <div class="body-editor-toolbar grpc-message-toolbar">
      <span class="grpc-message-format" role="note" aria-label="Message format">JSON</span>

      <BeautifyButton onbeautify={() => editorRef?.format()} beautified={vm.beautifiedBody} title="Beautify message" />

      <div class="grpc-message-actions">
        <button class="btn btn-secondary btn-sm toolbar-btn" type="button" onclick={vm.useGrpcExampleMessage}>
          Use example message
        </button>
        {#if clientStreaming}
          <button class="btn btn-secondary btn-sm toolbar-btn" type="button" disabled={!streamOpen} onclick={vm.grpcStreamEnd} data-testid="grpc-stream-end">
            End stream
          </button>
          <button class="btn btn-primary btn-sm grpc-stream-send" type="button" disabled={!streamOpen} onclick={vm.grpcStreamSendCurrentMessage} data-testid="grpc-stream-send">
            Send
            {#if streamOpen}<RequestShortcutHint />{/if}
          </button>
        {/if}
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
  .grpc-message-format {
    display: inline-flex;
    align-items: center;
    height: var(--control-sm);
    padding: 0 var(--space-2);
    color: var(--text-2);
    font-size: var(--text-label);
    font-weight: var(--weight-medium);
  }

  .grpc-message-actions {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    flex-shrink: 0;
    margin-left: auto;
  }

  .grpc-message-editor-wrap {
    min-height: 0;
  }
</style>
