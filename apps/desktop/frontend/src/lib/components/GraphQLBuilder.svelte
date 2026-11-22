<script lang="ts">
  import { SvelteMap, SvelteSet } from 'svelte/reactivity';
  import { print } from 'graphql/language/printer';
  import type { SelectionSetNode } from 'graphql/language/ast';
  import { branchSelections, editBuilder, newOperation, operationDocument, type ArgumentEdit, type Branch, type OperationKind } from '../graphqlBuilder';
  import type { BuilderSchema } from '../graphql';
  import { vm } from '../stores/app.svelte';
  import BirdSpinner from './BirdSpinner.svelte';
  import Select from './Select.svelte';

  let { schema, showVariables }: { schema: BuilderSchema; showVariables: () => void } = $props();
  const expanded = new SvelteSet<string>();
  let error = $state('');
  const doc = $derived(operationDocument(vm.graphqlQuery));
  const active = $derived(doc?.operations.find(op => op.name?.value === vm.graphqlOperationName) ?? (!vm.graphqlOperationName && doc?.operations.length === 1 ? doc.operations[0] : undefined));
  const root = $derived(schema.roots[active?.operation ?? 'query']);
  const choices = $derived([
    ...(doc?.operations ?? []).map((op, i) => ({ value: String(i), label: op.name ? `${op.operation} ${op.name.value}` : op.operation })),
    ...Object.keys(schema.roots).map(kind => ({ value: '+' + kind, label: `New ${kind}…` })),
  ]);
  const branches = $derived.by(() => {
    const map = new SvelteMap<string, Branch[]>();
    for (const [name, type] of schema.types) {
      map.set(name, [...type.fields, ...type.possibleTypes.map(onType => ({ onType }))]);
    }
    return map;
  });

  function write(payload: ReturnType<typeof vm.currentGraphQLPayload>) {
    vm.graphqlQuery = payload.query;
    vm.graphqlVariables = payload.variables;
    vm.graphqlOperationName = payload.operationName;
    vm.scheduleActiveRequestPersist();
    error = '';
  }
  function choose(value: string) {
    if (!doc) return;
    const payload = vm.currentGraphQLPayload();
    if (value.startsWith('+')) write(newOperation(payload, value.slice(1) as OperationKind));
    else write({ ...payload, operationName: doc.operations[Number(value)].name?.value ?? '' });
    expanded.clear();
  }
  function edit(path: Branch[], arg?: ArgumentEdit) {
    try {
      write(editBuilder(vm.currentGraphQLPayload(), schema, path, arg));
      return true;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : 'Could not update the operation.';
      return false;
    }
  }
  function toggle(key: string) {
    if (expanded.has(key)) expanded.delete(key);
    else expanded.add(key);
  }
</script>

<div class="graphql-explorer-toolbar">
  <strong>Query builder</strong>
  <button class="btn btn-secondary btn-sm" type="button" onclick={() => vm.fetchGraphQLSchema()} disabled={vm.graphqlSchemaLoading || !vm.url.trim()}>
    {#if vm.graphqlSchemaLoading}<BirdSpinner />{/if}
    Refresh
  </button>
</div>
<div class="builder-operation">
  <Select value={active && doc ? String(doc.operations.indexOf(active)) : ''} options={choices} disabled={!doc} floating ariaLabel="GraphQL operation" onChange={choose} />
  {#if root}<span>{root}</span>{/if}
</div>
{#if !active || !root || error || vm.graphqlSchemaError}
  <p class="builder-message" role="status">{error || vm.graphqlSchemaError || (!active ? 'Choose an operation or finish editing the query to use the builder.' : 'This operation has no root type in the loaded schema.')}</p>
{/if}

{#snippet tree(typeName: string, parent: Branch[], sets: SelectionSetNode[], prefix: string)}
  {#each branches.get(typeName) ?? [] as branch ('onType' in branch ? 'on:' + branch.onType : branch.name)}
    {@const fragment = 'onType' in branch}
    {@const name = fragment ? '... on ' + branch.onType : branch.name}
    {@const nextType = fragment ? branch.onType : branch.namedType}
    {@const args = fragment ? [] : branch.args}
    {@const path = [...parent, branch]}
    {@const key = prefix + '.' + name}
    {@const matches = sets.flatMap(set => branchSelections(set, branch))}
    {@const selected = matches[0]}
    {@const expandable = args.length > 0 || !!branches.get(nextType)?.length}
    {@const open = expanded.has(key)}
    <div class="graphql-explorer-field" class:builder-selected={!!selected}>
      <div class="graphql-field-main">
        {#if expandable}
          <button class="btn btn-ghost btn-icon btn-xs builder-expand" aria-label={(open ? 'Collapse ' : 'Expand ') + name} aria-expanded={open} type="button" onclick={() => toggle(key)}>
            <svg class:open width="12" height="12" viewBox="0 0 12 12" fill="none" aria-hidden="true"><path d="m4.5 2.5 3.5 3.5-3.5 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/></svg>
          </button>
        {:else}
          <span class="builder-spacer"></span>
        {/if}
        <label class="builder-label">
          <input class="check" type="checkbox" checked={!!selected} disabled={!active} aria-label={name} onchange={e => {
            const checked = e.currentTarget.checked;
            if (edit(path)) {
              if (checked && expandable) expanded.add(key);
              else expanded.delete(key);
            } else e.currentTarget.checked = !!selected;
          }} />
          <span class="graphql-field-name">{name}</span>
        </label>
        {#if !fragment}<span class="graphql-field-type">{branch.type}</span>{/if}
      </div>
      {#if args.length && !open}
        <span class="graphql-field-args">{args.map(a => a.name + ': ' + a.type).join(', ')}</span>
      {/if}
    </div>
    {#if open && expandable}
      <div class="builder-children">
        {#if selected?.kind === 'Field' && args.length}
          <div class="builder-args">
            {#each args as arg (arg.name)}
              {@const binding = selected.arguments?.find(a => a.name.value === arg.name)}
              {@const value = binding ? print(binding.value) : ''}
              <div class="builder-arg">
                <label>
                  <span>{arg.name} <small>{arg.type}</small></span>
                  <input class="field field-sm field-mono" aria-label={'Argument ' + arg.name} value={value} placeholder="Value or $variable" spellcheck={false} autocomplete="off" autocorrect="off" autocapitalize="none"
                    onchange={e => {
                      if (e.currentTarget.value !== value && !edit(path, { arg, value: e.currentTarget.value })) e.currentTarget.value = value;
                    }}
                    onkeydown={e => { if (e.key === 'Enter') { e.preventDefault(); e.currentTarget.blur(); } }} />
                </label>
                {#if binding?.value.kind === 'Variable'}
                  <button class="btn btn-secondary btn-sm" aria-label={'Edit variable $' + binding.value.name.value} type="button" onclick={showVariables}>Variables</button>
                {:else}
                  <button class="btn btn-secondary btn-sm" aria-label={'Use variable for ' + arg.name} type="button" onclick={() => edit(path, { arg })}>Use variable</button>
                {/if}
              </div>
            {/each}
          </div>
        {/if}
        {@render tree(nextType, path, matches.flatMap(node => node.selectionSet ? [node.selectionSet] : []), key)}
      </div>
    {/if}
  {/each}
{/snippet}

<div class="graphql-explorer-list">
  {#if root}{@render tree(root, [], active ? [active.selectionSet] : [], root)}{/if}
</div>
