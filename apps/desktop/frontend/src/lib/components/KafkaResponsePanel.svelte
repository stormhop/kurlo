<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import { kafkaDiscovery, kafkaStreams } from '../stores/kafka.svelte';
  import type { KafkaRecord } from '../kafka';
  import { tabListKeyboard } from '../a11y';
  import ScriptResults from './ScriptResults.svelte';
  import Select from './Select.svelte';
  import Keycaps from './Keycaps.svelte';
  import KurloBird from './KurloBird.svelte';
  import { clipboardCopy } from '../utils';
  import VirtualList from './VirtualList.svelte';

  type DetailTab = 'value' | 'key' | 'headers' | 'metadata';

  let query = $state('');
  let topic = $state('');
  let detail = $state<DetailTab>('value');
  let selected = $state.raw<KafkaRecord>();
  let tab = $state<'stream' | 'tests'>('stream');
  let records = $derived.by((): KafkaRecord[] => {
    if (vm.loading) return kafkaStreams.get(vm.activeRequestId) ?? [];
    try {
      const parsed = JSON.parse(vm.response?.body || '[]');
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  });
  let topics = $derived([...new Set(records.map(record => record.topic))]);
  let filtered = $derived.by(() => {
    const needle = query.toLowerCase();
    return records.filter(r => (!topic || r.topic === topic) && (!needle || [r.topic, r.key, r.value, r.offset].some(v => v?.toLowerCase().includes(needle))));
  });
  let rows = $derived(filtered.map((record, index) => ({ key: record.topic + '/' + record.partition + '/' + (record.offset ?? 'i' + index), height: 30, record })));
  let current = $derived(selected && filtered.includes(selected) ? selected : filtered[0]);
  let testCount = $derived((vm.response?.testResult?.tests?.length ?? 0) + (vm.response?.preRequestResult?.tests?.length ?? 0));
  let started = $derived(vm.loading || !!vm.response);
  let error = $derived(vm.requestError || vm.response?.error || kafkaDiscovery.error);
  let status = $derived(vm.loading ? (vm.kafka.mode === 'consume' ? 'Streaming' : 'Producing') : vm.response?.status ?? '');

  function pretty(text: string | null | undefined) {
    if (text === null || text === undefined) return 'null';
    try { return JSON.stringify(JSON.parse(text), null, 2); } catch { return text; }
  }

  let detailText = $derived.by(() => {
    if (!current) return '';
    if (detail === 'key') return pretty(current.key);
    if (detail === 'headers') return current.headers?.length ? current.headers.map(h => `${h.key}: ${h.value ?? 'null'}`).join('\n') : 'No headers';
    if (detail === 'metadata') {
      const { value: _value, key: _key, headers: _headers, ...rest } = current;
      return JSON.stringify(rest, null, 2);
    }
    return pretty(current.value);
  });

  function time(value: string) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? value : date.toLocaleTimeString('en-US', { hour12: false });
  }

  function preview(value: string | null) {
    return value === null ? 'null' : value.replace(/\s+/g, ' ');
  }
</script>

