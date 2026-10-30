<script lang="ts">
  import { untrack } from 'svelte';
  import { vm } from '../stores/app.svelte';
  import CodeEditor from '../CodeEditor.svelte';
  import type { RequestExample } from '../types/models';

  let { example }: { example: RequestExample } = $props();

  let bodyDraft = $state(untrack(() => example.response.body));

  $effect(() => {
    const incoming = example.response.body;
    untrack(() => {
      if (incoming !== bodyDraft) bodyDraft = incoming;
    });
  });

  $effect(() => {
    const next = bodyDraft;
    untrack(() => {
      if (next !== example.response.body) vm.updateExampleResponse(example.id, { body: next });
    });
  });

  let warning = $derived(vm.exampleWarning(example));

  let bodyLanguage = $derived.by(() => {
    const media = example.response.bodyMediaType;
    if (media.includes('json')) return 'json' as const;
    if (media.includes('xml')) return 'xml' as const;
    if (media.includes('html')) return 'html' as const;
    if (media.includes('javascript')) return 'javascript' as const;
    return 'text' as const;
  });

  function sourceLabel(source: string) {
    if (source === 'captured') return 'Captured';
    if (source === 'openapi') return 'From OpenAPI';
    if (source === 'postman') return 'From Postman';
    return 'Manual';
  }
</script>

<div class="examples-detail">
  <div class="examples-detail-head">
    <label class="examples-field">
      <span>Status</span>
      <input
        class="field field-md examples-status-input"
        type="number"
        min="100"
        max="599"
        value={example.response.statusCode}
        oninput={(event) =>
          vm.updateExampleResponse(example.id, {
            statusCode: Number((event.currentTarget as HTMLInputElement).value) || 0,
          })}
      />
    </label>
    <label class="examples-field examples-field-grow">
      <span>Status text</span>
      <input
        class="field field-md examples-text-input"
        value={example.response.status}
        placeholder="201 Created"
        oninput={(event) =>
          vm.updateExampleResponse(example.id, { status: (event.currentTarget as HTMLInputElement).value })}
      />
    </label>
    <span class="examples-source" title="Where this example came from">{sourceLabel(example.source)}</span>
  </div>

  {#if warning}
    <p class="examples-warning" role="status">{warning}</p>
  {/if}

  <div class="examples-meta">
    <span class="examples-meta-item"><strong>Request</strong> {example.snapshot.method} {example.snapshot.url || '—'}</span>
    <span class="examples-meta-item"><strong>Match</strong> {example.match.pathTemplate}</span>
    {#if example.response.bodyMediaType}
      <span class="examples-meta-item"><strong>Type</strong> {example.response.bodyMediaType}</span>
    {/if}
  </div>

  {#if example.response.headers.length}
    <details class="examples-headers">
      <summary>Response headers ({example.response.headers.length})</summary>
      <table>
        <tbody>
          {#each example.response.headers as header (header.id)}
            <tr>
              <td class="examples-header-key">{header.key}</td>
              <td class="examples-header-value">{header.value || '—'}</td>
            </tr>
          {/each}
        </tbody>
      </table>
    </details>
  {/if}

  <div class="examples-body">
    <CodeEditor
      bind:value={bodyDraft}
      language={bodyLanguage}
      placeholder="The response body this example returns."
      ariaLabel="Example response body"
      fillHeight
    />
  </div>
</div>
