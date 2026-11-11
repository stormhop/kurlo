<script lang="ts">
  import CodeEditor from '../CodeEditor.svelte';
  import BeautifyButton from './BeautifyButton.svelte';
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
      void vm.webSocketSendCurrentMessage();
    }
  }
</script>

<div class="body-section">
  <div class="body-editor-wrap ws-body-editor-wrap" role="presentation" onkeydown={onKeydown}>
    <div class="body-editor-toolbar ws-message-toolbar">
      <div class="raw-type-menu ws-type-menu">
        <button
          class="field field-sm select-trigger raw-type-button"
          class:open={vm.wsMessageTypeMenuOpen}
          type="button"
          onclick={() => (vm.wsMessageTypeMenuOpen = !vm.wsMessageTypeMenuOpen)}
        >
          {vm.webSocketMessageTypeLabel()}
          <svg width="0.625rem" height="0.375rem" viewBox="0 0 10 6" fill="none" aria-hidden="true">
            <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
        {#if vm.wsMessageTypeMenuOpen}
          <div class="menu raw-type-list ws-type-options" role="listbox">
            {#each WS_MESSAGE_TYPES as type, eachIndex (eachIndex)}
              <button class="menu-item"
                class:active={vm.webSocketMessageBodyType() === type}
                role="option"
                aria-selected={vm.webSocketMessageBodyType() === type}
                type="button"
                onclick={() => { vm.setWebSocketMessageBodyType(type); vm.wsMessageTypeMenuOpen = false; }}
              >
                <span class="method-check">{vm.webSocketMessageBodyType() === type ? '✓' : ''}</span>
                {vm.webSocketMessageTypeLabel(type)}
              </button>
            {/each}
          </div>
        {/if}
      </div>

      <BeautifyButton onbeautify={() => editorRef?.format()} beautified={vm.beautifiedBody} disabled={vm.bodyLang !== 'json'} title="Beautify message" />

      <div class="ws-message-actions">
        <SavedMessagesMenu connected={vm.webSocketConnected} />
        <button class="btn btn-secondary btn-sm toolbar-btn ws-toolbar-btn" type="button" disabled={!vm.webSocketConnected} onclick={() => vm.webSocketSendControl('ping')}>
          Ping
        </button>
        <button class="btn btn-primary btn-sm ws-message-send" type="button" disabled={!vm.webSocketConnected} onclick={vm.webSocketSendCurrentMessage}>
          Send
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