<div class="response-area ws-panel kafka-response" aria-label="Kafka response">
  {#if !started && !error}
    <div class="response-placeholder response-empty-state" role="status">
      <svg width="2rem" height="2rem" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.35" aria-hidden="true">
        <path d="M6 4.1v2.2M6 9.7v2.2M7.5 7.2l2.6-1.4M7.5 8.8l2.6 1.4" />
        <circle cx="6" cy="8" r="1.75" /><circle cx="6" cy="2.6" r="1.35" /><circle cx="6" cy="13.4" r="1.35" /><circle cx="11.5" cy="5" r="1.35" /><circle cx="11.5" cy="11" r="1.35" />
      </svg>
      <span class="response-placeholder-text">{vm.kafka.mode === 'consume' ? 'Consume to stream records from the selected topics' : 'Produce a record to see what the broker stored'}</span>
      {#if vm.shortcutCombo('send-request')}<span class="response-placeholder-hint"><Keycaps combo={vm.shortcutCombo('send-request')} runtime={vm.appRuntime} /> to {vm.kafka.mode === 'consume' ? 'consume' : 'produce'}</span>{/if}
    </div>
  {:else if error && !records.length && !vm.loading}
    <div class="response-placeholder error" role="textbox" aria-readonly="true" tabindex="0">
      <div class="request-error-shell">
        <div class="request-error-title">{kafkaDiscovery.error && !vm.response ? 'Could not reach the brokers' : 'The broker returned an error'}</div>
        <div class="request-error-card">
          <svg width="1.25rem" height="1.25rem" viewBox="0 0 20 20" fill="none" aria-hidden="true">
            <path d="M10 2l8 14H2L10 2z" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/>
            <path d="M10 7v4M10 14v.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>
          </svg>
          <span>{error}</span>
        </div>
      </div>
    </div>
  {:else}
    <div class="response-status-bar">
      <div class="status-left">
        <span class="kafka-status" class:live={vm.loading} class:stopped={!vm.loading && status === 'Stopped'}>{#if vm.loading}<span class="live-dot" aria-hidden="true"></span>{/if}{status}</span>
        <span class="status-meta">{records.length} {records.length === 1 ? 'record' : 'records'}</span>
        {#if !vm.loading && vm.response?.duration}<span class="status-meta">{vm.response.duration} ms</span>{/if}
      </div>
      <div class="status-right"></div>
      <div class="tab-bar response-mini-tabs" role="tablist" use:tabListKeyboard>
        <button class="tab" role="tab" type="button" class:active={tab === 'stream'} aria-selected={tab === 'stream'} tabindex={tab === 'stream' ? 0 : -1} onclick={() => tab = 'stream'}>
          Records{#if records.length}<span class="badge">{records.length}</span>{/if}
        </button>
        <button class="tab" role="tab" type="button" class:active={tab === 'tests'} aria-selected={tab === 'tests'} tabindex={tab === 'tests' ? 0 : -1} onclick={() => tab = 'tests'}>
          Test results{#if testCount}<span class="badge">{testCount}</span>{/if}
        </button>
      </div>
    </div>

    {#if error}<div class="stream-error" role="status">{error}</div>{/if}

    {#if tab === 'tests'}
      <div class="response-tab-panel test-results-panel" role="tabpanel"><ScriptResults preRequestResult={vm.response?.preRequestResult} testResult={vm.response?.testResult} /></div>
    {:else if !records.length}
      <div class="response-placeholder response-loading-state" role="status">
        {#if vm.loading}
          <span class="response-waiting-bird"><KurloBird mode="flying" envelope size="3.25rem" /></span>
          <span class="response-placeholder-text">Waiting for records…</span>
        {:else}
          <span class="response-placeholder-text">No records received.</span>
        {/if}
      </div>
    {:else}
      <div class="stream-columns" role="tabpanel">
        <section class="record-list" aria-label="Kafka records">
          <div class="stream-filters">
            <input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck="false" class="field field-md" aria-label="Search records" placeholder="Search key, value or offset" bind:value={query} />
            {#if topics.length > 1}
              <Select size="md" floating ariaLabel="Filter by topic" bind:value={topic} options={[{ value: '', label: 'All topics' }, ...topics.map(value => ({ value, label: value }))]} />
            {/if}
          </div>
          <div class="record-head" aria-hidden="true"><span>Time</span><span>Topic</span><span>Partition / offset</span><span>Key</span><span>Value</span><span>Schema</span></div>
          {#if rows.length}
            <VirtualList {rows} rowHeight={30} className="record-rows" ariaLabel="Records">
              {#snippet row({ record: r })}
                <button type="button" class="kafka-record" class:chosen={r === current} aria-pressed={r === current} onclick={() => selected = r}>
                  <time>{time(r.timestamp)}</time>
                  <span class="record-topic">{r.topic}</span>
                  <span class="record-pos">{r.partition}{r.offset ? ' / ' + r.offset : ''}</span>
                  <span class="record-key" class:muted={r.key === null}>{r.key ?? '—'}</span>
                  <span class="record-preview" class:muted={r.value === null}>{preview(r.value)}</span>
                  <span class="validation" class:bad={!!r.schemaIssue}>{r.validation ?? ''}</span>
                </button>
              {/snippet}
            </VirtualList>
          {:else}<p class="record-empty">No matching records.</p>{/if}
        </section>
        <section class="record-detail" aria-label="Selected Kafka record">
          <div class="detail-bar">
            <div class="segmented" role="tablist" aria-label="Record part">
              {#each [['value', 'Value'], ['key', 'Key'], ['headers', 'Headers'], ['metadata', 'Metadata']] as [id, label] (id)}
                <button type="button" role="tab" class="segmented-item" class:active={detail === id} aria-selected={detail === id} onclick={() => detail = id as DetailTab}>{label}{#if id === 'headers' && current?.headers?.length}<span class="detail-count">{current.headers.length}</span>{/if}</button>
              {/each}
            </div>
            {#if detail === 'value' && current?.encoding}<span class="detail-meta">{current.encoding}</span>{/if}
            {#if detail === 'key' && current?.keyEncoding}<span class="detail-meta">{current.keyEncoding}</span>{/if}
            <button type="button" class="btn btn-ghost btn-sm copy" disabled={!current} onclick={() => clipboardCopy(detailText)}>Copy</button>
          </div>
          {#if current?.schemaIssue}<div class="stream-error">{current.schemaIssue}</div>{/if}
          <pre>{detailText}</pre>
        </section>
      </div>
    {/if}
  {/if}
</div>

<style>
  .kafka-response { display: flex; flex: 1; flex-direction: column; min-width: 0; min-height: 0; overflow: hidden; container-type: inline-size; }
  .kafka-status { display: inline-flex; align-items: center; gap: var(--space-1-5); color: var(--success); font-size: var(--text-label); font-weight: var(--weight-medium); }
  .kafka-status.live { color: var(--accent-text); }
  .kafka-status.stopped { color: var(--text-2); }
  .live-dot { width: 0.4375rem; height: 0.4375rem; border-radius: 50%; background: currentColor; animation: kafka-pulse 1.2s ease-in-out infinite; }
  @keyframes kafka-pulse { 50% { opacity: 0.3; } }
  .stream-columns { flex: 1; display: grid; grid-template-columns: minmax(0, 3fr) minmax(0, 2fr); min-height: 0; }
  section { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
  .record-detail { border-inline-start: 0.0625rem solid var(--border); }
  .stream-filters { display: flex; align-items: center; gap: var(--space-2); padding: var(--space-2); }
  .stream-filters input { flex: 1; min-width: 0; }
  .record-head, .kafka-record { display: grid; grid-template-columns: 4.5rem minmax(4rem, 1fr) 6.5rem minmax(3rem, 0.8fr) minmax(0, 2fr) 3rem; align-items: center; gap: var(--space-2); padding: 0 var(--space-2-5); }
  .record-head { height: 1.75rem; border-block: 0.0625rem solid var(--border-subtle); color: var(--text-3); font-size: var(--text-micro); font-weight: var(--weight-medium); }
  section > :global(.record-rows) { flex: 1 1 0; min-height: 0; }
  .kafka-record { width: 100%; height: 1.875rem; border: none; border-bottom: 0.0625rem solid var(--border-subtle); background: transparent; color: var(--text); font: inherit; font-size: var(--text-caption); text-align: start; cursor: pointer; }
  .kafka-record:hover { background: var(--hover); }
  .kafka-record.chosen { background: var(--accent-dim); }
  .kafka-record > span, .kafka-record > time { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
  .kafka-record time, .record-pos { color: var(--text-3); font-family: var(--font-mono); font-variant-numeric: tabular-nums; }
  .record-topic { color: var(--accent-text); }
  .record-key, .record-preview { font-family: var(--font-mono); }
  .muted { color: var(--text-3); }
  .validation { color: var(--success); font-size: var(--text-micro); text-align: end; }
  .validation.bad { color: var(--danger); }
  .record-empty { padding: var(--space-3); color: var(--text-3); font-size: var(--text-caption); }
  .detail-bar { display: flex; flex-wrap: wrap; align-items: center; gap: var(--space-2); padding: var(--space-2); }
  .detail-meta { color: var(--text-3); font-size: var(--text-caption); }
  .detail-count { margin-inline-start: var(--space-1); color: var(--text-3); }
  .copy { margin-inline-start: auto; }
  pre { flex: 1; margin: 0; overflow: auto; padding: var(--space-2) var(--space-3); white-space: pre-wrap; overflow-wrap: anywhere; color: var(--text); font: var(--text-code) / var(--leading-normal) var(--font-mono); -webkit-user-select: text; user-select: text; }
  .stream-error { padding: var(--space-2) var(--space-3); color: var(--danger); font-size: var(--text-label); overflow-wrap: anywhere; }
  @container (max-width: 46rem) {
    .stream-columns { grid-template-columns: minmax(0, 3fr) minmax(11rem, 2fr); }
    .record-head, .kafka-record { grid-template-columns: 4rem minmax(3rem, 1fr) minmax(0, 1.5fr); padding-inline: var(--space-2); }
    .record-head > :nth-child(3), .record-head > :nth-child(4), .record-head > :nth-child(6), .record-pos, .record-key, .validation { display: none; }
    .stream-filters { flex-wrap: wrap; }
    .detail-bar :global(.segmented-item) { padding-inline: var(--space-1-5); }
  }
</style>
