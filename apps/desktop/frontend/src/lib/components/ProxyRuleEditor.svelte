<script lang="ts">
  import { untrack } from 'svelte';
  import ProxyDialog from './ProxyDialog.svelte';
  import Disclosure from './Disclosure.svelte';
  import Select from './Select.svelte';
  import AddCloseIcon from './AddCloseIcon.svelte';
  import CodeEditor from '../CodeEditor.svelte';
  import { vm } from '../stores/app.svelte';
  import type { ProxyEntry, ProxyHeaderValue, ProxyRule } from '../wire';
  import { compileRulePattern, headerNames, ruleMatches } from '../captureRules';

  let {
    initial,
    isNew,
    busy,
    entries,
    error = '',
    warning = '',
    onSave,
    onDismiss,
    onLoadFile,
  }: {
    initial: ProxyRule;
    isNew: boolean;
    busy: boolean;
    entries: ProxyEntry[];
    error?: string;
    warning?: string;
    onSave: (rule: ProxyRule) => void;
    onDismiss: () => void;
    onLoadFile: () => Promise<string | null>;
  } = $props();

  const METHODS = ['', 'GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'];
  const start = untrack(() => structuredClone($state.snapshot(initial)) as ProxyRule);
  start.rewrite ??= { target: '', pathFrom: '', pathTo: '', setRequestHeaders: [], removeRequestHeaders: [], setResponseHeaders: [], removeResponseHeaders: [] };
  start.rewrite.setRequestHeaders ??= [];
  start.rewrite.removeRequestHeaders ??= [];
  start.rewrite.setResponseHeaders ??= [];
  start.rewrite.removeResponseHeaders ??= [];
  let rule = $state<ProxyRule>(start);
  let removeRequest = $state(start.rewrite.removeRequestHeaders.join(', '));
  let removeResponse = $state(start.rewrite.removeResponseHeaders.join(', '));
  let exampleRequest = $state('');
  let problem = $state('');

  const patternValid = $derived(Boolean(compileRulePattern(rule.url)));
  const matched = $derived(patternValid ? entries.filter(entry => entry.method !== 'CONNECT' && ruleMatches(rule, entry.method, entry.url)) : []);
  const collections = $derived(vm.activeWorkspaceCollections());
  const exampleRequests = $derived(rule.kind === 'local' ? vm.requests.filter(request => collections.some(collection => collection.id === request.collectionId) && (request.examples?.length || request.exampleCount)) : []);
  const examples = $derived(exampleRequests.find(request => request.id === exampleRequest)?.examples ?? []);
  const bodyLanguage = $derived.by(() => {
    const media = rule.local.contentType.toLowerCase();
    if (media.includes('json')) return 'json' as const;
    if (media.includes('xml')) return 'xml' as const;
    if (media.includes('html')) return 'html' as const;
    if (media.includes('javascript')) return 'javascript' as const;
    return 'text' as const;
  });
  const title = $derived(`${isNew ? 'New' : 'Edit'} ${rule.kind === 'local' ? 'Map local' : 'Rewrite'} rule`);

  function chooseExample(id: string) {
    const response = examples.find(item => item.id === id)?.response;
    if (!response) return;
    rule.local.body = response.body;
    rule.local.status = response.statusCode;
    rule.local.contentType = response.headers.find(row => row.key.toLowerCase() === 'content-type')?.value || 'text/plain';
  }

  async function loadFile() {
    try {
      const text = await onLoadFile();
      if (text !== null) rule.local.body = text;
    } catch (cause) {
      problem = String(cause).replace(/^Error: /, '');
    }
  }

  function addHeader(list: ProxyHeaderValue[]) {
    list.push({ name: '', value: '' });
  }

  function submit() {
    if (!patternValid) {
      problem = 'Enter a URL pattern that starts with http://, https:// or *:// and includes a host.';
      return;
    }
    const next = $state.snapshot(rule) as ProxyRule;
    next.rewrite.setRequestHeaders = next.rewrite.setRequestHeaders.filter(header => header.name.trim());
    next.rewrite.setResponseHeaders = next.rewrite.setResponseHeaders.filter(header => header.name.trim());
    next.rewrite.removeRequestHeaders = headerNames(removeRequest);
    next.rewrite.removeResponseHeaders = headerNames(removeResponse);
    problem = '';
    onSave(next);
  }
