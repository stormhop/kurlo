<script lang="ts">
  import BirdSpinner from './BirdSpinner.svelte';
  import { NAME_MAX_LENGTH } from '../constants';
  import { onMount } from 'svelte';
  import RequestShortcutHint from './RequestShortcutHint.svelte';
  import SaveActions from './SaveActions.svelte';
  import type { RequestFileDraft } from '../requestFileDraft.svelte';
  import VariableInput from './VariableInput.svelte';
  import { urlGhost, urlGhostCandidates } from '../ghostText';
  import AiModelPicker from './AiModelPicker.svelte';
  import { aiConnectionsStore } from '../stores/aiConnections.svelte';
  import { vm } from '../stores/app.svelte';
  import { aiEndpointParts } from '../stores/features/ai';
  import type { VariableSuggestion } from '../variables';
  import type { GrpcMethodInfo, RequestType, SSEStatus, WebSocketStatus, SocketIOStatus } from '../types/models';


  let {
    codePanelOpen = $bindable(false),
    codePanelAvailable = false,
    requestName,
    requestLocation = '',
    fileDraft,
    showSave = false,
    saveDirty = false,
    canRevert = false,
    onSave = () => {},
    onRevert = () => {},
    requestType,
    method = $bindable('GET'),
    url = $bindable(''),
    urlInputRef = $bindable<HTMLInputElement | undefined>(),
    requestTypes,
    methods,
    loading,
    methodColor,
    requestTypeLabel,
    requestTypeEditable = true,
    variableSuggestions = [],
    onRequestNameInput,
    onRequestNameCommit,
    onRequestTypeChange,
    onUrlPaste,
    onUrlInput = () => {},
    onSend,
    onSendAndDownload = () => {},
    sseStatus = undefined,
    wsStatus = undefined,
    sioStatus = undefined,
    grpcMethod = '',
    grpcMethods = [],
    grpcServiceLoading = false,
    grpcMethodLabel = (value: string) => value,
    onGrpcMethodChange = () => {},
    onGrpcDiscover = async () => {},
  }: {
    codePanelOpen?: boolean;
    codePanelAvailable?: boolean;
    requestName: string;
    requestLocation?: string;
    fileDraft?: RequestFileDraft;
    showSave?: boolean;
    saveDirty?: boolean;
    canRevert?: boolean;
    onSave?: () => void;
    onRevert?: () => void;
    requestType: RequestType;
    method: string;
    url: string;
    urlInputRef?: HTMLInputElement;
    requestTypes: RequestType[];
    methods: string[];
    loading: boolean;
    methodColor: (method: string) => string;
    requestTypeLabel: (type: RequestType) => string;
    requestTypeEditable?: boolean;
    variableSuggestions?: VariableSuggestion[];
    onRequestNameInput: (value: string) => void;
    onRequestNameCommit: () => void;
    onRequestTypeChange: (type: RequestType, method?: string) => void;
    onUrlPaste: (event: ClipboardEvent) => void;
    onUrlInput?: (event: Event) => void;
    onSend: () => void;
    onSendAndDownload?: () => void;
    sseStatus?: SSEStatus;
    wsStatus?: WebSocketStatus;
    sioStatus?: SocketIOStatus;
    grpcMethod?: string;
    grpcMethods?: GrpcMethodInfo[];
    grpcServiceLoading?: boolean;
    grpcMethodLabel?: (fullName: string) => string;
    onGrpcMethodChange?: (fullName: string) => void;
    onGrpcDiscover?: () => Promise<void> | void;
  } = $props();

  let urlCandidates = $derived(urlGhostCandidates(vm.requests, vm.requestHistory, {
    workspaceCollectionIds: new Set(vm.collections.filter(collection => collection.workspaceId === vm.activeWorkspaceId).map(collection => collection.id)),
    requestType,
    excludeRequestId: vm.activeRequestId,
  }));
  const urlGhostFor = (typed: string) => urlGhost(typed, urlCandidates);
  let isGRPC = $derived(requestType === 'grpc');
  let isAI = $derived(requestType === 'ai');
  const aiProvider = $derived(fileDraft?.barValue('aiProvider', vm.aiProvider, 'openai') ?? vm.aiProvider);
  const connectionId = $derived(fileDraft?.barValue('aiConnectionId', vm.aiConnectionId) ?? vm.aiConnectionId);
  const chosenAiConnection = $derived(aiConnectionsStore.list.find(connection => connection.id === connectionId));
  const running = $derived(vm.requestIsRunning(vm.activeRequestId));
  const sendType = $derived(running ? vm.requestType : requestType);
  const connectionStatus = $derived(sendType === 'ws' ? wsStatus : sendType === 'socketio' ? sioStatus : sseStatus);
  const connecting = $derived(connectionStatus === 'connecting' || connectionStatus === 'reconnecting');
  const connectionActive = $derived(connecting || connectionStatus === 'connected');
  const showSSEControls = $derived(sendType === 'http' && ((running ? vm.method : method) === 'SSE' || connectionActive));
  const sendBusy = $derived(loading || connectionActive);

  function sendFromUrl() {
    if (!sendBusy) onSend();
  }

  let methodMenuOpen = $state(false);
  let grpcMethodMenuOpen = $state(false);
  let sendMenuOpen = $state(false);
  let requestComposerRef: HTMLElement | undefined = undefined;
  let grpcMethodButtonRef = $state<HTMLButtonElement | undefined>();
  let grpcMethodFilter = $state('');
  let grpcFilteredMethods = $derived.by(() => {
    const query = grpcMethodFilter.trim().toLowerCase();
    if (!query) return grpcMethods;
    return grpcMethods.filter(option => `${option.fullName} ${option.service} ${option.name}`.toLowerCase().includes(query));
  });
  let grpcSelectedLabel = $derived(grpcMethodLabel(grpcMethod) || 'Select a method');

  onMount(() => {
    const closeMenusOnOutsidePointerDown = (event: PointerEvent) => {
      const target = event.target;
      if (target instanceof Node && requestComposerRef?.contains(target)) return;
      methodMenuOpen = false;
      grpcMethodMenuOpen = false;
      sendMenuOpen = false;
    };
    document.addEventListener('pointerdown', closeMenusOnOutsidePointerDown, true);
    return () => document.removeEventListener('pointerdown', closeMenusOnOutsidePointerDown, true);
  });

  function keepHostVisible() {
    setTimeout(() => {
      if (!urlInputRef) return;
      urlInputRef.scrollLeft = 0;
      urlInputRef.setSelectionRange(0, 0);
    }, 0);
  }

  function closeMethodMenuOnFocusOut(event: FocusEvent) {
    const current = event.currentTarget;
    const next = event.relatedTarget;
    if (!(current instanceof HTMLElement) || !(next instanceof Node)) return;
    if (!current.contains(next)) methodMenuOpen = false;
  }

  function closeGrpcMethodMenuOnFocusOut(event: FocusEvent) {
    const current = event.currentTarget;
    const next = event.relatedTarget;
    if (!(current instanceof HTMLElement) || !(next instanceof Node)) return;
    if (!current.contains(next)) grpcMethodMenuOpen = false;
  }

  function closeSendMenuOnFocusOut(event: FocusEvent) {
    const current = event.currentTarget;
    const next = event.relatedTarget;
    if (!(current instanceof HTMLElement) || !(next instanceof Node)) return;
    if (!current.contains(next)) sendMenuOpen = false;
  }

  const PROTOCOL_NAMES: Partial<Record<RequestType, string>> = {
    graphql: 'GraphQL',
    ws: 'WebSocket',
    socketio: 'Socket.IO',
    grpc: 'gRPC',
    mcp: 'MCP',
    ai: 'AI',
  };
  let protocolTypes = $derived(requestTypes.filter(type => type !== 'http'));
  let isHTTP = $derived(requestType === 'http');
  let aiEndpoint = $derived(aiEndpointParts(url, aiProvider));
  let pickerLabel = $derived(isHTTP ? method : requestTypeLabel(requestType));

  function selectRequestType(type: RequestType) {
    if (!requestTypeEditable) return;
    onRequestTypeChange(type);
    methodMenuOpen = false;
  }

  function selectMethod(nextMethod: string) {
    if (!isHTTP) {
      if (!requestTypeEditable) return;
      onRequestTypeChange('http', nextMethod);
    } else method = nextMethod;
    methodMenuOpen = false;
  }

  async function toggleGrpcMethodMenu() {
    grpcMethodMenuOpen = !grpcMethodMenuOpen;
    if (grpcMethodMenuOpen && !grpcMethods.length && !grpcServiceLoading) {
      await onGrpcDiscover();
    }
  }

  function selectGrpcMethod(fullName: string) {
    onGrpcMethodChange(fullName);
    grpcMethodMenuOpen = false;
    grpcMethodFilter = '';
  }

  function onGrpcMethodSearchKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      grpcMethodMenuOpen = false;
      grpcMethodButtonRef?.focus();
    }
  }

  function onNameKeydown(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      event.preventDefault();
      onRequestNameCommit();
      if (event.currentTarget instanceof HTMLInputElement) event.currentTarget.blur();
    }
  }
