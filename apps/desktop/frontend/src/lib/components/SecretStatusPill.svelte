<script lang="ts">
  import { SECRET_PROVIDER_STATE_LABELS, type SecretProviderState } from '../secretProviderTypes';

  let { state, label = '' }: { state: SecretProviderState; label?: string } = $props();
</script>

<span class="secret-status secret-status-{state}"><span class="secret-status-dot" aria-hidden="true"></span>{label || SECRET_PROVIDER_STATE_LABELS[state]}</span>
