<script lang="ts">
  import Select from './Select.svelte';
  import { vm } from '../stores/app.svelte';
  import BrowserSecuritySettings from './BrowserSecuritySettings.svelte';

  const CLIENT_VERSIONS = [
    { value: 'v3', label: 'v3 / v4 (default)' },
    { value: 'v2', label: 'v2 legacy (EIO=3)' },
  ];
</script>

<div class="settings-section ws-settings-section">
  <div class="settings-header">
    <div>
      <span class="settings-title">Socket.IO settings</span>
      <span class="settings-subtitle">Applied during the handshake and while connected.</span>
    </div>
    <div class="settings-actions">
      <button class="btn btn-ghost" type="button" onclick={vm.resetRequestSettings}>Reset</button>
      <button class="btn btn-secondary" class:feedback-ok={vm.settingsSaved} type="button" onclick={vm.saveRequestSettings}>
        {vm.settingsSaved ? 'Saved as default' : 'Save as default'}
      </button>
    </div>
  </div>

  <div class="settings-list">
    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Enable server certificate verification</strong>
        <span>Verify server certificate when connecting over a secure connection.</span>
      </span>
      <span class="switch-control">
        <input type="checkbox" checked={vm.enableSSLVerification} onchange={vm.toggleSSLVerification} />
        <span class="switch-track"></span>
        <span class="switch-state">{vm.enableSSLVerification ? 'ON' : 'OFF'}</span>
      </span>
    </label>

    <div class="postman-setting">
      <span class="setting-copy">
        <strong>Client version</strong>
        <span>Choose client version that should be used for connecting with the server.</span>
      </span>
      <Select bind:value={vm.sioClientVersion} options={CLIENT_VERSIONS} className="setting-select" onChange={() => vm.markRequestSettingOverride('sioClientVersion')} />
    </div>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Handshake path</strong>
        <span>Set the server path that should be used during the handshake request.</span>
      </span>
      <input class="field setting-number sio-text-input" type="text" bind:value={vm.sioPath} placeholder="/socket.io" spellcheck="false" oninput={() => vm.markRequestSettingOverride('sioPath')} autocomplete="off" autocorrect="off" autocapitalize="none" />
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Namespace</strong>
        <span>The Socket.IO namespace to connect to.</span>
      </span>
      <input class="field setting-number sio-text-input" type="text" bind:value={vm.sioNamespace} placeholder="/" spellcheck="false" oninput={() => vm.markRequestSettingOverride('sioNamespace')} autocomplete="off" autocorrect="off" autocapitalize="none" />
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Handshake request timeout</strong>
        <span>Set how long the handshake request should wait before timing out in milliseconds. To never time out, set to 0.</span>
      </span>
      <input class="field setting-number" type="number" bind:value={vm.wsHandshakeTimeoutMs} min="0" max="300000" step="1000" oninput={() => vm.markRequestSettingOverride('wsHandshakeTimeoutMs')} />
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Reconnection attempts</strong>
        <span>Maximum reconnection attempts when the connection closes abruptly.</span>
      </span>
      <input class="field setting-number" type="number" bind:value={vm.wsReconnectAttempts} min="0" max="50" step="1" oninput={() => vm.markRequestSettingOverride('wsReconnectAttempts')} />
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Reconnection interval</strong>
        <span>Interval between each reconnection attempt in milliseconds.</span>
      </span>
      <input class="field setting-number" type="number" bind:value={vm.wsReconnectIntervalMs} min="0" max="60000" step="500" oninput={() => vm.markRequestSettingOverride('wsReconnectIntervalMs')} />
    </label>

    <BrowserSecuritySettings includeEnforceCORS={false} />
  </div>
</div>

<style>
  .sio-text-input {
    font-family: var(--font-mono);
    text-align: left;
  }
  .sio-text-input::placeholder {
    font-family: inherit;
    color: var(--text-3);
  }
</style>
