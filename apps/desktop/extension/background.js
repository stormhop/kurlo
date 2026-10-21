const api = globalThis.browser ?? globalThis.chrome;

const DISCOVER_PORTS = [3199, 3200, 3201, 3202, 3203];
const CHANGE_DEBOUNCE_MS = 400;
const POLL_INTERVAL_MS = 1500;
const RECONNECT_MIN_MS = 2000;
const RECONNECT_MAX_MS = 30000;
const KEEPALIVE_MS = 20000;
const MAX_SNAPSHOT_COOKIES = 5000;
const MAX_SNAPSHOT_BYTES = 3 << 20;
const RECONCILE_ALARM = 'kurlo-cookie-sync-reconcile';
const RECONNECT_ALARM = 'kurlo-cookie-sync-reconnect';
const RECONCILE_MINUTES = 5;

let socket = null;
let domains = [];
let pendingChanges = new Map();
let changeTimer = null;
let keepaliveTimer = null;
let reconnectDelay = RECONNECT_MIN_MS;
let connecting = false;
let polling = false;
let socketOpened = false;

function browserLabel() {
  const agent = navigator.userAgent;
  if (agent.includes('Firefox')) return 'Firefox';
  if (agent.includes('Edg/')) return 'Edge';
  if (agent.includes('Chrome')) return navigator.brave ? 'Brave' : 'Chrome';
  return 'Browser';
}

function extensionId() {
  return api.runtime.id ?? '';
}

function parsePairingCode(code) {
  const match = /^kurlo-(\d{2,5})-([A-Za-z0-9_-]{16,})$/.exec((code ?? '').trim());
  if (!match) return null;
  const port = Number(match[1]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  return { port, token: match[2] };
}

function cookieOriginPattern(domain) {
  return `*://*.${domain}/*`;
}

function toKurloCookie(cookie) {
  return {
    name: cookie.name,
    value: cookie.value,
    domain: cookie.domain,
    path: cookie.path,
    secure: Boolean(cookie.secure),
    httpOnly: Boolean(cookie.httpOnly),
    sameSite: cookie.sameSite ?? '',
    hostOnly: Boolean(cookie.hostOnly),
    session: Boolean(cookie.session),
    expirationDate: cookie.expirationDate ?? 0,
  };
}

async function readState() {
  const stored = await api.storage.local.get([
    'port', 'token', 'pending', 'lastSync', 'lastError', 'domains',
  ]);
  return {
    port: stored.port ?? 0,
    token: stored.token ?? '',
    pending: stored.pending ?? null,
    lastSync: stored.lastSync ?? null,
    lastError: stored.lastError ?? '',
    domains: stored.domains ?? [],
  };
}

async function setState(patch) {
  await api.storage.local.set(patch);
}

async function bridgeFetch(port, path, init = {}) {
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    ...init,
    headers: { ...(init.headers ?? {}), 'Content-Type': 'application/json' },
  });
  const body = await response.text().catch(() => '');
  let parsed = null;
  try {
    parsed = body ? JSON.parse(body) : null;
  } catch {}
  if (!response.ok) {
    const message = parsed?.error ?? `Kurlo answered ${response.status}`;
    const error = new Error(message);
    error.status = response.status;
    error.retryAfter = parsed?.retryAfter ?? 0;
    throw error;
  }
  return parsed ?? {};
}

async function discoverBridge() {
  const state = await readState();
  const candidates = state.port ? [state.port, ...DISCOVER_PORTS] : DISCOVER_PORTS;
  for (const port of candidates) {
    try {
      const hello = await bridgeFetch(port, '/discover');
      if (hello.app === 'kurlo') {
        if (state.port !== port) await setState({ port });
        return port;
      }
    } catch {}
  }
  return 0;
}

