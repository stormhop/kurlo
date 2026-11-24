<script lang="ts">
  import Select from './Select.svelte';
  import CodeEditor from '../CodeEditor.svelte';
  import BeautifyButton from './BeautifyButton.svelte';
  import RequestShortcutHint from './RequestShortcutHint.svelte';
  import SavedMessagesMenu from './SavedMessagesMenu.svelte';
  import { RAW_BODY_TYPES } from '../constants';
  import { vm } from '../stores/app.svelte';
  import type { RawBodyType } from '../types/models';

  type WebSocketMessageBodyType = RawBodyType | 'binary';

  const WS_MESSAGE_TYPES: WebSocketMessageBodyType[] = [...RAW_BODY_TYPES, 'binary'];

  let editorRef = $state<CodeEditor>();

  function onKeydown(event: KeyboardEvent) {
    if (vm.shortcutForEvent(event) === 'send-request') {
      event.preventDefault();
      event.stopPropagation();
      if (vm.webSocketConnected) void vm.webSocketSendCurrentMessage();
      else void vm.runActiveRequest();
    }
  }
</script>

<div class="body-section">
  <div class="body-editor-wrap ws-body-editor-wrap" class:connected-message-editor={vm.webSocketConnected} role="presentation" onkeydowncapture={onKeydown}>
    <div class="body-editor-toolbar ws-message-toolbar">
      <Select
        className="raw-type-menu ws-type-menu"
        size="sm"
        ariaLabel="Message type"
        value={vm.webSocketMessageBodyType()}
        options={WS_MESSAGE_TYPES.map(type => ({ value: type, label: vm.webSocketMessageTypeLabel(type) }))}
        onChange={type => vm.setWebSocketMessageBodyType(type as WebSocketMessageBodyType)}
      />

      <BeautifyButton onbeautify={() => editorRef?.format()} beautified={vm.beautifiedBody} disabled={vm.bodyLang !== 'json'} title="Beautify message" />

      <div class="ws-message-actions">
        <SavedMessagesMenu connected={vm.webSocketConnected} />
        <button class="btn btn-secondary btn-sm toolbar-btn ws-toolbar-btn" type="button" disabled={!vm.webSocketConnected} onclick={() => vm.webSocketSendControl('ping')}>
          Ping
        </button>
        <button class="btn btn-primary btn-sm ws-message-send" type="button" disabled={!vm.webSocketConnected} onclick={vm.webSocketSendCurrentMessage}>
          Send
          {#if vm.webSocketConnected}<RequestShortcutHint />{/if}
        </button>
      </div>
    </div>

    <CodeEditor
      bind:this={editorRef}
      bind:value={vm.bodyContent}
      language={vm.bodyLang}
      placeholder={vm.webSocketMessagePlaceholder()}
      fillHeight={true}
      compact={true}
      testId="websocket-message-editor"
      ariaLabel="WebSocket message editor"
      variableSuggestions={vm.variableSuggestions}
      onformat={vm.markBodyFormatted}
    />
  </div>
</div>
