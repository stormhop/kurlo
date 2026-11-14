<script lang="ts">
  import { vm } from '../stores/app.svelte';

  type Props = { includeEnforceCORS?: boolean };
  const { includeEnforceCORS = true }: Props = $props();
</script>

<label class="postman-setting">
  <span class="setting-copy">
    <strong>Browser request emulation</strong>
    <span>Send browser-like Origin, User-Agent, and Sec-Fetch headers.</span>
    {#if vm.collectionSettingDefaultNote('browserEmulation')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('browserEmulation')}>{vm.collectionSettingDefaultNote('browserEmulation')}</em>{/if}
  </span>
  <span class="switch-control">
    <input type="checkbox" bind:checked={vm.browserEmulation} onchange={() => vm.markRequestSettingOverride('browserEmulation')} />
    <span class="switch-track"></span>
    <span class="switch-state">{vm.browserEmulation ? 'ON' : 'OFF'}</span>
  </span>
</label>

<label class="postman-setting">
  <span class="setting-copy">
    <strong>Browser origin</strong>
    <span>The page origin to emulate, for example http://localhost:5173.</span>
    {#if vm.collectionSettingDefaultNote('browserOrigin')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('browserOrigin')}>{vm.collectionSettingDefaultNote('browserOrigin')}</em>{/if}
  </span>
  <input class="field field-mono kv-input setting-proxy" type="text" placeholder="http://localhost:5173" bind:value={vm.browserOrigin} spellcheck="false" autocomplete="off" oninput={() => vm.markRequestSettingOverride('browserOrigin')} autocorrect="off" autocapitalize="none" />
</label>

<label class="postman-setting">
  <span class="setting-copy">
    <strong>Include browser credentials</strong>
    <span>Require credentialed CORS rules when cookies or auth should be available to browser code.</span>
    {#if vm.collectionSettingDefaultNote('browserWithCredentials')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('browserWithCredentials')}>{vm.collectionSettingDefaultNote('browserWithCredentials')}</em>{/if}
  </span>
  <span class="switch-control">
    <input type="checkbox" bind:checked={vm.browserWithCredentials} onchange={() => vm.markRequestSettingOverride('browserWithCredentials')} />
    <span class="switch-track"></span>
    <span class="switch-state">{vm.browserWithCredentials ? 'ON' : 'OFF'}</span>
  </span>
</label>

{#if includeEnforceCORS}
  <label class="postman-setting">
    <span class="setting-copy">
      <strong>Enforce CORS</strong>
      <span>Run preflight when required and fail the response when browser CORS checks would block it.</span>
      {#if vm.collectionSettingDefaultNote('browserEnforceCORS')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('browserEnforceCORS')}>{vm.collectionSettingDefaultNote('browserEnforceCORS')}</em>{/if}
    </span>
    <span class="switch-control">
      <input type="checkbox" bind:checked={vm.browserEnforceCORS} onchange={() => vm.markRequestSettingOverride('browserEnforceCORS')} />
      <span class="switch-track"></span>
      <span class="switch-state">{vm.browserEnforceCORS ? 'ON' : 'OFF'}</span>
    </span>
  </label>
{/if}

<label class="postman-setting">
  <span class="setting-copy">
    <strong>Enforce CSP connect-src</strong>
    <span>Block the request before the network when the page CSP would reject this URL.</span>
    {#if vm.collectionSettingDefaultNote('browserEnforceCSP')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('browserEnforceCSP')}>{vm.collectionSettingDefaultNote('browserEnforceCSP')}</em>{/if}
  </span>
  <span class="switch-control">
    <input type="checkbox" bind:checked={vm.browserEnforceCSP} onchange={() => vm.markRequestSettingOverride('browserEnforceCSP')} />
    <span class="switch-track"></span>
    <span class="switch-state">{vm.browserEnforceCSP ? 'ON' : 'OFF'}</span>
  </span>
</label>

<label class="postman-setting postman-setting-tall">
  <span class="setting-copy">
    <strong>CSP policy</strong>
    <span>Use the page policy, for example default-src 'self'; connect-src https://api.example.com.</span>
    {#if vm.collectionSettingDefaultNote('browserCSP')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('browserCSP')}>{vm.collectionSettingDefaultNote('browserCSP')}</em>{/if}
  </span>
  <textarea class="field field-area setting-textarea" bind:value={vm.browserCSP} spellcheck="false" oninput={() => vm.markRequestSettingOverride('browserCSP')}></textarea>
</label>