async function requestPairing(port) {
  const answer = await bridgeFetch(port, '/pair', {
    method: 'POST',
    body: JSON.stringify({ browser: browserLabel(), extensionId: extensionId() }),
  });
  const pending = { requestId: answer.requestId, code: answer.code, port, at: Date.now() };
  await setState({ pending, lastError: '' });
  pollPairing();
  return pending;
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function pollPairing() {
  if (polling) return;
  polling = true;
  try {
    for (;;) {
      const state = await readState();
      if (!state.pending || state.token) return;
      const answer = await bridgeFetch(
        state.pending.port,
        `/pair?requestId=${encodeURIComponent(state.pending.requestId)}`,
      );
      if (answer.status === 'approved' && answer.token) {
        await setState({ token: answer.token, pending: null, lastError: '' });
        void connect();
        return;
      }
      if (answer.status === 'denied') {
        await setState({ pending: null, lastError: 'Kurlo turned this browser down.' });
        return;
      }
      if (answer.status === 'expired') {
        await setState({ pending: null, lastError: 'The request expired before it was approved.' });
        return;
      }
      await delay(POLL_INTERVAL_MS);
    }
  } catch (error) {
    await setState({ lastError: error.message });
  } finally {
    polling = false;
  }
}

async function grantedDomains(candidates) {
  const granted = [];
  for (const domain of candidates) {
    const allowed = await api.permissions.contains({ origins: [cookieOriginPattern(domain)] });
    if (allowed) granted.push(domain);
  }
  return granted;
}

async function collectCookies(readable) {
  const seen = new Set();
  const cookies = [];
  for (const domain of readable) {
    const found = await api.cookies.getAll({ domain });
    for (const cookie of found) {
      const key = `${cookie.domain}${cookie.path}${cookie.name}${cookie.hostOnly}`;
      if (seen.has(key)) continue;
      seen.add(key);
      cookies.push(toKurloCookie(cookie));
    }
  }
  return cookies;
}

function send(message) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return false;
  socket.send(JSON.stringify(message));
  return true;
}

async function sendSnapshot() {
  if (!domains.length) return;
  const readable = await grantedDomains(domains);
  if (!readable.length) {
    await setState({ lastError: 'Waiting for permission to read those domains - open the extension and grant access.' });
    return;
  }
  const cookies = await collectCookies(readable);
  if (cookies.length > MAX_SNAPSHOT_COOKIES) {
    await setState({
      lastError: `Those domains hold ${cookies.length} cookies, more than Kurlo accepts at once - list narrower domains.`,
    });
    return;
  }
  const payload = JSON.stringify({ type: 'snapshot', browser: browserLabel(), domains: readable, cookies });
  if (payload.length > MAX_SNAPSHOT_BYTES) {
    await setState({
      lastError: 'Those cookies are too large to send in one go - list narrower domains.',
    });
    return;
  }
  if (socket && socket.readyState === WebSocket.OPEN) socket.send(payload);
}

function domainAllowed(cookieDomain) {
  const domain = (cookieDomain ?? '').replace(/^\.+/, '').toLowerCase();
  return domains.some(listed => domain === listed || domain.endsWith(`.${listed}`));
}

async function flushChanges() {
  changeTimer = null;
  const changes = [...pendingChanges.values()];
  pendingChanges = new Map();
  for (const change of changes) {
    if (!domainAllowed(change.cookie.domain)) continue;
    const allowed = await api.permissions.contains({
      origins: [cookieOriginPattern(change.cookie.domain.replace(/^\.+/, ''))],
    });
    if (!allowed) continue;
    send({
      type: 'change',
      browser: browserLabel(),
      removed: change.removed,
      cause: change.cause,
      cookie: toKurloCookie(change.cookie),
    });
  }
}

function queueChange(info) {
  if (!info?.cookie) return;
  const key = `${info.cookie.domain}${info.cookie.path}${info.cookie.name}${info.cookie.hostOnly}`;
  pendingChanges.set(key, {
    cookie: info.cookie,
    removed: Boolean(info.removed) && info.cause !== 'overwrite',
    cause: info.cause ?? '',
  });
  if (changeTimer) clearTimeout(changeTimer);
  changeTimer = setTimeout(() => void flushChanges(), CHANGE_DEBOUNCE_MS);
}

function stopKeepalive() {
  if (keepaliveTimer) clearInterval(keepaliveTimer);
  keepaliveTimer = null;
}

function scheduleReconnect() {
  api.alarms.create(RECONNECT_ALARM, { delayInMinutes: Math.max(reconnectDelay, RECONNECT_MIN_MS) / 60000 });
  reconnectDelay = Math.min(reconnectDelay * 2, RECONNECT_MAX_MS);
}

