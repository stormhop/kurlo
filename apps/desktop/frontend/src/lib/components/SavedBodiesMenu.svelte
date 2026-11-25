<script lang="ts">
  import { MAX_BODY_VARIANTS, bodyVariantLimitReached, copyBodyVariant, selectBodyVariant } from '../bodyVariants';
  import { vm } from '../stores/app.svelte';
  import type { BodyType } from '../types/models';
  import SavedPayloadMenu from './SavedPayloadMenu.svelte';

  const formats: Record<BodyType, string> = {
    none: 'No body', json: 'JSON', text: 'Text', xml: 'XML', html: 'HTML', form: 'Form data',
    urlencoded: 'URL-encoded', binary: 'Binary', graphql: 'GraphQL',
  };

  const items = $derived(vm.activeBodyVariant
    ? [{ name: vm.activeBodyVariant, bodyType: vm.bodyType }, ...vm.bodyVariants]
      .map(({ name, bodyType }) => ({ id: name, name, bodyType }))
      .sort((a, b) => a.name.localeCompare(b.name))
    : []);

  function suggestName() {
    if (bodyVariantLimitReached(vm)) return '';
    let index = items.length + 1;
    while (items.some(item => item.name === `Variant ${index}`)) index++;
    return `Variant ${index}`;
  }

  function saveProblem(name: string) {
    if (bodyVariantLimitReached(vm)) return `A request keeps up to ${MAX_BODY_VARIANTS} body variants. Delete one to save another.`;
    return items.some(item => item.name === name) ? 'A body variant with this name already exists.' : '';
  }

  function save(name: string) {
    if (saveProblem(name)) return;
    copyBodyVariant(vm, name);
    return name;
  }

  async function rename(current: string) {
    const id = vm.activeRequestId;
    const name = (await vm.openNameDialog('Rename body variant', current))?.trim();
    if (!name || name === current || id !== vm.activeRequestId) return;
    if (items.some(item => item.name === name)) {
      await vm.openAlertDialog('Rename body variant', 'A body variant with this name already exists.');
      return;
    }
    if (current === vm.activeBodyVariant) vm.activeBodyVariant = name;
    else vm.bodyVariants = vm.bodyVariants.map(body => body.name === current ? { ...body, name } : body);
  }

  async function remove(name: string) {
    const id = vm.activeRequestId;
    if (!await vm.openConfirmDialog('Delete body variant', `Delete “${name}” from the saved variants?`)) return;
    if (vm.activeRequestId !== id) return;
    if (vm.activeBodyVariant !== name) vm.bodyVariants = vm.bodyVariants.filter(body => body.name !== name);
    else if (vm.bodyVariants.length) selectBodyVariant(vm, vm.bodyVariants[0].name, true);
    else vm.activeBodyVariant = '';
  }

  function send(name: string) {
    if (vm.loading) return;
    selectBodyVariant(vm, name);
    void vm.runActiveRequest();
  }
</script>

{#key vm.activeRequestId}
  <SavedPayloadMenu noun="body variant" {items} selectedId={vm.activeBodyVariant}
    summary={item => formats[item.bodyType]} {suggestName} {saveProblem}
    onSave={save} onLoad={name => selectBodyVariant(vm, name)} onSend={send} onRename={rename} onRemove={remove}
    disabled={vm.loading} canSend={!!vm.url.trim()} --saved-menu-width="17rem"
  />
{/key}
