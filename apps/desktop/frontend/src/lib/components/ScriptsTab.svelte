<script lang="ts">
  import { tabListKeyboard } from '../a11y';
  import { vm } from '../stores/app.svelte';
  import { scriptLineCount } from '../utils';
  import { appendSnippet, preRequestSnippets, testSnippets } from '../scriptSnippets';
  import CodeEditor from '../CodeEditor.svelte';
  import AssertionsEditor from './AssertionsEditor.svelte';
  import { assertionsForStore, requestTypeSupportsAssertions } from '../assertions';

  const assertionsAvailable = $derived(requestTypeSupportsAssertions(vm.requestType));
  const assertionCount = $derived(assertionsForStore(vm.assertions).length);
  const activeTab = $derived(vm.scriptTab === 'assertions' && !assertionsAvailable ? 'tests' : vm.scriptTab);

  const hint = $derived(activeTab === 'pre-request' ? 'JavaScript · runs before the request is sent' : activeTab === 'tests' ? 'JavaScript · runs after the response is received' : 'checked after the tests, no code needed');
</script>

<div class="script-section">
  <div class="script-head">
    <div class="segmented subtabs" role="tablist" use:tabListKeyboard>
      <button class="segmented-item" role="tab" class:active={activeTab === 'pre-request'} aria-selected={activeTab === 'pre-request'} tabindex={activeTab === 'pre-request' ? 0 : -1} type="button" onclick={() => (vm.scriptTab = 'pre-request')}>
        Pre-request{#if scriptLineCount(vm.preRequestScriptJs) > 0}<span class="subtab-count">{scriptLineCount(vm.preRequestScriptJs)}</span>{/if}
      </button>
      <button class="segmented-item" role="tab" class:active={activeTab === 'tests'} aria-selected={activeTab === 'tests'} tabindex={activeTab === 'tests' ? 0 : -1} type="button" onclick={() => (vm.scriptTab = 'tests')}>
        Tests{#if scriptLineCount(vm.testScriptJs) > 0}<span class="subtab-count">{scriptLineCount(vm.testScriptJs)}</span>{/if}
      </button>
      {#if assertionsAvailable}
        <button class="segmented-item" role="tab" class:active={activeTab === 'assertions'} aria-selected={activeTab === 'assertions'} tabindex={activeTab === 'assertions' ? 0 : -1} type="button" onclick={() => (vm.scriptTab = 'assertions')}>
          Assertions{#if assertionCount > 0}<span class="subtab-count">{assertionCount}</span>{/if}
        </button>
      {/if}
    </div>
    <span class="script-hint">{hint}</span>
  </div>
  {#if activeTab === 'pre-request'}
    <div class="script-ref">
      <span class="ref-title">Snippets</span>
      {#each preRequestSnippets as snippet (snippet.label)}
        <button
          class="btn btn-secondary btn-sm script-snippet"
          type="button"
          aria-label="Insert snippet: {snippet.label}"
          data-testid="script-snippet"
          onclick={() => (vm.preRequestScriptJs = appendSnippet(vm.preRequestScriptJs, snippet.code))}
        >
          {snippet.label}
        </button>
      {/each}
    </div>
    <CodeEditor
      bind:value={vm.preRequestScriptJs}
      language="javascript"
      placeholder={'pm.environment.set("baseUrl", "https://api.example.com")'}
      fillHeight
      testId="pre-request-script-editor"
      ariaLabel="Pre-request script editor"
    />
  {:else if activeTab === 'assertions'}
    <AssertionsEditor />
  {:else}
    <div class="script-ref">
      <span class="ref-title">Snippets</span>
      {#each testSnippets as snippet (snippet.label)}
        <button
          class="btn btn-secondary btn-sm script-snippet"
          type="button"
          aria-label="Insert snippet: {snippet.label}"
          data-testid="script-snippet"
          onclick={() => (vm.testScriptJs = appendSnippet(vm.testScriptJs, snippet.code))}
        >
          {snippet.label}
        </button>
      {/each}
    </div>
    <CodeEditor
      bind:value={vm.testScriptJs}
      language="javascript"
      placeholder={'pm.test("Status is 200", () => pm.expect(pm.response.code).to.eql(200))'}
      fillHeight
      testId="test-script-editor"
      ariaLabel="Test script editor"
    />
  {/if}
</div>