</script>

{#snippet headerRows(list: ProxyHeaderValue[], label: string)}
  <div class="capture-header-rows" role="group" aria-label={label}>
    {#each list as header, index (index)}
      <div class="capture-header-row">
        <input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-mono field-md" aria-label={`${label} name ${index + 1}`} placeholder="Header" bind:value={header.name}>
        <input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-mono field-md" aria-label={`${label} value ${index + 1}`} placeholder="Value" bind:value={header.value}>
        <button class="btn btn-ghost btn-icon btn-sm" type="button" aria-label={`Remove ${label.toLowerCase()} ${index + 1}`} onclick={() => list.splice(index, 1)}><AddCloseIcon /></button>
      </div>
    {/each}
    <button class="btn btn-ghost btn-xs capture-add-header" type="button" onclick={() => addHeader(list)}>Add header</button>
  </div>
{/snippet}

<ProxyDialog {title} subtitle={rule.kind === 'local' ? 'Kurlo answers matching requests itself. Nothing is sent to the server.' : 'Kurlo changes matching requests before sending them, and their responses before returning them.'} submitLabel={isNew ? 'Add rule' : 'Save rule'} {busy} wide onSubmit={submit} {onDismiss}>
  {#if isNew}
    <div class="segmented capture-rule-type" role="radiogroup" aria-label="Rule type">
      <button class="segmented-item" type="button" role="radio" aria-checked={rule.kind === 'local'} onclick={() => (rule.kind = 'local')}>Map local</button>
      <button class="segmented-item" type="button" role="radio" aria-checked={rule.kind === 'rewrite'} onclick={() => (rule.kind = 'rewrite')}>Rewrite</button>
    </div>
  {/if}
  <label class="capture-dialog-field"><span>Name</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-md" placeholder="Optional" bind:value={rule.name} data-autofocus></label>
  <div class="capture-dialog-grid">
    <div class="capture-dialog-field"><span>Method</span>
      <Select bind:value={rule.method} options={METHODS.map(value => ({ value, label: value || 'Any method' }))} ariaLabel="Rule method" className="capture-dialog-select" />
    </div>
    <label class="capture-dialog-field capture-dialog-span"><span>URL pattern</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-mono field-md" class:invalid={rule.url.trim() !== '' && !patternValid} aria-invalid={rule.url.trim() !== '' && !patternValid} placeholder="https://api.example.com/orders/*" bind:value={rule.url}></label>
  </div>
  <p class="capture-option-note capture-rule-preview">
    {#if !rule.url.trim()}
      Use * for any characters. A host without a path matches every path on it.
    {:else if !patternValid}
      <span class="capture-warn">Start with http://, https:// or *:// and include a host.</span>
    {:else if matched.length}
      Matches {matched.length} recorded {matched.length === 1 ? 'request' : 'requests'}, for example <code>{matched[0].method} {matched[0].url}</code>.
    {:else}
      No recorded request matches yet. Use * for any characters.
    {/if}
  </p>

  {#if rule.kind === 'local'}
    <div class="capture-dialog-grid">
      <label class="capture-dialog-field"><span>Status</span><input type="number" class="field field-mono field-md" min="200" max="599" required bind:value={rule.local.status}></label>
      <label class="capture-dialog-field capture-dialog-span"><span>Content-Type</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-mono field-md" bind:value={rule.local.contentType}></label>
    </div>
    {#if exampleRequests.length}
      <div class="capture-dialog-grid">
        <div class="capture-dialog-field capture-dialog-span"><span>Use a saved example</span>
          <Select bind:value={exampleRequest} options={[{ value: '', label: 'Choose a request…' }, ...exampleRequests.map(request => ({ value: request.id, label: `${request.collection} / ${request.name}` }))]} ariaLabel="Saved request" className="capture-dialog-select" onChange={id => { if (id) void vm.ensureRequestExamples([id]); }} />
        </div>
        {#if examples.length}
          <div class="capture-dialog-field"><span>Example</span>
            <Select value="" options={[{ value: '', label: 'Choose…' }, ...examples.map(example => ({ value: example.id, label: example.name }))]} ariaLabel="Response example" className="capture-dialog-select" onChange={chooseExample} />
          </div>
        {/if}
      </div>
    {/if}
    <div class="capture-dialog-field">
      <span class="capture-dialog-label-row">Body <button class="btn btn-ghost btn-xs" type="button" onclick={loadFile}>Load file…</button></span>
      <div class="capture-code"><CodeEditor bind:value={rule.local.body} language={bodyLanguage} minHeight="9rem" maxHeight="18rem" ariaLabel="Local response body" placeholder="The response body Kurlo sends." /></div>
    </div>
    <Disclosure title="Network conditions" summary={rule.local.delayMs || rule.local.rateKiB || rule.local.errorPercent || rule.local.pause ? 'On' : 'Off'} storageKey="kurlo.proxy.ruleNetwork">
      <div class="capture-dialog-grid">
        <label class="capture-dialog-field"><span>Delay, ms</span><input type="number" class="field field-mono field-md" min="0" max="30000" required bind:value={rule.local.delayMs}></label>
        <label class="capture-dialog-field"><span>Speed, KiB/s (0 = unlimited)</span><input type="number" class="field field-mono field-md" min="0" max="16384" required bind:value={rule.local.rateKiB}></label>
        <label class="capture-dialog-field"><span>HTTP 503, %</span><input type="number" class="field field-mono field-md" min="0" max="100" required bind:value={rule.local.errorPercent}></label>
      </div>
      <label class="capture-option"><input class="check" type="checkbox" bind:checked={rule.local.pause}><span><span class="capture-option-title">Pause before sending</span><span class="capture-option-note">Edit the response and release it within 60 seconds.</span></span></label>
    </Disclosure>
    <Disclosure title="JavaScript hooks" summary={rule.local.script.trim() ? 'On' : 'Off'} storageKey="kurlo.proxy.ruleHooks">
      <div class="capture-code"><CodeEditor bind:value={rule.local.script} language="javascript" minHeight="7.5rem" maxHeight="18rem" ariaLabel="Local response hooks" placeholder={'function onResponse(request, response) { response.status = 202; }'} /></div>
    </Disclosure>
  {:else}
    <label class="capture-dialog-field"><span>Send to</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-mono field-md" placeholder="Keep the original server, or http://localhost:3000" bind:value={rule.rewrite.target}></label>
    <div class="capture-dialog-grid two">
      <label class="capture-dialog-field"><span>Replace in path</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-mono field-md" placeholder="/v1/" bind:value={rule.rewrite.pathFrom}></label>
      <label class="capture-dialog-field"><span>With</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-mono field-md" placeholder="/v2/" bind:value={rule.rewrite.pathTo} disabled={!rule.rewrite.pathFrom}></label>
    </div>
    <section class="capture-rule-section" aria-label="Request headers">
      <h3>Request headers</h3>
      {@render headerRows(rule.rewrite.setRequestHeaders, 'Request header')}
      <label class="capture-dialog-field"><span>Remove</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-mono field-md" placeholder="X-Debug, Cookie" bind:value={removeRequest}></label>
    </section>
    <section class="capture-rule-section" aria-label="Response headers">
      <h3>Response headers</h3>
      {@render headerRows(rule.rewrite.setResponseHeaders, 'Response header')}
      <label class="capture-dialog-field"><span>Remove</span><input autocomplete="off" autocorrect="off" autocapitalize="none" spellcheck={false} class="field field-mono field-md" placeholder="Content-Security-Policy" bind:value={removeResponse}></label>
    </section>
  {/if}
  {#if problem || error}<p class="mock-error" role="alert">{problem || error}</p>{:else if warning}<p class="capture-warn" role="status">{warning}</p>{/if}
</ProxyDialog>