async function connect() {
  if (connecting || (socket && socket.readyState <= WebSocket.OPEN)) return;
  connecting = true;
  try {
    const port = await discoverBridge();
    if (!port) {
      await setState({ lastError: 'Kurlo is not listening — turn on Sync Cookies in the app.' });
      scheduleReconnect();
      return;
    }
    const state = await readState();
    if (!state.token) {
      if (!state.pending) await requestPairing(port);
      else pollPairing();
      return;
    }

    const url = `ws://127.0.0.1:${port}/ws?token=${encodeURIComponent(state.token)}&browser=${encodeURIComponent(browserLabel())}&version=${encodeURIComponent(api.runtime.getManifest().version)}`;
    socket = new WebSocket(url);

    socketOpened = false;
    socket.onopen = () => {
      socketOpened = true;
      reconnectDelay = RECONNECT_MIN_MS;
      stopKeepalive();
      keepaliveTimer = setInterval(() => send({ type: 'ping' }), KEEPALIVE_MS);
      void setState({ lastError: '' });
    };

    socket.onmessage = async (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message.type === 'hello' || message.type === 'domains') {
        domains = Array.isArray(message.domains) ? message.domains : [];
        await setState({ domains, lastError: '' });
        await sendSnapshot();
        return;
      }
      if (message.type === 'synced') {
        await setState({
          lastSync: {
            at: Date.now(),
            accepted: message.accepted ?? 0,
            removed: message.removed ?? 0,
            skipped: message.skipped ?? 0,
            domains: message.domains ?? [],
          },
          lastError: '',
        });
        return;
      }
      if (message.type === 'error') {
        await setState({ lastError: message.error ?? 'Kurlo refused that message.' });
      }
    };

    socket.onclose = (event) => {
      stopKeepalive();
      socket = null;
      void handleSocketClose(event.code, socketOpened);
    };

    socket.onerror = () => {
      void setState({ lastError: 'Lost the connection to Kurlo.' });
    };
  } catch (error) {
    await setState({ lastError: error.message });
    scheduleReconnect();
  } finally {
    connecting = false;
  }
}

async function bridgeAnswers(port) {
  try {
    const hello = await bridgeFetch(port, '/discover');
    return hello.app === 'kurlo';
  } catch {
    return false;
  }
}

async function handleSocketClose(code, opened) {
  if (code === 1008) {
    await setState({ token: '', pending: null, lastError: 'Kurlo disconnected this browser - asking to connect again.' });
    void connect();
    return;
  }
  if (!opened) {
    const state = await readState();
    if (state.port && (await bridgeAnswers(state.port))) {
      await setState({ token: '', pending: null, lastError: 'Kurlo no longer accepts this browser - asking to connect again.' });
      void connect();
      return;
    }
  }
  scheduleReconnect();
}

async function forget() {
  stopKeepalive();
  if (socket) {
    socket.onclose = null;
    socket.close();
    socket = null;
  }
  domains = [];
  await api.storage.local.set({ token: '', pending: null, domains: [], lastSync: null, lastError: '' });
}

api.cookies.onChanged.addListener(queueChange);

api.alarms.onAlarm.addListener(alarm => {
  if (alarm.name === RECONCILE_ALARM) {
    void connect();
    void sendSnapshot();
  }
  if (alarm.name === RECONNECT_ALARM) void connect();
});

api.runtime.onInstalled.addListener(() => {
  api.alarms.create(RECONCILE_ALARM, { periodInMinutes: RECONCILE_MINUTES });
  void connect();
});

api.runtime.onStartup?.addListener(() => {
  api.alarms.create(RECONCILE_ALARM, { periodInMinutes: RECONCILE_MINUTES });
  void connect();
});

api.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === 'kurlo:state') {
    readState().then(async state => {
      sendResponse({
        ...state,
        browser: browserLabel(),
        extensionId: extensionId(),
        connected: Boolean(socket && socket.readyState === WebSocket.OPEN),
        paired: Boolean(state.token),
        granted: await grantedDomains(state.domains),
      });
    });
    return true;
  }
  if (message?.type === 'kurlo:connect') {
    connect().then(readState).then(sendResponse);
    return true;
  }
  if (message?.type === 'kurlo:sync-now') {
    connect()
      .then(() => sendSnapshot())
      .then(readState)
      .then(sendResponse);
    return true;
  }
  if (message?.type === 'kurlo:pair-manually') {
    const pairing = parsePairingCode(message.code);
    if (!pairing) {
      sendResponse({ ok: false, error: 'That is not a Kurlo pairing code.' });
      return true;
    }
    setState({ port: pairing.port, token: pairing.token, pending: null, lastError: '' })
      .then(() => connect())
      .then(() => sendResponse({ ok: true }));
    return true;
  }
  if (message?.type === 'kurlo:forget') {
    forget().then(() => sendResponse({ ok: true }));
    return true;
  }
  return false;
});

void connect();
