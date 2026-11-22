<script lang="ts">
  import CodeEditor from '../CodeEditor.svelte';
  import { completeScript, type ScriptScope } from '../scriptCompletion';
  import { vm } from '../stores/app.svelte';
  import type { Collection, KVRow } from '../types/models';

  let { value = $bindable(''), tests = false, collection, requestVariables = [], placeholder, testId, ariaLabel }: {
    value?: string;
    tests?: boolean;
    collection?: Collection;
    requestVariables?: KVRow[];
    placeholder: string;
    testId?: string;
    ariaLabel: string;
  } = $props();

  const keys = (rows: KVRow[]) => rows.filter(row => row.enabled && row.key.trim()).map(row => row.key.trim());
  const environment = $derived(vm.environmentVariableSuggestions().map(row => row.key));
  const globals = $derived(keys(vm.globalVariables));
  const collectionVariables = $derived(keys(collection?.defaults.variables ?? []));
  const variables = $derived([...keys(requestVariables), ...environment, ...collectionVariables, ...globals]);
  const requests = $derived(vm.requests.filter(request => collection && request.collectionId === collection.id && !request.isDraft).map(request => request.name));
  function names(scope: ScriptScope) {
    switch (scope) {
      case 'environment': return environment;
      case 'collectionVariables': return collectionVariables;
      case 'globals': return globals;
      case 'requests': return requests;
      case 'variables': return variables;
    }
  }
</script>

<CodeEditor bind:value language="javascript" fillHeight {placeholder} {testId} {ariaLabel}
  completionSource={context => completeScript(context, { tests, names })} />
