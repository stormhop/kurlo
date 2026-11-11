<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import CodeEditor from '../CodeEditor.svelte';
  import BeautifyButton from './BeautifyButton.svelte';
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
      void vm.socketIOEmitCurrentMessage();
    }
  }

  function argLabel(index: number) { return `Arg ${index + 1}`; }

  function bodyTypeLabel(type: RawBodyType | 'binary') {
    const map: Record<string, string> = { text: 'Text', json: 'JSON', html: 'HTML', xml: 'XML', binary: 'Binary' };
    return map[type] ?? type;
  }

  let typeMenuOpenId = $state<string | null>(null);
  let encodingMenuOpen = $state(false);

  function closeMenus() { typeMenuOpenId = null; encodingMenuOpen = false; }

  $effect(() => {
    window.addEventListener('click', closeMenus);
    return () => window.removeEventListener('click', closeMenus);
  });

  const currentArg = $derived(vm.sioCurrentArg());
  const currentArgIdx = $derived.by(() => {
    const selectedIdx = vm.sioArgs.findIndex(a => a.id === vm.sioSelectedArgId);
    if (selectedIdx >= 0) return selectedIdx;
    return currentArg ? vm.sioArgs.indexOf(currentArg) : -1;
  });
</script>

<div class="sio-message-root" role="presentation" onkeydown={onKeydown}>

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
              onclick={(e) => { e.stopPropagation(); vm.sioRemoveArg(arg.id); }}
            >✕</button>
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

          <div class="sio-type-menu">
            <button
              class="field field-sm select-trigger raw-type-button"
              class:open={typeMenuOpenId === currentArg.id}
              type="button"
              onclick={(e) => { e.stopPropagation(); typeMenuOpenId = typeMenuOpenId === currentArg.id ? null : currentArg.id; encodingMenuOpen = false; }}
            >
              {bodyTypeLabel(currentArg.bodyType)}
              <svg width="0.625rem" height="0.375rem" viewBox="0 0 10 6" fill="none" aria-hidden="true">
                <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
              </svg>
            </button>
            {#if typeMenuOpenId === currentArg.id}
              <div class="menu raw-type-list sio-type-options" role="listbox">
                {#each RAW_BODY_TYPES as type, eachIndex (eachIndex)}
                  <button class="menu-item"
                    class:active={currentArg.bodyType === type}
                    role="option"
                    aria-selected={currentArg.bodyType === type}
                    type="button"
                    onclick={(e) => { e.stopPropagation(); vm.sioUpdateCurrentArg({ bodyType: type }); typeMenuOpenId = null; }}
                  >
                    <span class="method-check">{currentArg.bodyType === type ? '✓' : ''}</span>
                    {bodyTypeLabel(type)}
                  </button>
                {/each}
              </div>
            {/if}
          </div>


          {#if currentArg.bodyType === 'binary'}
            <div class="sio-type-menu">
              <button
                class="field field-sm select-trigger raw-type-button"
                class:open={encodingMenuOpen}
                type="button"
                onclick={(e) => { e.stopPropagation(); encodingMenuOpen = !encodingMenuOpen; typeMenuOpenId = null; }}
              >
                {currentArg.encoding === 'hex' ? 'Hex' : 'Base64'}
                <svg width="0.625rem" height="0.375rem" viewBox="0 0 10 6" fill="none" aria-hidden="true">
                  <path d="M1 1l4 4 4-4" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
                </svg>
              </button>
              {#if encodingMenuOpen}
                <div class="menu raw-type-list sio-type-options" role="listbox">
                  {#each ENCODINGS as enc, eachIndex (eachIndex)}
                    <button class="menu-item"
                      class:active={currentArg.encoding === enc}
                      role="option"
                      aria-selected={currentArg.encoding === enc}
                      type="button"
                      onclick={(e) => { e.stopPropagation(); vm.sioUpdateCurrentArg({ encoding: enc }); encodingMenuOpen = false; }}
                    >
                      <span class="method-check">{currentArg.encoding === enc ? '✓' : ''}</span>
                      {enc === 'hex' ? 'Hex' : 'Base64'}
                    </button>
                  {/each}
                </div>
              {/if}
            </div>
          {/if}


          <BeautifyButton onbeautify={() => editorRef?.format()} beautified={vm.beautifiedBody} disabled={currentArg.bodyType !== 'json'} />


          {#if vm.sioArgs.length === 1}
            <button class="btn btn-dashed btn-sm sio-add-arg-inline" type="button" onclick={vm.sioAddArg}>
              <AddCloseIcon add /> Arg
            </button>
          {/if}


          <div class="sio-toolbar-spacer"></div>
          <SavedMessagesMenu connected={vm.socketIOConnected} />


          <input
            class="field field-sm sio-event-name-input"
            type="text"
            bind:value={vm.sioEventName}
            placeholder='Event name'
            spellcheck="false"
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
          </button>
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
    align-items: center;
    gap: var(--space-1-5);
    padding: var(--space-1) var(--space-2);
    border-bottom: 1px solid var(--border);
    flex-shrink: 0;
    background: var(--surface);
  }

  .sio-toolbar-spacer { flex: 1; }

  .sio-type-menu { position: relative; }

  .sio-type-options {
    position: absolute;
    top: 100%;
    left: 0;
    z-index: 100;
    min-width: 5.625rem;
  }

  .sio-event-name-input {
    width: 12.5rem;
  }

</style>
