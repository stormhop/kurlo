<script lang="ts">
  import { vm } from '../stores/app.svelte';
</script>

<div class="settings-section">
  <div class="settings-header">
    <div>
      <span class="settings-title">gRPC settings</span>
      <span class="settings-subtitle">Connection, TLS, response formatting, and timeouts for this request.</span>
    </div>
    <div class="settings-actions">
      <button class="btn btn-ghost" type="button" onclick={vm.resetRequestSettings}>Reset</button>
      <button class="btn btn-secondary" class:feedback-ok={vm.settingsSaved} type="button" onclick={vm.saveRequestSettings}>
        {vm.settingsSaved ? 'Saved as default' : 'Save as default'}
      </button>
    </div>
  </div>

  {#if vm.appliedCollectionDefaultNotes.length}
    <div class="collection-defaults-applied" aria-label="Applied collection defaults">
      <strong>Applied collection defaults</strong>
      <span>
        {#each vm.appliedCollectionDefaultNotes as note, eachIndex (eachIndex)}
          <em>{note}</em>
        {/each}
      </span>
    </div>
  {/if}

  <div class="settings-list">
    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Use TLS</strong>
        <span>Connect with TLS unless the target uses grpc:// or http://.</span>
        {#if vm.collectionSettingDefaultNote('grpcUseTls')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('grpcUseTls')}>{vm.collectionSettingDefaultNote('grpcUseTls')}</em>{/if}
      </span>
      <span class="switch-control">
        <input type="checkbox" bind:checked={vm.grpcUseTls} onchange={() => vm.markRequestSettingOverride('grpcUseTls')} />
        <span class="switch-track"></span>
        <span class="switch-state">{vm.grpcUseTls ? 'ON' : 'OFF'}</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Enable server certificate verification</strong>
        <span>Verify the server certificate when invoking a method over a secure connection.</span>
        {#if vm.collectionSettingDefaultNote('enableSSLVerification')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('enableSSLVerification')}>{vm.collectionSettingDefaultNote('enableSSLVerification')}</em>{/if}
      </span>
      <span class="switch-control">
        <input type="checkbox" bind:checked={vm.enableSSLVerification} onchange={() => vm.markRequestSettingOverride('enableSSLVerification')} />
        <span class="switch-track"></span>
        <span class="switch-state">{vm.enableSSLVerification ? 'ON' : 'OFF'}</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Overwrite server name for certificate verification</strong>
        <span>Use this value for TLS SNI, authority, and certificate hostname checks.</span>
        {#if vm.collectionSettingDefaultNote('grpcServerName')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('grpcServerName')}>{vm.collectionSettingDefaultNote('grpcServerName')}</em>{/if}
      </span>
      <input class="field field-input" type="text" bind:value={vm.grpcServerName} placeholder="api.example.com" spellcheck="false" autocomplete="off" oninput={() => vm.markRequestSettingOverride('grpcServerName')} autocorrect="off" autocapitalize="none" />
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Include fields with default values in the response</strong>
        <span>Render default protobuf field values in response messages.</span>
        {#if vm.collectionSettingDefaultNote('grpcIncludeDefaultValues')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('grpcIncludeDefaultValues')}>{vm.collectionSettingDefaultNote('grpcIncludeDefaultValues')}</em>{/if}
      </span>
      <span class="switch-control">
        <input type="checkbox" bind:checked={vm.grpcIncludeDefaultValues} onchange={() => vm.markRequestSettingOverride('grpcIncludeDefaultValues')} />
        <span class="switch-track"></span>
        <span class="switch-state">{vm.grpcIncludeDefaultValues ? 'ON' : 'OFF'}</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Maximum response message size</strong>
        <span>Maximum allowed response message size in MB. Set to 0 to receive messages of any size.</span>
        {#if vm.collectionSettingDefaultNote('grpcMaxResponseMessageSizeMb')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('grpcMaxResponseMessageSizeMb')}>{vm.collectionSettingDefaultNote('grpcMaxResponseMessageSizeMb')}</em>{/if}
      </span>
      <span class="setting-inline-number">
        <input class="field setting-number" type="number" bind:value={vm.grpcMaxResponseMessageSizeMb} min="0" max="2048" step="1" oninput={() => vm.markRequestSettingOverride('grpcMaxResponseMessageSizeMb')} />
        <span>MB</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Connection timeout</strong>
        <span>Deadline to invoke and receive the response in milliseconds. Set to 0 to keep the connection open indefinitely.</span>
        {#if vm.collectionSettingDefaultNote('timeoutMs')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('timeoutMs')}>{vm.collectionSettingDefaultNote('timeoutMs')}</em>{/if}
      </span>
      <span class="setting-inline-number">
        <input class="field setting-number" type="number" bind:value={vm.timeoutMs} min="0" max="300000" step="1000" oninput={() => vm.markRequestSettingOverride('timeoutMs')} />
        <span>ms</span>
      </span>
    </label>
  </div>
</div>
