<script lang="ts">
  import { SAVED_MESSAGES_MAX, SAVED_MESSAGES_SEARCH_FROM, filterSavedMessages, savedMessageSummary } from '../savedMessages';
  import { vm } from '../stores/app.svelte';
  import SavedPayloadMenu from './SavedPayloadMenu.svelte';

  let { connected = false }: { connected?: boolean } = $props();
</script>

<SavedPayloadMenu noun="message" items={vm.savedMessages}
  summary={message => savedMessageSummary(message, vm.requestType)}
  suggestName={vm.suggestedSavedMessageName}
  saveProblem={vm.saveCurrentMessageProblem}
  onSave={name => vm.saveCurrentMessage(name)?.id}
  onLoad={vm.loadSavedMessage} onSend={vm.sendSavedMessage} onRemove={vm.deleteSavedMessage}
  canSend={connected} search={filterSavedMessages} searchFrom={SAVED_MESSAGES_SEARCH_FROM} maxShown={SAVED_MESSAGES_MAX}
/>
