<script lang="ts">
  import CodeEditor from '../CodeEditor.svelte';
  import { MQTT_FORMATS, MQTT_QOS_OPTIONS, mqttValidateFilter, type MqttFormat, type MqttQoS, type MqttSavedMessage } from '../mqtt';
  import { vm } from '../stores/app.svelte';
  import { mqttSession } from '../stores/mqtt.svelte';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import BeautifyButton from './BeautifyButton.svelte';
  import ClientCertSetting from './ClientCertSetting.svelte';
  import MqttUserProperties from './MqttUserProperties.svelte';
  import RequestShortcutHint from './RequestShortcutHint.svelte';
  import SavedPayloadMenu from './SavedPayloadMenu.svelte';
  import Select from './Select.svelte';
  import VariableInput from './VariableInput.svelte';
  import VirtualList from './VirtualList.svelte';

  let session = $derived(mqttSession(vm.activeRequestId));
  let connected = $derived(session.status === 'connected');
  let v5 = $derived(vm.mqtt.version === '5');
  let editorRef = $state<CodeEditor>();
  let willEditorRef = $state<CodeEditor>();
  let showProperties = $state(false);
  let newTopic = $state('');
  let newTopicError = $derived(newTopic.trim() ? mqttValidateFilter(newTopic) : '');
  let sending = $state(false);
  let topicsPane = $state<HTMLElement | undefined>();
  let topicRows = $derived(vm.mqtt.topics.map((_, i) => ({ key: String(i), height: 40, i })));

  const qosOptions = MQTT_QOS_OPTIONS;
  const shortQos = [{ value: '0', label: 'QoS 0' }, { value: '1', label: 'QoS 1' }, { value: '2', label: 'QoS 2' }];
  const language = (format: MqttFormat) => format === 'json' ? 'json' : 'text';
  const placeholder = (format: MqttFormat) => format === 'base64' ? 'SGVsbG8=' : format === 'hex' ? '48 65 6c 6c 6f' : format === 'json' ? '{ "temperature": 21.5 }' : 'Message payload';
  let propertyCount = $derived([vm.mqtt.properties.contentType, vm.mqtt.properties.responseTopic, vm.mqtt.properties.correlationData, vm.mqtt.properties.messageExpiryInterval, vm.mqtt.properties.topicAlias].filter(Boolean).length + (vm.mqtt.properties.payloadFormatIndicator ? 1 : 0) + vm.mqtt.properties.userProperties.filter(row => row.enabled && row.key).length);

  async function send() {
    if (!connected || sending) return;
    sending = true;
    try { await vm.mqttPublishCurrent(); } finally { sending = false; }
  }

  function onKeydown(event: KeyboardEvent) {
    if (vm.shortcutForEvent(event) === 'send-request') {
      event.preventDefault();
      event.stopPropagation();
      if (connected) void send();
      else void vm.runActiveRequest();
    }
  }

  function addTopic() {
    const name = newTopic.trim();
    if (!name || newTopicError) return;
    if (vm.mqtt.topics.some(topic => topic.name === name)) { newTopic = ''; return; }
    vm.mqtt.topics = [...vm.mqtt.topics, { name, qos: 0, enabled: false }];
    newTopic = '';
    void vm.mqttSetSubscribed(vm.mqtt.topics.length - 1, true);
  }

  async function removeTopic(index: number) {
    await vm.mqttRemoveTopic(index);
  }

  function savedSummary(message: MqttSavedMessage) {
    const payload = message.payload.replace(/\s+/g, ' ').trim();
    return `${message.topic || 'No topic'} · QoS ${message.qos}${message.retain ? ' · retained' : ''}${payload ? ' · ' + payload.slice(0, 60) : ''}`;
  }

  function suggestName() {
    const base = vm.mqtt.topic.trim().split('/').filter(Boolean).pop() || 'Message';
    let name = base;
    for (let i = 2; vm.mqtt.savedMessages.some(m => m.name.toLowerCase() === name.toLowerCase()); i++) name = `${base} ${i}`;
    return name;
  }

  function saveProblem(name: string) {
    if (!name.trim()) return 'Enter a name';
    if (vm.mqtt.savedMessages.some(m => m.name.toLowerCase() === name.trim().toLowerCase())) return 'A saved message with this name already exists';
    return '';
  }

  function saveMessage(name: string) {
    vm.mqttSaveMessage(name);
    return vm.mqtt.savedMessages.at(-1)?.id;
  }

  async function sendSaved(id: string) {
    vm.mqttLoadMessage(id);
    await send();
  }
