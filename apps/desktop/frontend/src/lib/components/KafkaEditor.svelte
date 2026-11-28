<script lang="ts">
  import CodeEditor from '../CodeEditor.svelte';
  import { vm } from '../stores/app.svelte';
  import { kafkaDiscovery } from '../stores/kafka.svelte';
  import Select from './Select.svelte';
  import VariableInput from './VariableInput.svelte';
  import FilePathField from './FilePathField.svelte';
  import ClientCertSetting from './ClientCertSetting.svelte';
  import Chevron from './Chevron.svelte';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import VirtualList from './VirtualList.svelte';

  let filter = $state('');
  let newTopic = $state('');
  let expanded = $state('');
  let visible = $derived(kafkaDiscovery.topics.filter(name => name.toLowerCase().includes(filter.toLowerCase())).map(name => ({ key: name, height: 30, name })));
  let chosen = $derived(new Set(vm.kafka.topics.map(t => t.name)));
  const choices = (values: string[]) => values.map(value => ({ value, label: value[0].toUpperCase() + value.slice(1) }));
  function toggle(name: string) {
    const rows = vm.kafka.topics;
    vm.kafka.topics = rows.some(t => t.name === name) ? rows.filter(t => t.name !== name) : [...rows, { name }];
    if (expanded === name) expanded = '';
  }
  function addTopic() {
    const name = newTopic.trim();
    if (!name) return;
    if (!vm.kafka.topics.some(t => t.name === name)) toggle(name);
    newTopic = '';
  }
  function changeStop(value: string) {
    vm.kafka.stopValue = value === 'records' ? '1000' : value === 'timestamp' ? '' : '5000';
  }
</script>

