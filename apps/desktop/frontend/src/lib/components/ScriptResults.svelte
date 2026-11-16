<script lang="ts">
  import ScriptLogLine from './ScriptLogLine.svelte';

  type ScriptOutput = { tests?: Array<{ name: string; passed: boolean; error?: string }> | null; logs?: string[] | null; error?: string } | null | undefined;

  let { preRequestResult, testResult }: { preRequestResult: ScriptOutput; testResult: ScriptOutput } = $props();

  function testSummaryFor(tests: Array<{ passed: boolean }>) {
    if (!tests.length) return null;
    const passed = tests.filter(test => test.passed).length;
    return { passed, total: tests.length, allPassed: passed === tests.length };
  }

  let preRequestTests = $derived(preRequestResult?.tests ?? []);
  let preRequestTestSummary = $derived(testSummaryFor(preRequestTests));
  let responseTestSummary = $derived(testSummaryFor(testResult?.tests ?? []));
</script>

{#if preRequestResult?.error || preRequestResult?.tests?.length || preRequestResult?.logs?.length}
  <div class="script-result-block">
    <div class="script-result-header">
      <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><path d="M1.5 2.5h3l2 8h3.5M7.5 6h2.5" stroke="currentColor" stroke-width="1.2" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Pre-request
      {#if preRequestResult.error}
        <span class="script-error-badge">Error</span>
      {:else if preRequestTestSummary}
        <span class:script-ok-badge={preRequestTestSummary.allPassed} class:script-fail-badge={!preRequestTestSummary.allPassed}>{preRequestTestSummary.passed}/{preRequestTestSummary.total} passed</span>
      {:else}
        <span class="script-ok-badge">OK</span>
      {/if}
    </div>
    {#if preRequestResult.error}
      <div class="script-error-msg">{preRequestResult.error}</div>
    {/if}
    {#each preRequestTests as t, eachIndex (eachIndex)}
      <div class="test-row" class:pass={t.passed} class:fail={!t.passed}>
        <span class="test-icon">
          {#if t.passed}
            <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M4 6.5l2 2 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          {:else}
            <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 4.5l4 4M8.5 4.5l-4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          {/if}
        </span>
        <span class="test-name">{t.name}</span>
        {#if t.error}<span class="test-err">{t.error}</span>{/if}
      </div>
    {/each}
    {#each (preRequestResult.logs ?? []) as log, eachIndex (eachIndex)}
      <ScriptLogLine line={log} />
    {/each}
  </div>
{/if}

{#if testResult?.tests?.length || testResult?.error || testResult?.logs?.length}
  <div class="script-result-block">
    <div class="script-result-header">
      <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><path d="M2 6.5l2.5 2.5 6.5-5.5" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
      Tests
      {#if responseTestSummary}
        <span class:script-ok-badge={responseTestSummary.allPassed} class:script-fail-badge={!responseTestSummary.allPassed}>{responseTestSummary.passed}/{responseTestSummary.total} passed</span>
      {/if}
    </div>
    {#if testResult.error}
      <div class="script-error-msg">{testResult.error}</div>
    {/if}
    {#each (testResult.tests ?? []) as t, eachIndex (eachIndex)}
      <div class="test-row" class:pass={t.passed} class:fail={!t.passed}>
        <span class="test-icon">
          {#if t.passed}
            <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M4 6.5l2 2 3-3" stroke="currentColor" stroke-width="1.3" stroke-linecap="round" stroke-linejoin="round"/></svg>
          {:else}
            <svg width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none"><circle cx="6.5" cy="6.5" r="5.5" stroke="currentColor" stroke-width="1.3"/><path d="M4.5 4.5l4 4M8.5 4.5l-4 4" stroke="currentColor" stroke-width="1.3" stroke-linecap="round"/></svg>
          {/if}
        </span>
        <span class="test-name">{t.name}</span>
        {#if t.error}<span class="test-err">{t.error}</span>{/if}
      </div>
    {/each}
    {#each (testResult.logs ?? []) as log, eachIndex (eachIndex)}
      <ScriptLogLine line={log} />
    {/each}
  </div>
{/if}

{#if !testResult?.tests?.length && !preRequestResult?.tests?.length && !testResult?.error && !preRequestResult?.error && !preRequestResult?.logs?.length && !testResult?.logs?.length}
  <div class="test-results-empty">No scripts ran for this request.</div>
{/if}
