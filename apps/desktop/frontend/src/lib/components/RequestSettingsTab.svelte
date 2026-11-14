<script lang="ts">
  import { vm } from '../stores/app.svelte';
  import Select from './Select.svelte';
  import BrowserSecuritySettings from './BrowserSecuritySettings.svelte';

  const HTTP_VERSION_OPTIONS = [
    { value: 'auto', label: 'Auto' },
    { value: '1.1', label: 'HTTP/1.1' },
    { value: '2', label: 'HTTP/2 preferred' },
  ];
</script>

<div class="settings-section">
  <div class="settings-header">
    <div>
      <span class="settings-title">Request settings</span>
      <span class="settings-subtitle">Kept with this request. Save them as the default to start new requests with the same values.</span>
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
        <strong>HTTP version</strong>
        <span>Select HTTP/1.1 or prefer HTTP/2 when the server can negotiate it.</span>
        {#if vm.collectionSettingDefaultNote('httpVersion')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('httpVersion')}>{vm.collectionSettingDefaultNote('httpVersion')}</em>{/if}
      </span>
      <Select bind:value={vm.httpVersion} options={HTTP_VERSION_OPTIONS} className="setting-select" onChange={() => vm.markRequestSettingOverride('httpVersion')} />
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Enable SSL certificate verification</strong>
        <span>Verify TLS certificates when sending the request.</span>
        {#if vm.collectionSettingDefaultNote('enableSSLVerification')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('enableSSLVerification')}>{vm.collectionSettingDefaultNote('enableSSLVerification')}</em>{/if}
      </span>
      <span class="switch-control">
        <input type="checkbox" checked={vm.enableSSLVerification} onchange={vm.toggleSSLVerification} />
        <span class="switch-track"></span>
        <span class="switch-state">{vm.enableSSLVerification ? 'ON' : 'OFF'}</span>
      </span>
    </label>

    <div class="postman-setting client-cert-setting">
      <span class="setting-copy">
        <strong>Client certificate (mTLS)</strong>
        <span>Present a certificate for servers that require mutual TLS. Set it on a collection to reuse it across requests.</span>
        {#if vm.collectionSettingDefaultNote('clientCertPath')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('clientCertPath')}>{vm.collectionSettingDefaultNote('clientCertPath')}</em>{/if}
      </span>
      <div class="client-cert-fields">
        <div class="client-cert-row">
          <span class="client-cert-label">Certificate (CRT/PEM)</span>
          {#if vm.clientCertPath}
            <span class="client-cert-path">{vm.clientCertPath}</span>
            <button class="btn btn-secondary" type="button" onclick={() => vm.clearClientCertField('clientCertPath')}>Clear</button>
          {:else}
            <button class="btn btn-secondary" type="button" onclick={() => vm.pickClientCertFile('clientCertPath')}>Choose file…</button>
          {/if}
        </div>
        <div class="client-cert-row">
          <span class="client-cert-label">Private key (optional)</span>
          {#if vm.clientKeyPath}
            <span class="client-cert-path">{vm.clientKeyPath}</span>
            <button class="btn btn-secondary" type="button" onclick={() => vm.clearClientCertField('clientKeyPath')}>Clear</button>
          {:else}
            <button class="btn btn-secondary" type="button" onclick={() => vm.pickClientCertFile('clientKeyPath')} disabled={!vm.clientCertPath}>Choose file…</button>
          {/if}
        </div>
        <div class="client-cert-row">
          <span class="client-cert-label">Key passphrase</span>
          <input
            class="field field-input client-cert-pass"
            type="password"
            placeholder="Leave blank if the key is unencrypted"
            autocomplete="off"
            spellcheck="false"
            value={vm.clientKeyPassword}
            oninput={(event) => { vm.clientKeyPassword = event.currentTarget.value; vm.markRequestSettingOverride('clientKeyPassword'); }}
            disabled={!vm.clientCertPath}
            autocorrect="off"
            autocapitalize="none"
          />
        </div>
        <p class="client-cert-hint">The key file defaults to the certificate file when left blank (combined PEM). Use <code>&#123;&#123;variable&#125;&#125;</code> in any field to keep the passphrase in workspace secrets.</p>
      </div>
    </div>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Automatically follow redirects</strong>
        <span>Follow HTTP 3xx responses as redirects.</span>
        {#if vm.collectionSettingDefaultNote('followRedirects')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('followRedirects')}>{vm.collectionSettingDefaultNote('followRedirects')}</em>{/if}
      </span>
      <span class="switch-control">
        <input type="checkbox" bind:checked={vm.followRedirects} onchange={() => vm.markRequestSettingOverride('followRedirects')} />
        <span class="switch-track"></span>
        <span class="switch-state">{vm.followRedirects ? 'ON' : 'OFF'}</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Follow original HTTP method</strong>
        <span>Redirect with the original method instead of switching to GET.</span>
        {#if vm.collectionSettingDefaultNote('followOriginalMethod')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('followOriginalMethod')}>{vm.collectionSettingDefaultNote('followOriginalMethod')}</em>{/if}
      </span>
      <span class="switch-control">
        <input type="checkbox" bind:checked={vm.followOriginalMethod} disabled={!vm.followRedirects} onchange={() => vm.markRequestSettingOverride('followOriginalMethod')} />
        <span class="switch-track"></span>
        <span class="switch-state">{vm.followOriginalMethod ? 'ON' : 'OFF'}</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Follow Authorization header</strong>
        <span>Retain Authorization when a redirect happens to a different hostname.</span>
        {#if vm.collectionSettingDefaultNote('followAuthorizationHeader')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('followAuthorizationHeader')}>{vm.collectionSettingDefaultNote('followAuthorizationHeader')}</em>{/if}
      </span>
      <span class="switch-control">
        <input type="checkbox" bind:checked={vm.followAuthorizationHeader} disabled={!vm.followRedirects} onchange={() => vm.markRequestSettingOverride('followAuthorizationHeader')} />
        <span class="switch-track"></span>
        <span class="switch-state">{vm.followAuthorizationHeader ? 'ON' : 'OFF'}</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Remove referer header on redirect</strong>
        <span>Remove the Referer header when a redirect happens.</span>
        {#if vm.collectionSettingDefaultNote('removeRefererHeader')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('removeRefererHeader')}>{vm.collectionSettingDefaultNote('removeRefererHeader')}</em>{/if}
      </span>
      <span class="switch-control">
        <input type="checkbox" bind:checked={vm.removeRefererHeader} disabled={!vm.followRedirects} onchange={() => vm.markRequestSettingOverride('removeRefererHeader')} />
        <span class="switch-track"></span>
        <span class="switch-state">{vm.removeRefererHeader ? 'ON' : 'OFF'}</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Encode URL automatically</strong>
        <span>Encode the URL path and query parameters before sending.</span>
        {#if vm.collectionSettingDefaultNote('encodeUrlAutomatically')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('encodeUrlAutomatically')}>{vm.collectionSettingDefaultNote('encodeUrlAutomatically')}</em>{/if}
      </span>
      <span class="switch-control">
        <input type="checkbox" bind:checked={vm.encodeUrlAutomatically} onchange={() => vm.markRequestSettingOverride('encodeUrlAutomatically')} />
        <span class="switch-track"></span>
        <span class="switch-state">{vm.encodeUrlAutomatically ? 'ON' : 'OFF'}</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Disable cookie jar</strong>
        <span>Prevent cookies from being stored and reused between requests.</span>
        {#if vm.collectionSettingDefaultNote('disableCookieJar')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('disableCookieJar')}>{vm.collectionSettingDefaultNote('disableCookieJar')}</em>{/if}
      </span>
      <span class="switch-control">
        <input type="checkbox" bind:checked={vm.disableCookieJar} onchange={() => vm.markRequestSettingOverride('disableCookieJar')} />
        <span class="switch-track"></span>
        <span class="switch-state">{vm.disableCookieJar ? 'ON' : 'OFF'}</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Maximum number of redirects</strong>
        <span>Stop following redirects after this many hops.</span>
        {#if vm.collectionSettingDefaultNote('maxRedirects')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('maxRedirects')}>{vm.collectionSettingDefaultNote('maxRedirects')}</em>{/if}
      </span>
      <input class="field setting-number" type="number" bind:value={vm.maxRedirects} min="0" max="50" step="1" disabled={!vm.followRedirects} oninput={() => vm.markRequestSettingOverride('maxRedirects')} />
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Request timeout</strong>
        <span>Abort the request when it takes longer than this value. 0 waits indefinitely.</span>
        {#if vm.collectionSettingDefaultNote('timeoutMs')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('timeoutMs')}>{vm.collectionSettingDefaultNote('timeoutMs')}</em>{/if}
      </span>
      <span class="setting-inline-number">
        <input class="field setting-number" type="number" bind:value={vm.timeoutMs} min="0" step="1000" oninput={() => vm.markRequestSettingOverride('timeoutMs')} />
        <span>ms</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Script timeout</strong>
        <span>How long a pre-request or test script may run. Leave at 0 for the 2000 ms default; raise it for heavy assertion suites or request signing.</span>
        {#if vm.collectionSettingDefaultNote('scriptTimeoutMs')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('scriptTimeoutMs')}>{vm.collectionSettingDefaultNote('scriptTimeoutMs')}</em>{/if}
      </span>
      <span class="setting-inline-number">
        <input class="field setting-number" type="number" bind:value={vm.scriptTimeoutMs} min="0" max="60000" step="500" oninput={() => vm.markRequestSettingOverride('scriptTimeoutMs')} />
        <span>ms</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>Allow pm.sendRequest</strong>
        <span>Let this request's scripts make their own HTTP calls — for fetching a token before the send, or chaining setup. Off by default: scripts have no network access otherwise.</span>
        {#if vm.collectionSettingDefaultNote('allowSendRequest')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('allowSendRequest')}>{vm.collectionSettingDefaultNote('allowSendRequest')}</em>{/if}
      </span>
      <span class="switch-control">
        <input type="checkbox" bind:checked={vm.allowSendRequest} onchange={() => vm.markRequestSettingOverride('allowSendRequest')} />
        <span class="switch-track"></span>
        <span class="switch-state">{vm.allowSendRequest ? 'ON' : 'OFF'}</span>
      </span>
    </label>

    <label class="postman-setting">
      <span class="setting-copy">
        <strong>HTTP proxy</strong>
        <span>Route this request through a proxy. Leave empty to use the system proxy (HTTP_PROXY env var).</span>
        {#if vm.collectionSettingDefaultNote('proxyUrl')}<em class:setting-default-muted={!vm.collectionSettingIsInherited('proxyUrl')}>{vm.collectionSettingDefaultNote('proxyUrl')}</em>{/if}
      </span>
      <input class="field field-mono kv-input setting-proxy" type="text" placeholder="http://localhost:8080" bind:value={vm.proxyUrl} spellcheck="false" autocomplete="off" oninput={() => vm.markRequestSettingOverride('proxyUrl')} autocorrect="off" autocapitalize="none" />
    </label>

    {#if vm.method === 'SSE'}
      <label class="postman-setting">
        <span class="setting-copy">
          <strong>Reconnect automatically</strong>
          <span>Reconnect the way a browser EventSource does, resuming from the last event id. Turn this off to see a failing stream stop instead of retrying.</span>
        </span>
        <span class="switch-control">
          <input type="checkbox" checked={!vm.sseDisableReconnect} onchange={(event) => { vm.sseDisableReconnect = !(event.currentTarget as HTMLInputElement).checked; vm.markRequestSettingOverride('sseDisableReconnect'); }} />
          <span class="switch-track"></span>
          <span class="switch-state">{vm.sseDisableReconnect ? 'OFF' : 'ON'}</span>
        </span>
      </label>

      <label class="postman-setting">
        <span class="setting-copy">
          <strong>Reconnect interval</strong>
          <span>Wait this long before reconnecting. Leave at 0 to follow the interval the server sends in its <code>retry:</code> field.</span>
        </span>
        <span class="setting-inline-number">
          <input class="field setting-number" type="number" bind:value={vm.sseReconnectIntervalMs} min="0" max="300000" step="500" oninput={() => vm.markRequestSettingOverride('sseReconnectIntervalMs')} />
          <span>ms</span>
        </span>
      </label>
    {/if}

    <BrowserSecuritySettings />
  </div>
</div>