{#if vm.requestTab === 'settings'}
  <div class="settings-section">
    <div class="settings-header">
      <div>
        <span class="settings-title">Broker connection</span>
        <span class="settings-subtitle">TLS, compression and timeouts for this request.</span>
      </div>
      <div class="settings-actions">
        <button class="btn btn-ghost" type="button" onclick={vm.resetRequestSettings}>Reset</button>
        <button class="btn btn-secondary" class:feedback-ok={vm.settingsSaved} type="button" onclick={vm.saveRequestSettings}>
          {vm.settingsSaved ? 'Saved as default' : 'Save as default'}
        </button>
      </div>
    </div>
    <div class="settings-list">
      <label class="postman-setting">
        <span class="setting-copy">
          <strong>Secure connection (TLS)</strong>
          <span>Connect to the brokers over TLS.</span>
        </span>
        <span class="switch-control">
          <input type="checkbox" bind:checked={vm.kafka.tls} />
          <span class="switch-track"></span>
          <span class="switch-state">{vm.kafka.tls ? 'ON' : 'OFF'}</span>
        </span>
      </label>
      {#if vm.kafka.tls}
        <label class="postman-setting">
          <span class="setting-copy">
            <strong>Verify server certificate</strong>
            <span>Check the broker certificate against trusted authorities.</span>
            {#if vm.collectionSettingDefaultNote('enableSSLVerification')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('enableSSLVerification')}>{vm.collectionSettingDefaultNote('enableSSLVerification')}</em>{/if}
          </span>
          <span class="switch-control">
            <input type="checkbox" bind:checked={vm.enableSSLVerification} onchange={() => vm.markRequestSettingOverride('enableSSLVerification')} />
            <span class="switch-track"></span>
            <span class="switch-state">{vm.enableSSLVerification ? 'ON' : 'OFF'}</span>
          </span>
        </label>
        <ClientCertSetting description="Present a client certificate when the broker requires mutual TLS." />
      {/if}
      <div class="postman-setting">
        <span class="setting-copy">
          <strong>Compression</strong>
          <span>Codec for produced record batches.</span>
        </span>
        <Select ariaLabel="Compression" bind:value={vm.kafka.compression} options={choices(['none', 'gzip', 'snappy', 'lz4', 'zstd'])} className="setting-select" />
      </div>
      <label class="postman-setting">
        <span class="setting-copy">
          <strong>Request timeout</strong>
          <span>How long to wait for the brokers to connect and acknowledge. Consume then streams until its stop condition. 0 waits indefinitely.</span>
          {#if vm.collectionSettingDefaultNote('timeoutMs')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('timeoutMs')}>{vm.collectionSettingDefaultNote('timeoutMs')}</em>{/if}
        </span>
        <span class="setting-inline-number">
          <input class="field setting-number" type="number" min="0" step="1000" bind:value={vm.timeoutMs} oninput={() => vm.markRequestSettingOverride('timeoutMs')} />
          <span>ms</span>
        </span>
      </label>
    </div>
  </div>
{:else if vm.kafka.mode === 'consume'}
  <div class="kafka-consume">
    <section class="broker-topics" aria-label="Broker topics">
      <div class="pane-head"><strong>Broker topics</strong>{#if kafkaDiscovery.tested}<span class="pane-meta">{kafkaDiscovery.topics.length}</span>{/if}</div>
      <input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md" aria-label="Filter topics" placeholder="Filter topics" bind:value={filter} disabled={!kafkaDiscovery.tested} />
      {#if visible.length}
        <VirtualList rows={visible} rowHeight={30} className="topic-list" ariaLabel="Topics on the broker">
          {#snippet row({ name })}
            <label class="topic-option"><input type="checkbox" class="check" checked={chosen.has(name)} onchange={() => toggle(name)} /><span>{name}</span></label>
          {/snippet}
        </VirtualList>
      {:else}
        <p class="pane-empty">{kafkaDiscovery.tested ? (kafkaDiscovery.topics.length ? 'No matching topics.' : 'The cluster has no topics yet.') : 'Test the connection to list the cluster topics, or add a topic by name.'}</p>
      {/if}
    </section>
    <section class="subscription" aria-label="Consume settings">
      <div class="pane-head"><strong>Topics to stream</strong><span class="pane-meta">{vm.kafka.topics.length}</span></div>
      {#if vm.kafka.topics.length}
        <div class="sub-table">
          <div class="sub-row sub-head" aria-hidden="true"><span>Topic</span><span>Schema</span><span></span></div>
          {#each vm.kafka.topics as topic (topic.name)}
            <div class="sub-row">
              <button class="kafka-topic-name" type="button" aria-expanded={expanded === topic.name} aria-label={'Partitions and offsets for ' + topic.name} onclick={() => expanded = expanded === topic.name ? '' : topic.name}>
                <Chevron direction="right" open={expanded === topic.name} /><span>{topic.name}</span>{#if topic.partitions || topic.startOffset || topic.endOffset}<span class="topic-bounds-dot" aria-hidden="true"></span>{/if}
              </button>
              <FilePathField variant="cell" value={topic.schemaPath ?? ''} onchange={value => topic.schemaPath = value} ariaLabel={'Schema for ' + topic.name} dialogTitle="Choose AsyncAPI or JSON Schema" placeholder="Link schema" suggestions={vm.variableSuggestions} />
              <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label={'Remove ' + topic.name} onclick={() => toggle(topic.name)}><AddCloseIcon /></button>
            </div>
            {#if expanded === topic.name}
              <div class="bounds">
                <label><span>Partitions</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md" placeholder="All, or 0,1" bind:value={topic.partitions} /></label>
                <label><span>Start offset</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md" placeholder="From “Start from”" bind:value={topic.startOffset} /></label>
                <label><span>End offset (exclusive)</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md" placeholder="Unbounded" bind:value={topic.endOffset} /></label>
              </div>
            {/if}
          {/each}
        </div>
      {/if}
      <form class="add-topic" onsubmit={e => { e.preventDefault(); addTopic(); }}>
        <input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" aria-label="Topic name or pattern" class="field field-md" placeholder="Add topic name or ^pattern" bind:value={newTopic} />
        <button class="btn btn-secondary btn-sm" type="submit" disabled={!newTopic.trim()}>Add</button>
      </form>
      <div class="pane-head options-head"><strong>Consumer options</strong></div>
      <div class="options">
        <span class="option-label">Start from</span>
        <div class="option-controls">
          <Select ariaLabel="Start from" size="md" floating bind:value={vm.kafka.startFrom} options={choices(['earliest', 'latest', 'offset', 'timestamp'])} />
          {#if vm.kafka.startFrom === 'offset' || vm.kafka.startFrom === 'timestamp'}
            <input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md" aria-label="Start value" placeholder={vm.kafka.startFrom === 'offset' ? 'Offset' : 'RFC 3339 or Unix ms'} bind:value={vm.kafka.startValue} />
          {/if}
        </div>
        <span class="option-label">Stop after</span>
        <div class="option-controls">
          <Select ariaLabel="Stop after" size="md" floating bind:value={vm.kafka.stopAfter} onChange={changeStop} options={[{ value: 'records', label: 'Record count' }, { value: 'duration', label: 'Duration' }, { value: 'idle', label: 'Idle time' }, { value: 'timestamp', label: 'Timestamp' }]} />
          <input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md stop-value" aria-label="Stop value" placeholder={vm.kafka.stopAfter === 'timestamp' ? 'RFC 3339 or Unix ms' : ''} bind:value={vm.kafka.stopValue} />
          {#if vm.kafka.stopAfter !== 'timestamp'}<span class="option-unit">{vm.kafka.stopAfter === 'records' ? 'records' : 'ms'}</span>{/if}
        </div>
      </div>
    </section>
  </div>
{:else}
  <div class="kafka-producer">
    <div class="producer-fields">
      <label class="topic-field"><span>Topic</span><VariableInput ariaLabel="Producer topic" pickerOptions={kafkaDiscovery.topics} pickerLabel="Broker topics" className="field field-input" bind:value={vm.kafka.topic} suggestions={vm.variableSuggestions} placeholder="Topic name" /></label>
      <label><span>Partition</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-input" aria-label="Producer partition" bind:value={vm.kafka.partition} placeholder="Auto" /></label>
      <label><span>Timestamp</span><VariableInput ariaLabel="Producer timestamp" className="field field-input" bind:value={vm.kafka.timestamp} suggestions={vm.variableSuggestions} placeholder="Broker time" /></label>
      <div class="field-group"><span>Acks</span><Select ariaLabel="Acknowledgements" floating bind:value={vm.kafka.acks} options={[{ value: 'all', label: 'All replicas' }, { value: 'leader', label: 'Leader only' }, { value: 'none', label: 'None' }]} /></div>
      <div class="field-group key-field"><span>Key</span>
        <div class="key-controls">
          <Select ariaLabel="Key format" floating bind:value={vm.kafka.keyFormat} options={[{ value: 'text', label: 'Text' }, { value: 'json', label: 'JSON' }, { value: 'hex', label: 'Hex' }, { value: 'base64', label: 'Base64' }]} />
          <VariableInput ariaLabel="Message key" className="field field-input" bind:value={vm.kafka.key} suggestions={vm.variableSuggestions} placeholder="No key" />
        </div>
      </div>
    </div>
    <div class="body-editor-toolbar message-tools">
      <strong class="field-label">Value</strong>
      <Select size="sm" floating ariaLabel="Message format" bind:value={vm.kafka.format} options={[{ value: 'json', label: 'JSON' }, { value: 'text', label: 'Text' }, { value: 'hex', label: 'Hex' }, { value: 'base64', label: 'Base64' }, { value: 'tombstone', label: 'Tombstone (null)' }]} />
      <span class="schema-label">Schema</span>
      <FilePathField variant="cell" bind:value={vm.kafka.schemaPath} ariaLabel="Message schema" dialogTitle="Choose AsyncAPI or JSON Schema" placeholder="Link schema" suggestions={vm.variableSuggestions} />
    </div>
    <div class="message-value">
      {#if vm.kafka.format === 'tombstone'}<p class="tombstone-note">The record is sent with a null value. Compacted topics delete the key.</p>{:else}
      <CodeEditor bind:value={vm.bodyContent} language={vm.kafka.format === 'json' ? 'json' : 'text'} fillHeight compact testId="kafka-message-editor" ariaLabel="Kafka message value" variableSuggestions={vm.variableSuggestions} />
      {/if}
    </div>
  </div>
{/if}

<style>
  .kafka-producer, .kafka-consume { width: 100%; height: 100%; min-height: 0; color: var(--text); }
  .kafka-producer { display: flex; flex-direction: column; overflow: auto; }
  .producer-fields { display: grid; grid-template-columns: repeat(auto-fill, minmax(10rem, 1fr)); align-items: start; gap: var(--space-2) var(--space-3); padding: var(--space-3); }
  .producer-fields > label, .field-group { display: grid; gap: var(--space-1); min-width: 0; }
  .topic-field, .key-field { grid-column: span 2; }
  .producer-fields > label > span, .field-group > span, .bounds span, .option-label, .schema-label { color: var(--text-2); font-size: var(--text-caption); }
  .producer-fields input, .bounds input { width: 100%; min-width: 0; }
  .key-controls { display: grid; grid-template-columns: auto minmax(0, 1fr); gap: var(--space-1-5); }
  .tombstone-note { margin: var(--space-3); color: var(--text-2); font-size: var(--text-label); }
  .message-tools { justify-content: flex-start; gap: var(--space-2); }
  .schema-label { margin-inline-start: auto; }
  .message-value { display: flex; flex: 1; flex-direction: column; min-height: 4rem; }
  .kafka-consume { display: grid; grid-template-columns: minmax(12rem, 2fr) minmax(0, 3fr); container-type: size; }
  section { display: flex; flex-direction: column; gap: var(--space-2); min-width: 0; min-height: 0; padding: var(--space-2-5) var(--space-3); overflow: auto; }
  section > :global(*) { flex-shrink: 0; }
  .broker-topics { overflow: hidden; }
  .broker-topics > :global(.topic-list) { flex: 1 1 0; min-height: 4rem; }
  section + section { border-inline-start: 0.0625rem solid var(--border); }
  .pane-head { display: flex; align-items: center; gap: var(--space-2); font-size: var(--text-label); }
  .pane-meta { padding: 0 var(--space-1-5); border-radius: var(--radius-sm); background: var(--elevated); color: var(--text-3); font-size: var(--text-micro); }
  .pane-empty { margin: 0; padding: var(--space-2) 0; color: var(--text-3); font-size: var(--text-caption); }
  .topic-option { display: flex; align-items: center; gap: var(--space-2); height: 1.875rem; padding-inline: var(--space-1); border-radius: var(--radius-sm); font-size: var(--text-label); cursor: pointer; }
  .topic-option > span { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .topic-option:hover { background: var(--hover); }
  .sub-table { display: flex; flex-direction: column; border: 0.0625rem solid var(--border-subtle); border-radius: var(--radius-md); }
  .sub-row { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) 1.75rem; align-items: center; gap: var(--space-2); min-height: 2rem; padding-inline: var(--space-1-5); font-size: var(--text-label); }
  .sub-row + .sub-row, .bounds { border-top: 0.0625rem solid var(--border-subtle); }
  .sub-head { min-height: 1.625rem; color: var(--text-3); font-size: var(--text-micro); font-weight: var(--weight-medium); }
  .kafka-topic-name { display: flex; align-items: center; gap: var(--space-1-5); min-width: 0; height: 1.75rem; padding: 0 var(--space-1); border: none; border-radius: var(--radius-sm); background: transparent; color: var(--text); font: inherit; text-align: start; cursor: pointer; }
  .kafka-topic-name:hover { background: var(--hover); }
  .kafka-topic-name > span:not(.topic-bounds-dot) { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kafka-topic-name :global(.chevron) { flex: none; color: var(--text-3); transition: transform var(--dur-fast); }
  .kafka-topic-name :global(.chevron.open) { transform: rotate(90deg); }
  .topic-bounds-dot { flex: none; width: 0.375rem; height: 0.375rem; border-radius: 50%; background: var(--accent); }
  .bounds { display: grid; grid-template-columns: repeat(3, minmax(0, 1fr)); gap: var(--space-2); padding: var(--space-2) var(--space-2-5); background: var(--surface); }
  .bounds label { display: grid; gap: var(--space-1); min-width: 0; }
  .add-topic { display: flex; gap: var(--space-2); align-items: center; }
  .add-topic input { flex: 1; min-width: 0; }
  .options-head { margin-top: var(--space-2); }
  .options { display: grid; grid-template-columns: auto minmax(0, 1fr); align-items: center; gap: var(--space-2) var(--space-3); }
  .option-controls { display: flex; align-items: center; gap: var(--space-2); min-width: 0; }
  .option-controls input { flex: 1; min-width: 0; max-width: 14rem; }
  .option-unit { color: var(--text-3); font-size: var(--text-caption); }
  @container (max-width: 40rem) {
    .kafka-consume { grid-template-columns: minmax(0, 1fr); grid-template-rows: minmax(9rem, 2fr) minmax(0, 3fr); }
    section + section { border-inline-start: none; border-top: 0.0625rem solid var(--border); }
  }
</style>