</script>

{#snippet setting(title: string, text: string)}
  <span class="setting-copy"><strong>{title}</strong><span>{text}</span></span>
{/snippet}

{#snippet toggle(label: string, checked: boolean, onchange: (value: boolean) => void)}
  <label class="switch-control">
    <input type="checkbox" aria-label={label} {checked} onchange={event => onchange(event.currentTarget.checked)} />
    <span class="switch-track"></span>
    <span class="switch-state">{checked ? 'ON' : 'OFF'}</span>
  </label>
{/snippet}

{#snippet publishProperties(target: typeof vm.mqtt.properties, prefix: string, withAlias: boolean)}
  <div class="prop-grid">
    <label><span>Content type</span><VariableInput ariaLabel={prefix + ' content type'} className="field field-md" bind:value={target.contentType} suggestions={vm.variableSuggestions} placeholder="application/json" /></label>
    <label><span>Response topic</span><VariableInput ariaLabel={prefix + ' response topic'} className="field field-md" bind:value={target.responseTopic} suggestions={vm.variableSuggestions} placeholder="replies/device-1" /></label>
    <label><span>Correlation data</span><VariableInput ariaLabel={prefix + ' correlation data'} className="field field-md" bind:value={target.correlationData} suggestions={vm.variableSuggestions} placeholder="request-42" /></label>
    <label><span>Message expiry (s)</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md" inputmode="numeric" aria-label={prefix + ' message expiry interval'} bind:value={target.messageExpiryInterval} placeholder="Never" /></label>
    {#if withAlias}<label><span>Topic alias</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md" inputmode="numeric" aria-label={prefix + ' topic alias'} bind:value={target.topicAlias} placeholder="None" /></label>{/if}
    <label class="inline-check"><input class="check" type="checkbox" bind:checked={target.payloadFormatIndicator} /><span>Payload is UTF-8 text</span></label>
  </div>
  <MqttUserProperties bind:rows={target.userProperties} label={prefix + ' user properties'} />
{/snippet}

{#if vm.requestTab === 'settings'}
  <div class="settings-section">
    <div class="settings-header">
      <div>
        <span class="settings-title">Connection</span>
        <span class="settings-subtitle">How Kurlo connects to the broker for this request.</span>
      </div>
    </div>
    <div class="settings-list">
      <label class="postman-setting">
        {@render setting('Client ID', 'Leave empty to use a random ID for each connection.')}
        <span class="client-id-input"><VariableInput ariaLabel="Client ID" className="field field-md" bind:value={vm.mqtt.clientId} suggestions={vm.variableSuggestions} placeholder="Random" /></span>
      </label>
      <div class="postman-setting">
        {@render setting(v5 ? 'Clean start' : 'Clean session', 'Start without the subscriptions and queued messages of an earlier session with the same client ID.')}
        {@render toggle('Clean session', vm.mqtt.cleanSession, value => vm.mqtt.cleanSession = value)}
      </div>
      <label class="postman-setting">
        {@render setting('Keep alive', 'How long the connection may stay silent before the broker drops it. Kurlo pings before it runs out. 0 turns pings off.')}
        <span class="setting-inline-number"><input class="field setting-number" type="number" min="0" max="65535" step="5" bind:value={vm.mqtt.keepAliveSec} /><span>s</span></span>
      </label>
      <label class="postman-setting">
        {@render setting('Connection timeout', 'How long to wait for the broker to accept the connection.')}
        <span class="setting-inline-number"><input class="field setting-number" type="number" min="0" step="1000" bind:value={vm.mqtt.connectTimeoutMs} /><span>ms</span></span>
      </label>
      <div class="postman-setting">
        {@render setting('Auto reconnect', 'Reconnect after the connection drops, up to 10 attempts, and subscribe to the same topics again.')}
        {@render toggle('Auto reconnect', vm.mqtt.autoReconnect, value => vm.mqtt.autoReconnect = value)}
      </div>
      <label class="postman-setting">
        <span class="setting-copy">
          <strong>Verify server certificate</strong>
          <span>For mqtts:// and wss:// brokers, check the certificate against trusted authorities.</span>
          {#if vm.collectionSettingDefaultNote('enableSSLVerification')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('enableSSLVerification')}>{vm.collectionSettingDefaultNote('enableSSLVerification')}</em>{/if}
        </span>
        <span class="switch-control">
          <input type="checkbox" bind:checked={vm.enableSSLVerification} onchange={() => vm.markRequestSettingOverride('enableSSLVerification')} />
          <span class="switch-track"></span>
          <span class="switch-state">{vm.enableSSLVerification ? 'ON' : 'OFF'}</span>
        </span>
      </label>
      <ClientCertSetting description="Present a client certificate when the broker requires mutual TLS." />
    </div>
  </div>
{:else if vm.requestTab === 'events'}
  <div class="mqtt-pane" bind:this={topicsPane}>
    <p class="pane-note">Turn on a topic to subscribe. While connected, the change applies right away. Use + for one level and # for the rest, for example <code>sensors/+/temperature</code>.</p>
    {#if vm.mqtt.topics.length}
      <div class="topic-table" role="table" aria-label="Topics">
        <div class="topic-row topic-head" role="row"><span role="columnheader">Subscribe</span><span role="columnheader">Topic</span><span role="columnheader">QoS</span><span role="columnheader">Description</span><span></span></div>
        {#if topicsPane}
        <VirtualList rows={topicRows} rowHeight={40} scroller={topicsPane}>
          {#snippet row({ i })}
          {@const topic = vm.mqtt.topics[i]}
          <div class="topic-row" role="row" data-testid="mqtt-topic-row">
            <span role="cell" class="subscribe-cell">
              {@render toggle('Subscribe to ' + (topic.name || 'topic'), topic.enabled, value => void vm.mqttSetSubscribed(i, value))}
              {#if connected && session.subscribed.includes(vm.mqttResolve(topic.name).trim())}<span class="live-dot" aria-label="Subscribed"></span>{/if}
            </span>
            <span role="cell"><VariableInput ariaLabel={'Topic ' + (i + 1)} className="field field-md" bind:value={topic.name} suggestions={vm.variableSuggestions} disabled={connected && topic.enabled} /></span>
            <span role="cell"><Select size="md" floating ariaLabel={'QoS for ' + topic.name} value={String(topic.qos)} options={shortQos} disabled={connected && topic.enabled} onChange={value => topic.qos = Number(value) as MqttQoS} /></span>
            <span role="cell"><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md" aria-label={'Description for ' + topic.name} bind:value={topic.description} placeholder="What this topic carries" /></span>
            <span role="cell"><button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label={'Remove ' + topic.name} onclick={() => removeTopic(i)}><AddCloseIcon /></button></span>
          </div>
          {/snippet}
        </VirtualList>
        {/if}
      </div>
    {/if}
    <form class="add-topic" onsubmit={event => { event.preventDefault(); addTopic(); }}>
      <input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md" aria-label="New topic" placeholder="Add topic, e.g. devices/+/status" bind:value={newTopic} aria-invalid={Boolean(newTopicError)} />
      <button class="btn btn-secondary btn-sm" type="submit" disabled={!newTopic.trim() || Boolean(newTopicError)}>Add</button>
      {#if newTopicError}<span class="field-error">{newTopicError}</span>{/if}
    </form>
  </div>
{:else if vm.requestTab === 'properties'}
  <div class="mqtt-pane">
    {#if !v5}
      <p class="pane-note">Connection properties need MQTT 5. Switch the version next to the broker URL to use them.</p>
    {:else}
      <p class="pane-note">Sent with CONNECT. Leave a field empty to use the broker default.</p>
      <div class="prop-grid">
        <label><span>Session expiry (s)</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md" inputmode="numeric" aria-label="Session expiry interval" bind:value={vm.mqtt.connectProperties.sessionExpiryInterval} placeholder="0, ends with the connection" /></label>
        <label><span>Receive maximum</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md" inputmode="numeric" aria-label="Receive maximum" bind:value={vm.mqtt.connectProperties.receiveMaximum} placeholder="65535" /></label>
        <label><span>Maximum packet size (bytes)</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md" inputmode="numeric" aria-label="Maximum packet size" bind:value={vm.mqtt.connectProperties.maximumPacketSize} placeholder="No limit" /></label>
        <label><span>Topic alias maximum</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md" inputmode="numeric" aria-label="Topic alias maximum" bind:value={vm.mqtt.connectProperties.topicAliasMaximum} placeholder="0" /></label>
        <label class="inline-check"><input class="check" type="checkbox" bind:checked={vm.mqtt.connectProperties.requestResponseInformation} /><span>Request response information</span></label>
        <label class="inline-check"><input class="check" type="checkbox" bind:checked={vm.mqtt.connectProperties.requestProblemInformation} /><span>Request problem information</span></label>
      </div>
      <MqttUserProperties bind:rows={vm.mqtt.connectProperties.userProperties} label="Connect user properties" />
    {/if}
  </div>
{:else if vm.requestTab === 'will'}
  <div class="mqtt-pane will-pane">
    <div class="will-head">
      <span class="setting-copy"><strong>Last will</strong><span>The broker publishes this message if the connection drops without a clean disconnect.</span></span>
      {@render toggle('Send a last will', vm.mqtt.will.enabled, value => vm.mqtt.will.enabled = value)}
    </div>
    {#if vm.mqtt.will.enabled}
      <div class="message-fields">
        <label class="topic-field"><span>Topic</span><VariableInput ariaLabel="Last will topic" className="field field-input" bind:value={vm.mqtt.will.topic} suggestions={vm.variableSuggestions} placeholder="devices/1/status" /></label>
        <div class="field-group"><span>QoS</span><Select floating ariaLabel="Last will QoS" value={String(vm.mqtt.will.qos)} options={qosOptions} onChange={value => vm.mqtt.will.qos = Number(value) as MqttQoS} /></div>
        <label class="inline-check"><input class="check" type="checkbox" bind:checked={vm.mqtt.will.retain} /><span>Retain</span></label>
        {#if v5}<label><span>Delay (s)</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-input" inputmode="numeric" aria-label="Will delay interval" bind:value={vm.mqtt.will.delayInterval} placeholder="0" /></label>{/if}
      </div>
      <div class="body-editor-toolbar message-tools">
        <Select size="sm" floating ariaLabel="Last will message type" value={vm.mqtt.will.format} options={MQTT_FORMATS} onChange={value => vm.mqtt.will.format = value as MqttFormat} />
        <BeautifyButton onbeautify={() => willEditorRef?.format()} disabled={vm.mqtt.will.format !== 'json'} title="Beautify message" />
      </div>
      <div class="will-editor">
        <CodeEditor bind:this={willEditorRef} bind:value={vm.mqtt.will.payload} language={language(vm.mqtt.will.format)} placeholder={placeholder(vm.mqtt.will.format)} fillHeight compact testId="mqtt-will-editor" ariaLabel="Last will message" variableSuggestions={vm.variableSuggestions} />
      </div>
      {#if v5}
        <div class="will-props">
          <strong class="section-label">Will properties</strong>
          {@render publishProperties(vm.mqtt.will.properties, 'Will', false)}
        </div>
      {/if}
    {/if}
  </div>
{:else}
  <div class="mqtt-message" role="presentation" onkeydowncapture={onKeydown}>
    <div class="message-fields">
      <label class="topic-field"><span>Topic</span><VariableInput ariaLabel="Publish topic" className="field field-input" bind:value={vm.mqtt.topic} suggestions={vm.variableSuggestions} placeholder="devices/1/commands" /></label>
      <div class="field-group"><span>QoS</span><Select floating ariaLabel="Publish QoS" value={String(vm.mqtt.qos)} options={qosOptions} onChange={value => vm.mqtt.qos = Number(value) as MqttQoS} /></div>
      <label class="inline-check"><input class="check" type="checkbox" bind:checked={vm.mqtt.retain} /><span>Retain</span></label>
    </div>
    <div class="body-editor-toolbar message-tools">
      <Select size="sm" floating ariaLabel="Message type" value={vm.mqtt.format} options={MQTT_FORMATS} onChange={value => vm.mqtt.format = value as MqttFormat} />
      <BeautifyButton onbeautify={() => editorRef?.format()} disabled={vm.mqtt.format !== 'json'} title="Beautify message" />
      {#if v5}
        <button class="btn btn-ghost btn-sm" type="button" aria-expanded={showProperties} onclick={() => showProperties = !showProperties}>Properties{#if propertyCount}<span class="count">{propertyCount}</span>{/if}</button>
      {/if}
      <div class="message-actions">
        <SavedPayloadMenu noun="message" items={vm.mqtt.savedMessages} summary={savedSummary} suggestName={suggestName} saveProblem={saveProblem}
          onSave={saveMessage} onLoad={vm.mqttLoadMessage} onSend={id => void sendSaved(id)} onRemove={vm.mqttDeleteMessage} canSend={connected} />
        <button class="btn btn-primary btn-sm" type="button" data-testid="mqtt-send" disabled={!connected || sending} onclick={send}>
          Send
          {#if connected}<RequestShortcutHint />{/if}
        </button>
      </div>
    </div>
    {#if v5 && showProperties}
      <div class="message-props">{@render publishProperties(vm.mqtt.properties, 'Message', true)}</div>
    {/if}
    <div class="message-value">
      <CodeEditor bind:this={editorRef} bind:value={vm.bodyContent} language={language(vm.mqtt.format)} placeholder={placeholder(vm.mqtt.format)} fillHeight compact testId="mqtt-message-editor" ariaLabel="MQTT message" variableSuggestions={vm.variableSuggestions} />
    </div>
  </div>
{/if}

<style>
  .mqtt-message, .mqtt-pane { width: 100%; height: 100%; min-height: 0; color: var(--text); }
  .mqtt-message { display: flex; flex-direction: column; overflow: auto; }
  .mqtt-pane { display: flex; flex-direction: column; gap: var(--space-3); padding: var(--space-3); overflow: auto; }
  .mqtt-pane > :global(*) { flex-shrink: 0; }
  .client-id-input { justify-self: end; width: min(18rem, 100%); }
  .client-id-input > :global(*), .client-id-input :global(input) { width: 100%; }
  .pane-note { margin: 0; color: var(--text-2); font-size: var(--text-caption); }
  .pane-note code { font-family: var(--font-mono); }
  .message-fields { display: grid; grid-template-columns: minmax(0, 3fr) minmax(10rem, 1.3fr) auto auto; align-items: end; gap: var(--space-2) var(--space-3); padding: var(--space-3); }
  .message-fields > label, .field-group, .prop-grid > label { display: grid; gap: var(--space-1); min-width: 0; }
  .message-fields > label > span, .field-group > span, .prop-grid > label > span { color: var(--text-2); font-size: var(--text-caption); }
  .will-pane .message-fields { padding: 0; }
  .inline-check { display: flex !important; align-items: center; gap: var(--space-1-5); min-height: 2rem; font-size: var(--text-label); cursor: pointer; }
  .inline-check > span { color: var(--text) !important; font-size: var(--text-label) !important; }
  .message-tools { justify-content: flex-start; gap: var(--space-2); }
  .message-actions { display: flex; align-items: center; gap: var(--space-2); margin-inline-start: auto; }
  .count { margin-inline-start: var(--space-1); padding: 0 var(--space-1); border-radius: var(--radius-sm); background: var(--elevated); color: var(--text-2); font-size: var(--text-micro); }
  .message-props { display: flex; flex-direction: column; gap: var(--space-2); padding: var(--space-2-5) var(--space-3); border-bottom: 0.0625rem solid var(--border-subtle); background: var(--surface); }
  .message-value { display: flex; flex: 1; flex-direction: column; min-height: 6rem; }
  .will-editor { height: 10rem; border: 0.0625rem solid var(--border-subtle); border-radius: var(--radius-md); overflow: hidden; }
  .will-head { display: flex; align-items: center; justify-content: space-between; gap: var(--space-3); }
  .will-props { display: flex; flex-direction: column; gap: var(--space-2); }
  .section-label { font-size: var(--text-label); }
  .prop-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(12rem, 1fr)); align-items: end; gap: var(--space-2) var(--space-3); }
  .topic-table { display: flex; flex-direction: column; border: 0.0625rem solid var(--border-subtle); border-radius: var(--radius-md); }
  .topic-row { display: grid; grid-template-columns: 6rem minmax(0, 2fr) 6.5rem minmax(0, 1.5fr) 1.75rem; align-items: center; gap: var(--space-2); min-height: 2.5rem; padding-inline: var(--space-2); font-size: var(--text-label); }
  .topic-row { border-top: 0.0625rem solid var(--border-subtle); }
  .topic-row > span { display: block; min-width: 0; }
  .topic-row > span:not(.subscribe-cell) > :global(*), .topic-row :global(input:not([type='checkbox'])) { width: 100%; }
  .topic-head { min-height: 1.75rem; color: var(--text-3); font-size: var(--text-micro); font-weight: var(--weight-medium); }
  .topic-row > .subscribe-cell { display: flex; align-items: center; gap: var(--space-1-5); }
  .live-dot { display: inline-block; flex: none; width: 0.4375rem; height: 0.4375rem; border-radius: 50%; background: var(--success); }
  .add-topic { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); }
  .add-topic input { flex: 1; min-width: 12rem; }
  .field-error { flex-basis: 100%; color: var(--danger); font-size: var(--text-caption); }
  @container (max-width: 40rem) {
    .message-fields { grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); }
    .topic-field { grid-column: span 2; }
  }
</style>
