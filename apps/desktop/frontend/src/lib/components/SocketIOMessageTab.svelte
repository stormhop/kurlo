<script lang="ts">
  import Select from './Select.svelte';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import CodeEditor from '../CodeEditor.svelte';
  import BeautifyButton from './BeautifyButton.svelte';
  import RequestShortcutHint from './RequestShortcutHint.svelte';
  import SavedMessagesMenu from './SavedMessagesMenu.svelte';
  import { bodyPlaceholder } from '../bodyTemplates';
  import { vm } from '../stores/app.svelte';
  import type { RawBodyType, SIOArgEncoding } from '../types/models';

  const RAW_BODY_TYPES: (RawBodyType | 'binary')[] = ['text', 'json', 'html', 'xml', 'binary'];
  const ENCODINGS: SIOArgEncoding[] = ['base64', 'hex'];

  let editorRef = $state<CodeEditor>();

  function onKeydown(event: KeyboardEvent) {
    if (vm.shortcutForEvent(event) === 'send-request') {
      event.preventDefault();
      event.stopPropagation();
      if (vm.socketIOConnected) void vm.socketIOEmitCurrentMessage();
      else void vm.runActiveRequest();
    }
  }

  function argLabel(index: number) { return `Arg ${index + 1}`; }

  function bodyTypeLabel(type: RawBodyType | 'binary') {
    const map: Record<string, string> = { text: 'Text', json: 'JSON', html: 'HTML', xml: 'XML', binary: 'Binary' };
    return map[type] ?? type;
  }


  const currentArg = $derived(vm.sioCurrentArg());
  const currentArgIdx = $derived.by(() => {
    const selectedIdx = vm.sioArgs.findIndex(a => a.id === vm.sioSelectedArgId);
    if (selectedIdx >= 0) return selectedIdx;
    return currentArg ? vm.sioArgs.indexOf(currentArg) : -1;
  });
</script>

