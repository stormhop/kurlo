const api = globalThis.browser ?? globalThis.chrome;

const connectButton = document.getElementById('connect');
const grantButton = document.getElementById('grant');
const syncButton = document.getElementById('sync');
const forgetButton = document.getElementById('forget');
const manualDetails = document.getElementById('manual');
const codeInput = document.getElementById('code');
const pairButton = document.getElementById('pair');
const headline = document.getElementById('headline');
const detail = document.getElementById('detail');
const approval = document.getElementById('approval');
const approvalCode = document.getElementById('approval-code');
const domainList = document.getElementById('domains');
const errorLine = document.getElementById('error');

function send(message) {
  return new Promise(resolve => api.runtime.sendMessage(message, resolve));
}

function relativeTime(timestamp) {
  const seconds = Math.max(0, Math.round((Date.now() - timestamp) / 1000));
  if (seconds < 5) return 'just now';
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  return `${Math.round(minutes / 60)}h ago`;
}

function showError(message) {
  errorLine.textContent = message ?? '';
  errorLine.hidden = !message;
}

async function render() {
  const state = await send({ type: 'kurlo:state' });
  if (!state) return;

  const missing = state.domains.filter(domain => !state.granted.includes(domain));
  const waiting = Boolean(state.pending);

  approval.hidden = !waiting;
  if (waiting) approvalCode.textContent = state.pending.code;

  if (waiting) {
    headline.textContent = 'Waiting for Kurlo';
    detail.textContent = 'Approve this browser in Kurlo, on the Sync Cookies tab.';
  } else if (!state.paired) {
    headline.textContent = 'Not connected';
    detail.textContent = 'Turn on Sync Cookies in Kurlo, then press Connect.';
  } else if (!state.connected) {
    headline.textContent = 'Reconnecting';
    detail.textContent = 'Paired with Kurlo, waiting for the bridge to answer.';
  } else if (!state.domains.length) {
    headline.textContent = `Connected as ${state.browser}`;
    detail.textContent = 'Kurlo has no domains on its allowlist yet.';
  } else if (missing.length) {
    headline.textContent = 'Permission needed';
    detail.textContent = `This browser may not read ${missing.join(', ')} yet.`;
  } else if (state.lastSync) {
    headline.textContent = `Synced ${relativeTime(state.lastSync.at)}`;
    detail.textContent = `${state.lastSync.accepted} sent, ${state.lastSync.removed} cleared in Kurlo.`;
  } else {
    headline.textContent = `Connected as ${state.browser}`;
    detail.textContent = 'Live — cookie changes are pushed as they happen.';
  }

  domainList.replaceChildren(
    ...state.domains.map(domain => {
      const chip = document.createElement('span');
      chip.className = state.granted.includes(domain) ? 'chip granted' : 'chip';
      chip.textContent = domain;
      chip.title = state.granted.includes(domain) ? 'Readable' : 'Needs permission';
      return chip;
    }),
  );

  connectButton.hidden = state.paired || waiting;
  grantButton.disabled = !missing.length;
  syncButton.disabled = !state.paired;
  forgetButton.disabled = !state.paired && !waiting;
  manualDetails.hidden = state.paired;
  showError(state.lastError);
}

connectButton.addEventListener('click', async () => {
  connectButton.disabled = true;
  await send({ type: 'kurlo:connect' });
  connectButton.disabled = false;
  await render();
});

grantButton.addEventListener('click', async () => {
  const state = await send({ type: 'kurlo:state' });
  const missing = state.domains.filter(domain => !state.granted.includes(domain));
  if (!missing.length) return;
  try {
    const granted = await api.permissions.request({
      origins: missing.map(domain => `*://*.${domain}/*`),
    });
    if (!granted) {
      showError('Permission was declined, so those domains stay unread.');
      return;
    }
    await send({ type: 'kurlo:sync-now' });
  } catch (error) {
    showError(error instanceof Error ? error.message : String(error));
  }
  await render();
});

syncButton.addEventListener('click', async () => {
  syncButton.disabled = true;
  await send({ type: 'kurlo:sync-now' });
  await render();
});

forgetButton.addEventListener('click', async () => {
  await send({ type: 'kurlo:forget' });
  codeInput.value = '';
  await render();
});

pairButton.addEventListener('click', async () => {
  const result = await send({ type: 'kurlo:pair-manually', code: codeInput.value });
  if (result && result.ok === false) showError(result.error);
  await render();
});

setInterval(() => void render(), 1500);
void render();