</script>

<div class="request-composer" bind:this={requestComposerRef}>
  <div class="request-meta">
    {#if requestLocation}
      <span class="request-location">{requestLocation}</span>
      <span class="request-location-sep" aria-hidden="true">/</span>
    {/if}
    <input
      class="request-title-input"
      maxlength={NAME_MAX_LENGTH}
      disabled={!!fileDraft && !fileDraft.ready}
      bind:value={() => requestName, onRequestNameInput}
      placeholder="New Request"
      spellcheck="false"
      aria-label="Request name"
      onblur={onRequestNameCommit}
      onkeydown={onNameKeydown}
      autocomplete="off"
      autocorrect="off"
      autocapitalize="none"
    />
    {#if showSave}
      <SaveActions {saveDirty} {canRevert} {onSave} {onRevert} />
    {/if}
  </div>

  <div class="request-bar" class:request-bar-ws={requestType === 'ws' || requestType === 'socketio' || requestType === 'graphql' || requestType === 'mcp'} class:request-bar-code={codePanelAvailable} class:request-bar-grpc={requestType === 'grpc'} class:request-bar-ai={requestType === 'ai'}>
    <div class="url-field" inert={!!fileDraft && !fileDraft.ready}>
      <div class="method-wrap" onfocusout={closeMethodMenuOnFocusOut}>
        <button
          class="method-trigger {isHTTP ? methodColor(method) : 'method-trigger--protocol'}"
          class:open={methodMenuOpen}
          type="button"
          aria-label="Method and protocol"
          aria-haspopup="listbox"
          aria-expanded={methodMenuOpen}
          onclick={() => { methodMenuOpen = !methodMenuOpen; }}
        >
          <span>{pickerLabel}</span>
          <svg width="0.625rem" height="0.375rem" viewBox="0 0 10 6" fill="none" aria-hidden="true">
            <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>
        {#if methodMenuOpen}
          <div class="menu method-menu" role="listbox" aria-label="Method and protocol">
            <div class="method-menu-group" role="group" aria-label="HTTP">
              <span class="method-menu-label" aria-hidden="true">HTTP</span>
              {#each methods as option, eachIndex (eachIndex)}
                <button
                  class={`menu-item ${methodColor(option)}`}
                  class:active={isHTTP && method === option}
                  role="option"
                  disabled={!isHTTP && !requestTypeEditable}
                  aria-selected={isHTTP && method === option}
                  type="button"
                  onclick={() => selectMethod(option)}
                >
                  <span class="method-check">{isHTTP && method === option ? '✓' : ''}</span>
                  <span>{option}</span>
                </button>
              {/each}
            </div>
            <div class="method-menu-group" role="group" aria-label="Other protocols">
              <span class="method-menu-label" aria-hidden="true">Other protocols</span>
              {#if requestTypeEditable}
                {#each protocolTypes as option, eachIndex (eachIndex)}
                  <button
                    class="menu-item method-menu-protocol"
                    class:active={requestType === option}
                    role="option"
                    aria-selected={requestType === option}
                    type="button"
                    onclick={() => selectRequestType(option)}
                  >
                    <span class="method-check">{requestType === option ? '✓' : ''}</span>
                    <span>{PROTOCOL_NAMES[option] ?? requestTypeLabel(option)}</span>
                  </button>
                {/each}
              {:else}
                <p class="method-menu-note">Stop the running request to change its protocol.</p>
              {/if}
            </div>
          </div>
        {/if}
      </div>

      {#if isAI && aiProvider === 'kurlo'}
      <button class="field url-input ai-connection-url" type="button" aria-label={connectionId ? 'AI connection' : 'Default AI connection'} onclick={() => { aiConnectionsStore.reveal = 'models'; vm.openSettings('ai'); }}>
        <span class="ai-connection-url-label" class:missing={connectionId && !chosenAiConnection}>{connectionId ? chosenAiConnection?.label ?? 'Removed connection' : aiConnectionsStore.defaultConnection?.label ?? 'No AI connection yet'}</span>
        <span class="ai-connection-url-hint">Settings → AI</span>
      </button>
      {:else}
      <VariableInput
        className="url-input"
        bind:inputRef={urlInputRef}
        bind:value={url}
        wheelScroll
        suggestions={variableSuggestions}
        ghost={urlGhostFor}
        placeholder={requestType === 'graphql' ? 'Enter GraphQL endpoint URL…' : requestType === 'ws' ? 'Enter WebSocket URL…' : requestType === 'socketio' ? 'Enter Socket.IO URL…' : requestType === 'grpc' ? 'Enter gRPC target, e.g. localhost:50051…' : requestType === 'mcp' ? 'Enter the MCP endpoint URL…' : requestType === 'ai' ? 'Base URL' : 'Enter request URL or paste cURL…'}
        ariaLabel={requestType === 'grpc' ? 'gRPC target' : requestType === 'ai' ? 'Provider base URL' : 'Request URL'}
        oninput={onUrlInput}
        onpaste={(event) => { onUrlPaste(event); keepHostVisible(); }}
        onenter={sendFromUrl}
      />
      {/if}
    </div>

    {#if isAI}
      <AiModelPicker {fileDraft} />
    {/if}

    {#if isGRPC && fileDraft}
      <VariableInput
        className="field field-xl"
        ariaLabel="gRPC method"
        disabled={!fileDraft.ready}
        placeholder="/package.Service/Method"
        bind:value={() => fileDraft?.barValue('grpcMethod', grpcMethod) ?? grpcMethod, value => fileDraft?.editBar({ grpcMethod: value })}
        pickerOptions={url === vm.url ? grpcMethods.map(option => option.fullName) : []}
      />
    {:else if isGRPC}
      <div class="grpc-method-wrap" onfocusout={closeGrpcMethodMenuOnFocusOut}>
        <button
          class="field field-xl select-trigger grpc-method-trigger"
          class:open={grpcMethodMenuOpen}
          type="button"
          bind:this={grpcMethodButtonRef}
          aria-label="gRPC method"
          aria-haspopup="listbox"
          aria-expanded={grpcMethodMenuOpen}
          onclick={toggleGrpcMethodMenu}
        >
          <span class="grpc-method-icon" aria-hidden="true">↕</span>
          <span class="grpc-method-label">{grpcSelectedLabel}</span>
          <svg width="0.625rem" height="0.375rem" viewBox="0 0 10 6" fill="none" aria-hidden="true">
            <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
        </button>

        {#if grpcMethodMenuOpen}
          <div class="grpc-method-menu" role="listbox" aria-label="gRPC methods">
            <div class="field field-wrap grpc-method-search">
              <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true">
                <circle cx="5.8" cy="5.8" r="3.8" stroke="currentColor" stroke-width="1.3"/>
                <path d="M8.7 8.7l2.7 2.7" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/>
              </svg>
              <input bind:value={grpcMethodFilter} onkeydown={onGrpcMethodSearchKeydown} placeholder="Search methods" aria-label="Search gRPC methods" autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} />
            </div>

            <button class="btn btn-secondary grpc-method-refresh" type="button" disabled={grpcServiceLoading} onclick={() => onGrpcDiscover()}>
              {#if grpcServiceLoading}<BirdSpinner tone="current" />{/if}
              <span>{grpcMethods.length ? 'Refresh methods' : 'Load methods'}</span>
            </button>

            {#if grpcFilteredMethods.length}
              <div class="grpc-method-options">
                {#each grpcFilteredMethods as option, eachIndex (eachIndex)}
                  <button class="grpc-method-option"
                    class:active={grpcMethod === option.fullName}
                    role="option"
                    aria-selected={grpcMethod === option.fullName}
                    type="button"
                    onclick={() => selectGrpcMethod(option.fullName)}
                  >
                    <span class="method-check">{grpcMethod === option.fullName ? '✓' : ''}</span>
                    <span class="grpc-option-main">
                      <strong>{grpcMethodLabel(option.fullName)}</strong>
                      <small>{option.requestType} -> {option.responseType}</small>
                    </span>
                  </button>
                {/each}
              </div>
            {:else}
              <div class="grpc-method-empty">
                {grpcMethodFilter.trim() ? 'No matching methods' : 'No methods loaded'}
              </div>
            {/if}
          </div>
        {/if}
      </div>
    {/if}

    {#if codePanelAvailable}
      <button class="btn btn-secondary btn-icon btn-xl request-code-btn" class:active={codePanelOpen} type="button" onclick={() => (codePanelOpen = !codePanelOpen)} aria-label="Code snippet" aria-pressed={codePanelOpen}>
        &lt;/&gt;
      </button>
    {/if}

    {#if sendType === 'graphql' || sendType === 'grpc' || sendType === 'ai'}
      <button
        class="btn-send"
        class:btn-graphql-query={sendType === 'graphql' || sendType === 'grpc'}
        class:btn-send-cancel={loading}
        onclick={onSend}
        type="button"
      >
        {#if loading}
          <BirdSpinner tone="current" />{sendType === 'ai' ? 'Stop' : 'Cancel'}
        {:else}
          {sendType === 'graphql' ? 'Query' : sendType === 'grpc' ? 'Invoke' : 'Send'}
        {/if}
        <RequestShortcutHint cancel={loading} />
      </button>
    {:else if sendType === 'ws' || sendType === 'socketio' || showSSEControls}
      <button
        class="btn-send"
        class:btn-sse-connect={showSSEControls && !connectionActive}
        class:btn-sse-disconnect={showSSEControls && connectionActive}
        class:btn-ws-connect={!showSSEControls && !connectionActive}
        class:btn-ws-disconnect={!showSSEControls && connectionActive}
        onclick={onSend}
        type="button"
      >
        {#if connecting}<BirdSpinner tone="current" />
        {:else if connectionActive}<span class="sse-dot-live"></span>{/if}
        {connectionActive ? 'Disconnect' : 'Connect'}
        <RequestShortcutHint />
      </button>
    {:else}
      <div class="send-split" class:loading onfocusout={closeSendMenuOnFocusOut}>
        <button
          class="btn-send"
          class:btn-send-cancel={loading}
          onclick={onSend}
          type="button"
        >
          {#if loading}<BirdSpinner tone="current" />Cancel
          {:else}
            Send
          {/if}
          <RequestShortcutHint cancel={loading} />
        </button>
        {#if !loading}
          <button
            class="btn-send-caret"
            class:open={sendMenuOpen}
            type="button"
            aria-label="Send options"
            aria-haspopup="menu"
            aria-expanded={sendMenuOpen}
            onclick={() => (sendMenuOpen = !sendMenuOpen)}
          >
            <svg width="0.5rem" height="0.3125rem" viewBox="0 0 10 7" fill="none" aria-hidden="true">
              <path d="M1.5 2L5 5.5L8.5 2" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/>
            </svg>
          </button>
          {#if sendMenuOpen}
            <div class="menu send-menu" role="menu" aria-label="Send options">
              <button
                class="menu-item send-menu-item"
                role="menuitem"
                type="button"
                onclick={() => { sendMenuOpen = false; onSendAndDownload(); }}
              >
                <svg width="0.9375rem" height="0.9375rem" viewBox="0 0 15 15" fill="none" aria-hidden="true">
                  <path d="M7.5 2v7m0 0L4.5 6m3 3l3-3M2.5 12h10" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/>
                </svg>
                Send and download
              </button>
            </div>
          {/if}
        {/if}
      </div>
    {/if}
  </div>
  {#if isAI && aiEndpoint.base}
    <p class="ai-endpoint">
      <span class="ai-endpoint-label">Sends to</span>
      <span class="ai-endpoint-url"><span class="ai-endpoint-method">POST</span> {aiEndpoint.base}{#if aiEndpoint.suffix}<mark class="ai-endpoint-suffix">{aiEndpoint.suffix}</mark>{/if}{aiEndpoint.query}</span>
    </p>
  {/if}
</div>
