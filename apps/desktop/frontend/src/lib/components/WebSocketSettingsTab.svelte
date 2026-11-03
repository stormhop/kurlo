<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import BrowserSecuritySettings from './BrowserSecuritySettings.svelte';
</script>

<div class="settings-section ws-settings-section">
  <div class="settings-header">
    <div>
      <span class="settings-title">WebSocket settings</span>
      <span class="settings-subtitle">Applied during the handshake and while receiving messages.</span>
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

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Maximum message size</strong>
        <span>Maximum allowed message size in MB. To receive messages of any size, set to 0.</span>
      </span>
      <input class="field setting-number" type="number" bind:value={vm.wsMaxMessageSizeMb} min="0" max="512" step="1" oninput={() => vm.markRequestSettingOverride('wsMaxMessageSizeMb')} />
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Keep-alive interval</strong>
        <span>How often to ping the server to hold the connection open. Leave at 0 for the default; set -1 to stop pinging entirely.</span>
      </span>
      <input class="field setting-number" type="number" bind:value={vm.wsKeepAliveIntervalMs} min="-1" max="300000" step="1000" oninput={() => vm.markRequestSettingOverride('wsKeepAliveIntervalMs')} />
    </label>

    <BrowserSecuritySettings includeEnforceCORS={false} />
  </div>
</div>