<div class="sio-message-root" class:connected-message-editor={vm.socketIOConnected} role="presentation" onkeydowncapture={onKeydown}>

  <div class="sio-body">

    {#if vm.sioArgs.length > 1}
      <div class="sio-arg-sidebar">
        {#each vm.sioArgs as arg, i (arg.id)}
          <div
            class="sio-arg-item"
            class:active={vm.sioSelectedArgId === arg.id}
            role="button"
            tabindex="0"
            onclick={() => { vm.sioSelectedArgId = arg.id; }}
            onkeydown={(e) => { if (e.key === 'Enter' || e.key === ' ') vm.sioSelectedArgId = arg.id; }}
          >
            <span class="sio-arg-label">{argLabel(i)}</span>
            <span class="sio-arg-type">{bodyTypeLabel(arg.bodyType)}</span>
            <button
              class="btn btn-ghost btn-icon btn-xs sio-arg-del"
              type="button"
              aria-label="Remove argument"
              onclick={(e) => { e.stopPropagation(); vm.sioRemoveArg(arg.id); }}
            ><AddCloseIcon /></button>
          </div>
        {/each}
        <button class="btn btn-dashed btn-sm sio-add-arg-btn" type="button" onclick={vm.sioAddArg}>
          <AddCloseIcon add /> Add Arg
        </button>
      </div>
    {/if}


    {#if currentArg}
      <div class="sio-editor-area">

        <div class="sio-editor-toolbar">

          <Select
            className="raw-type-menu sio-type-menu"
            size="sm"
            ariaLabel="Argument type"
            value={currentArg.bodyType}
            options={RAW_BODY_TYPES.map(type => ({ value: type, label: bodyTypeLabel(type) }))}
            onChange={type => vm.sioUpdateCurrentArg({ bodyType: type as RawBodyType })}
          />


          {#if currentArg.bodyType === 'binary'}
            <Select
              className="raw-type-menu sio-type-menu"
              size="sm"
              ariaLabel="Encoding"
              value={currentArg.encoding}
              options={ENCODINGS.map(enc => ({ value: enc, label: enc === 'hex' ? 'Hex' : 'Base64' }))}
              onChange={enc => vm.sioUpdateCurrentArg({ encoding: enc as typeof currentArg.encoding })}
            />
          {/if}


          <BeautifyButton onbeautify={() => editorRef?.format()} beautified={vm.beautifiedBody} disabled={currentArg.bodyType !== 'json'} />


          {#if vm.sioArgs.length === 1}
            <button class="btn btn-dashed btn-sm sio-add-arg-inline" type="button" onclick={vm.sioAddArg}>
              <AddCloseIcon add /> Arg
            </button>
          {/if}


          <div class="sio-toolbar-spacer"></div>
          <SavedMessagesMenu connected={vm.socketIOConnected} />


          <div class="sio-event-controls">
            <input
              class="field field-sm sio-event-name-input"
              type="text"
              bind:value={vm.sioEventName}
              placeholder='Event name'
              spellcheck="false"
              autocomplete="off"
              autocorrect="off"
              autocapitalize="none"
            />
            <label class="check-label sio-ack-label">
              <input type="checkbox" bind:checked={vm.sioAck} class="check" />
              Ack
            </label>
            <button
              class="btn btn-primary btn-sm ws-message-send"
              type="button"
              disabled={!vm.socketIOConnected}
              onclick={vm.socketIOEmitCurrentMessage}
            >
              Send
              {#if vm.socketIOConnected}<RequestShortcutHint />{/if}
            </button>
          </div>
        </div>

        {#if currentArgIdx >= 0}
          <CodeEditor
            bind:this={editorRef}
            bind:value={vm.sioArgs[currentArgIdx].content}
            language={vm.sioCurrentArgLang}
            placeholder={bodyPlaceholder(vm.sioCurrentArgLang, currentArg.bodyType === 'binary' ? 'binary' : 'message')}
            fillHeight={true}
            compact={true}
            testId="socketio-message-editor"
            ariaLabel="Socket.IO message editor"
            variableSuggestions={vm.variableSuggestions}
            onformat={vm.markBodyFormatted}
          />
        {/if}
      </div>
    {/if}
  </div>
</div>

<style>
  .sio-message-root {
    display: flex;
    flex-direction: column;
    height: 100%;
    overflow: hidden;
  }

  .sio-body {
    display: flex;
    flex: 1;
    min-height: 0;
    overflow: hidden;
  }

  .sio-arg-sidebar {
    width: 6.875rem;
    flex-shrink: 0;
    border-right: 1px solid var(--border);
    display: flex;
    flex-direction: column;
    overflow-y: auto;
    background: var(--surface);
  }

  .sio-arg-item {
    display: flex;
    align-items: center;
    gap: var(--space-1);
    padding: var(--space-1-5) var(--space-2);
    cursor: pointer;
    border-bottom: 1px solid var(--border);
    font-size: var(--text-caption);
    color: var(--text-2);
    transition: background var(--dur-fast);
  }
  .sio-arg-item:hover { background: var(--elevated); }
  .sio-arg-item.active { background: color-mix(in srgb, var(--accent) 12%, var(--surface)); color: var(--text); }

  .sio-arg-label { font-weight: var(--weight-medium); flex: 1; }
  .sio-arg-type { font-size: var(--text-micro); color: var(--text-3); }

  .sio-arg-del {
    display: none;
  }
  .sio-arg-item:hover .sio-arg-del,
  .sio-arg-item.active .sio-arg-del { display: inline; }

  .sio-add-arg-btn {
    margin: var(--space-1-5) var(--space-2);
    text-align: center;
  }

  .sio-add-arg-inline {
    flex-shrink: 0;
    white-space: nowrap;
  }

  .sio-editor-area {
    flex: 1;
    display: flex;
    flex-direction: column;
    min-width: 0;
    overflow: hidden;
  }

  .sio-editor-toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--space-1-5);
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--surface);
  }

  .sio-toolbar-spacer { flex: 1; }


  .sio-event-controls {
    display: flex;
    align-items: center;
    gap: var(--space-1-5);
    max-width: 100%;
    min-width: 0;
    margin-left: auto;
  }

  .sio-event-name-input {
    width: 12.5rem;
    min-width: 0;
  }

</style>
