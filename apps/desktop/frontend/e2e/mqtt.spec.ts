import { expect, test } from '@playwright/test';
import { chooseRequestType, fillCodeEditor } from './support/actions';
import { installKurloBridge, type E2EWindow } from './support/bridge';
import { captureDocsScreenshot } from './support/screenshots';

type MqttCall = { name: string; args: unknown[] };
type MqttWindow = E2EWindow & { __mqttCalls: MqttCall[] };

test('connects to an MQTT broker, subscribes, publishes and saves the request', async ({ page }) => {
  await installKurloBridge(page);
  await page.goto('/');
  await page.evaluate(() => {
    const w = window as unknown as MqttWindow;
    const bridge = w.go.api.App as unknown as Record<string, (id: string, arg?: unknown) => Promise<unknown>>;
    w.__mqttCalls = [];
    let n = 0;
    const msg = (extra: Record<string, unknown>) => ({ id: 'm' + ++n, size: 0, qos: 0, timestamp: Date.UTC(2026, 0, 1, 10, 0, n), isSystem: false, isError: false, ...extra });
    const emit = (id: string, messages: unknown[]) => w.__kurloE2E.emit('mqtt:messages', { sessionId: id, messages });
    bridge.MqttConnect = async (id, req) => {
      w.__mqttCalls.push({ name: 'connect', args: [id, req] });
      const mqtt = (req as { mqtt: { topics: { name: string; qos: number; enabled: boolean }[] } }).mqtt;
      setTimeout(() => {
        w.__kurloE2E.emit('mqtt:open', { sessionId: id, url: 'mqtt://broker.local:1883', clientId: 'kurlo-3f9a1c', version: '5', sessionPresent: false, timestamp: Date.now() });
        emit(id, mqtt.topics.filter(t => t.enabled).map(t => msg({ direction: 'system', isSystem: true, topic: t.name, qos: t.qos, message: `Subscribed to ${t.name} (QoS ${t.qos})` })));
        emit(id, [
          msg({ direction: 'incoming', topic: 'devices/kitchen/telemetry', payload: '{"temperature":21.4,"humidity":48}', size: 34, qos: 1 }),
          msg({ direction: 'incoming', topic: 'devices/hall/telemetry', payload: '{"temperature":19.8,"humidity":52}', size: 34, qos: 1, retain: true }),
        ]);
      }, 20);
    };
    bridge.MqttDisconnect = async id => {
      w.__mqttCalls.push({ name: 'disconnect', args: [id] });
      w.__kurloE2E.emit('mqtt:close', { sessionId: id, message: 'Disconnected', timestamp: Date.now() });
    };
    bridge.MqttSubscribe = async (id, topic) => {
      w.__mqttCalls.push({ name: 'subscribe', args: [id, topic] });
      const t = topic as { name: string; qos: number };
      emit(id, [msg({ direction: 'system', isSystem: true, topic: t.name, qos: t.qos, message: `Subscribed to ${t.name} (QoS ${t.qos})` })]);
      return { ok: true };
    };
    bridge.MqttUnsubscribe = async (id, topic) => {
      w.__mqttCalls.push({ name: 'unsubscribe', args: [id, topic] });
      emit(id, [msg({ direction: 'system', isSystem: true, topic, message: `Unsubscribed from ${topic}` })]);
      return { ok: true };
    };
    bridge.MqttPublish = async (id, message) => {
      w.__mqttCalls.push({ name: 'publish', args: [id, message] });
      const m = message as { topic: string; payload: string; qos: number; retain: boolean };
      emit(id, [
        msg({ direction: 'outgoing', topic: m.topic, payload: m.payload, size: m.payload.length, qos: m.qos, retain: m.retain }),
        msg({ direction: 'incoming', topic: 'devices/kitchen/ack', payload: '{"ok":true}', size: 11, qos: 1, contentType: 'application/json', userProperties: [{ key: 'trace', value: 'abc', enabled: true }] }),
      ]);
      return { ok: true };
    };
  });

  await page.getByLabel('New unsaved request').click();
  await chooseRequestType(page, 'MQTT');
  await expect(page.locator('.saved-request-tab.active svg[data-kind="mqtt"]')).toBeVisible();
  await page.getByLabel('Broker URL').fill('mqtt://broker.local:1883');

  await page.getByRole('tab', { name: 'Topics' }).click();
  await page.getByLabel('New topic').fill('devices/#/x');
  await expect(page.getByText('# must be the last level on its own')).toBeVisible();
  await page.getByLabel('New topic').fill('devices/+/telemetry');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await page.getByLabel('New topic').fill('devices/+/ack');
  await page.getByRole('button', { name: 'Add', exact: true }).click();
  await expect(page.getByTestId('mqtt-topic-row')).toHaveCount(2);

  await page.getByRole('tab', { name: 'Message' }).click();
  await page.getByLabel('Publish topic').fill('devices/kitchen/commands');
  await page.getByRole('button', { name: /^Publish QoS/ }).click();
  await page.getByRole('option', { name: /QoS 1/ }).click();
  await page.getByRole('button', { name: 'Message type: Text' }).click();
  await page.getByRole('option', { name: 'JSON', exact: true }).click();
  await fillCodeEditor(page, 'mqtt-message-editor', '{"op":"set","target":22}');
  await expect(page.getByTestId('mqtt-send')).toBeDisabled();

  await page.locator('.btn-send').click();
  await expect(page.getByTestId('mqtt-panel')).toContainText('Connected');
  await expect(page.getByTestId('mqtt-panel')).toContainText('Subscribed to devices/+/telemetry (QoS 0)');
  await expect.poll(() => page.evaluate(() => (window as unknown as MqttWindow).__mqttCalls.find(c => c.name === 'connect')?.args[1])).toMatchObject({
    url: 'mqtt://broker.local:1883', mqtt: { version: '5', topics: [{ name: 'devices/+/telemetry', enabled: true }, { name: 'devices/+/ack', enabled: true }] },
  });

  await page.getByLabel('Method and protocol').first().click();
  await expect(page.getByText('Stop the running request to change its protocol.')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByTestId('mqtt-send').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as MqttWindow).__mqttCalls.find(c => c.name === 'publish')?.args[1])).toMatchObject({
    topic: 'devices/kitchen/commands', payload: '{"op":"set","target":22}', format: 'json', qos: 1, retain: false,
  });
  await expect(page.getByTestId('mqtt-message').filter({ hasText: 'devices/kitchen/ack' })).toBeVisible();
  await page.getByTestId('mqtt-message').filter({ hasText: 'devices/kitchen/ack' }).locator('.sse-event-main').click();
  await expect(page.getByTestId('mqtt-panel')).toContainText('application/json');
  await expect(page.getByTestId('mqtt-panel')).toContainText('trace');

  await page.getByRole('button', { name: 'Message filter: All messages' }).click();
  await page.getByRole('option', { name: 'Sent', exact: true }).click();
  await expect(page.getByTestId('mqtt-message')).toHaveCount(1);
  await page.getByRole('button', { name: 'Message filter: Sent' }).click();
  await page.getByRole('option', { name: 'All messages', exact: true }).click();
  await page.getByRole('button', { name: 'Search response' }).click();
  await page.getByLabel('Search messages').fill('hall');
  await expect(page.getByTestId('mqtt-message')).toHaveCount(1);
  await page.getByRole('button', { name: 'Search response' }).click();
  await captureDocsScreenshot(page, 'request-mqtt');

  await page.getByRole('tab', { name: 'Topics' }).click();
  await page.getByRole('checkbox', { name: 'Subscribe to devices/+/ack' }).locator('..').click();
  await expect.poll(() => page.evaluate(() => (window as unknown as MqttWindow).__mqttCalls.find(c => c.name === 'unsubscribe')?.args[1])).toBe('devices/+/ack');
  await expect(page.getByLabel('Subscribed', { exact: true })).toHaveCount(1);
  await captureDocsScreenshot(page, 'request-mqtt-topics');

  await page.getByRole('tab', { name: 'Last Will' }).click();
  await page.getByRole('checkbox', { name: 'Send a last will' }).locator('..').click();
  await page.getByLabel('Last will topic').fill('devices/kitchen/status');
  await fillCodeEditor(page, 'mqtt-will-editor', 'offline');

  await page.locator('.btn-send').click();
  await expect(page.getByTestId('mqtt-panel')).toContainText('Disconnected');

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests.find(r => r.requestType === 'mqtt' && !r.isDraft)?.mqtt)).toMatchObject({
    topic: 'devices/kitchen/commands', qos: 1, format: 'json',
    topics: [{ name: 'devices/+/telemetry', enabled: true }, { name: 'devices/+/ack', enabled: false }],
    will: { enabled: true, topic: 'devices/kitchen/status', payload: 'offline' },
  });
  const saved = await page.evaluate(() => window.__kurloE2E.store.requests.find(r => r.requestType === 'mqtt' && !r.isDraft)!);
  const tab = page.locator('.saved-request-tab.active');
  await tab.hover();
  await tab.getByLabel('Close tab').click();
  await page.locator('.collection-request').filter({ hasText: saved.name }).first().click();
  await expect(page.getByLabel('Broker URL')).toHaveValue('mqtt://broker.local:1883');
  await page.getByRole('tab', { name: 'Message' }).click();
  await expect(page.getByLabel('Publish topic')).toHaveValue('devices/kitchen/commands');
});

test('keeps a flood of MQTT messages over a thousand topics responsive', async ({ page }) => {
  await installKurloBridge(page);
  await page.goto('/');
  await page.evaluate(() => {
    const w = window as unknown as MqttWindow;
    const bridge = w.go.api.App as unknown as Record<string, (id: string, arg?: unknown) => Promise<unknown>>;
    bridge.MqttConnect = async id => {
      w.__mqttCalls = [{ name: 'connect', args: [id] }];
      setTimeout(() => w.__kurloE2E.emit('mqtt:open', { sessionId: id, url: 'mqtt://broker.local:1883', clientId: 'kurlo-load', version: '5', sessionPresent: false, timestamp: Date.now() }), 10);
    };
    bridge.MqttDisconnect = async () => {};
  });
  await page.getByLabel('New unsaved request').click();
  await chooseRequestType(page, 'MQTT');
  await page.getByLabel('Broker URL').fill('mqtt://broker.local:1883');
  await page.locator('.btn-send').click();
  await expect(page.getByTestId('mqtt-panel')).toContainText('Connected');

  const sessionId = await page.evaluate(() => String((window as unknown as MqttWindow).__mqttCalls[0].args[0]));
  const timing = await page.evaluate(async id => {
    const w = window as unknown as MqttWindow;
    const started = performance.now();
    let longest = 0;
    for (let batch = 0; batch < 25; batch++) {
      const messages = Array.from({ length: 1000 }, (_, i) => {
        const n = batch * 1000 + i;
        const big = n % 2500 === 7;
        return {
          id: 'load-' + n, direction: n % 5 === 0 ? 'outgoing' : 'incoming', topic: 'plant/line-' + (n % 1000).toString().padStart(4, '0') + '/telemetry',
          payload: big ? 'x'.repeat(256 * 1024) : JSON.stringify({ n, temperature: 20 + (n % 70) / 10 }), size: big ? 4 << 20 : 30, truncated: big,
          qos: n % 3, retain: false, timestamp: 1767268800000 + n, isSystem: false, isError: false,
        };
      });
      const before = performance.now();
      w.__kurloE2E.emit('mqtt:messages', { sessionId: id, messages });
      await new Promise(requestAnimationFrame);
      longest = Math.max(longest, performance.now() - before);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    return { total: performance.now() - started, longest };
  }, sessionId);
  console.log(`25000 MQTT messages: ${Math.round(timing.total)} ms in total, slowest batch ${Math.round(timing.longest)} ms`);
  expect(timing.longest).toBeLessThan(500);

  const panel = page.getByTestId('mqtt-panel');
  await expect(panel).toContainText('↓ 4000 · ↑ 1000');
  expect(await page.getByTestId('mqtt-message').count()).toBeLessThanOrEqual(100);
  await expect(page.getByTestId('mqtt-message').first()).toContainText('"n":24999');

  await page.getByLabel('Topic filter').fill('line-0999');
  await expect(page.getByTestId('mqtt-message')).toHaveCount(5);
  await page.getByLabel('Topic filter').fill('plant/+/telemetry');
  await expect(page.getByTestId('mqtt-message').first()).toContainText('"n":24999');
  await page.getByLabel('Topic filter').fill('other/+/telemetry');
  await expect(page.getByTestId('mqtt-message')).toHaveCount(0);
  await page.getByLabel('Topic filter').fill('plant/line-0042/#');
  await expect(page.getByTestId('mqtt-message')).toHaveCount(5);
  await page.getByLabel('Topic filter').fill('');

  await page.getByRole('button', { name: 'Search response' }).click();
  await page.getByLabel('Search messages').fill('"n":20008');
  await expect(page.getByTestId('mqtt-message')).toHaveCount(1);
  await page.getByLabel('Search messages').fill('');
  await page.locator('.mqtt-log').evaluate(node => { node.dispatchEvent(new WheelEvent('wheel', { deltaY: 1000, bubbles: true })); node.scrollTop = node.scrollHeight; });
  await expect(page.getByTestId('mqtt-message').last()).toContainText('"n":20000');
  expect(await page.getByTestId('mqtt-message').count()).toBeLessThanOrEqual(200);
  await page.evaluate(id => (window as unknown as MqttWindow).__kurloE2E.emit('mqtt:messages', { sessionId: id, messages: [{ id: 'late', direction: 'incoming', topic: 'plant/late', payload: 'late', size: 4, qos: 0, timestamp: Date.now(), isSystem: false, isError: false }] }), sessionId);
  await expect(panel).toContainText('↓ 4001 · ↑ 999');
  await page.waitForTimeout(200);
  expect(await page.locator('.mqtt-log').evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThan(80);
  await page.locator('.mqtt-log').evaluate(node => { node.scrollTop = 0; });
  await expect(page.getByTestId('mqtt-message').first()).toContainText('plant/late');

  await page.getByLabel('Search messages').fill('xxxxxxxx');
  await expect(page.getByTestId('mqtt-message')).toHaveCount(2);
  await page.getByTestId('mqtt-message').first().locator('.sse-event-main').click();
  await expect(panel).toContainText('4.00 MB · the first 256 KB are shown');
});

test('opens and connects a saved MQTT request with three hundred subscriptions', async ({ page }) => {
  const topics = Array.from({ length: 300 }, (_, i) => ({ name: `site/${i}/+/state`, qos: i % 3, enabled: true, description: `Site ${i}` }));
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [{ id: 'iot', workspaceId: 'workspace-e2e', name: 'IoT' }],
    activeId: 'fleet', openIds: ['fleet'],
    requests: [{ id: 'fleet', collectionId: 'iot', name: 'Fleet', requestType: 'mqtt', url: 'mqtt://broker.local:1883', bodyType: 'text', rawBodyType: 'text', bodyContent: '', mqtt: { version: '5', topics } }],
  });
  await page.goto('/');
  await page.evaluate(() => {
    const w = window as unknown as MqttWindow;
    const bridge = w.go.api.App as unknown as Record<string, (id: string, arg?: unknown) => Promise<unknown>>;
    bridge.MqttConnect = async (id, req) => {
      const subscribed = (req as { mqtt: { topics: { name: string; qos: number; enabled: boolean }[] } }).mqtt.topics.filter(t => t.enabled);
      setTimeout(() => {
        w.__kurloE2E.emit('mqtt:open', { sessionId: id, url: 'mqtt://broker.local:1883', clientId: 'kurlo-fleet', version: '5', sessionPresent: false, timestamp: Date.now() });
        w.__kurloE2E.emit('mqtt:messages', { sessionId: id, messages: subscribed.map((t, i) => ({ id: 'sub-' + i, direction: 'system', isSystem: true, isError: false, topic: t.name, qos: t.qos, size: 0, timestamp: Date.now(), message: `Subscribed to ${t.name} (QoS ${t.qos})` })) });
      }, 10);
    };
    bridge.MqttDisconnect = async () => {};
  });
  await expect(page.getByRole('tab', { name: /Topics\s*300/ })).toBeVisible();
  const opened = Date.now();
  await page.getByRole('tab', { name: /Topics/ }).click();
  await expect(page.getByLabel('Topic 1', { exact: true })).toHaveValue('site/0/+/state');
  const openMs = Date.now() - opened;
  expect(await page.getByTestId('mqtt-topic-row').count()).toBeLessThan(100);
  const connected = Date.now();
  await page.locator('.btn-send').click();
  await expect(page.getByTestId('mqtt-panel')).toContainText('Subscribed to site/299/+/state');
  await expect(page.getByLabel('Subscribed', { exact: true }).first()).toBeVisible();
  const subscribeMs = Date.now() - connected;
  await page.locator('.mqtt-pane').evaluate(node => { node.scrollTop = node.scrollHeight; });
  console.log(`300 subscriptions: tab opened in ${openMs} ms, confirmed in ${subscribeMs} ms`);
  expect(openMs).toBeLessThan(2000);
  expect(subscribeMs).toBeLessThan(2000);
  await expect(page.getByLabel('Topic 300')).toHaveValue('site/299/+/state');
  await expect(page.getByTestId('mqtt-topic-row').last().getByLabel('Subscribed', { exact: true })).toBeVisible();
});

test('sends and keeps every MQTT connection setting', async ({ page }) => {
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [{ id: 'iot', workspaceId: 'workspace-e2e', name: 'IoT' }],
    activeId: 'sensor', openIds: ['sensor'],
    requests: [{ id: 'sensor', collectionId: 'iot', name: 'Sensor', requestType: 'mqtt', url: 'mqtts://broker.local:8883', bodyType: 'text', rawBodyType: 'text', bodyContent: '', mqtt: { version: '5' } }],
  });
  await page.goto('/');
  await page.evaluate(() => {
    const w = window as unknown as MqttWindow;
    const bridge = w.go.api.App as unknown as Record<string, (id: string, arg?: unknown) => Promise<unknown>>;
    w.__mqttCalls = [];
    (w.go.api.App as unknown as { OpenFileDialog: (title: string) => Promise<string> }).OpenFileDialog = async title => (title.includes('key') ? '/certs/device.key' : '/certs/device.crt');
    bridge.MqttConnect = async (id, req) => {
      w.__mqttCalls.push({ name: 'connect', args: [id, req] });
      setTimeout(() => w.__kurloE2E.emit('mqtt:open', { sessionId: id, url: 'mqtts://broker.local:8883', clientId: 'sensor-7', version: '5', sessionPresent: true, timestamp: Date.now() }), 10);
    };
    bridge.MqttDisconnect = async () => {};
  });

  await page.getByRole('tab', { name: /^Settings/ }).click();
  await page.getByLabel('Client ID').fill('sensor-{{device}}');
  await page.getByRole('checkbox', { name: 'Clean session' }).locator('..').click();
  await page.locator('.postman-setting').filter({ hasText: 'Keep alive' }).locator('input').fill('15');
  await page.locator('.postman-setting').filter({ hasText: 'Connection timeout' }).locator('input').fill('5000');
  await page.getByRole('checkbox', { name: 'Auto reconnect' }).locator('..').click();
  await page.locator('.postman-setting').filter({ hasText: 'Verify server certificate' }).locator('.switch-control').click();
  const certSetting = page.locator('.client-cert-setting');
  await certSetting.getByRole('button', { name: 'Choose file…' }).first().click();
  await certSetting.getByRole('button', { name: 'Choose file…' }).nth(1).click();
  await page.getByLabel('Client ID').evaluate(node => node.scrollIntoView({ block: 'end' }));
  await page.getByLabel('Client ID').evaluate(node => { const pane = node.closest('.settings-section')?.parentElement; if (pane) pane.scrollTop = 0; });
  await captureDocsScreenshot(page, 'request-mqtt-settings');

  await page.getByRole('tab', { name: /^Auth/ }).click();
  await page.getByRole('button', { name: /^Auth type/ }).click();
  await page.getByRole('option', { name: 'Username and password' }).click();
  await page.locator('#auth-user').fill('device-7');
  await page.getByLabel(/^Password/).first().fill('s3cret');

  await page.getByRole('tab', { name: /^Properties/ }).click();
  await page.getByLabel('Session expiry interval').fill('120');
  await page.getByLabel('Receive maximum').fill('50');
  await page.getByRole('button', { name: 'Add user property' }).click();
  await page.getByLabel('Connect user properties key 1').fill('region');
  await page.getByLabel('Connect user properties value 1').fill('eu');

  await page.getByRole('tab', { name: /^Last Will/ }).click();
  await page.getByRole('checkbox', { name: 'Send a last will' }).locator('..').click();
  await page.getByLabel('Last will topic').fill('devices/7/status');
  await page.getByLabel('Will delay interval').fill('10');
  await fillCodeEditor(page, 'mqtt-will-editor', 'offline');

  await page.locator('.btn-send').click();
  await expect(page.getByTestId('mqtt-panel')).toContainText('session resumed');
  const req = await page.evaluate(() => (window as unknown as MqttWindow).__mqttCalls[0].args[1]);
  expect(req).toMatchObject({
    url: 'mqtts://broker.local:8883', enableSSLVerification: false, clientCertPath: '/certs/device.crt', clientKeyPath: '/certs/device.key',
    auth: { type: 'basic', username: 'device-7', password: 's3cret' },
    mqtt: {
      version: '5', clientId: 'sensor-{{device}}', cleanSession: false, keepAliveSec: 15, connectTimeoutMs: 5000, autoReconnect: true,
      connectProperties: { sessionExpiryInterval: '120', receiveMaximum: '50', userProperties: [{ key: 'region', value: 'eu', enabled: true }] },
      will: { enabled: true, topic: 'devices/7/status', payload: 'offline', delayInterval: '10' },
    },
  });
  await page.locator('.btn-send').click();

  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests.find(r => r.id === 'sensor')?.mqtt)).toMatchObject({
    clientId: 'sensor-{{device}}', cleanSession: false, keepAliveSec: 15, connectTimeoutMs: 5000, autoReconnect: true,
    connectProperties: { sessionExpiryInterval: '120', receiveMaximum: '50' }, will: { enabled: true, topic: 'devices/7/status', delayInterval: '10' },
  });
  const tab = page.locator('.saved-request-tab.active');
  await tab.hover();
  await tab.getByLabel('Close tab').click();
  await page.locator('.collection-request').filter({ hasText: 'Sensor' }).first().click();
  await page.getByRole('tab', { name: /^Settings/ }).click();
  await expect(page.getByLabel('Client ID')).toHaveValue('sensor-{{device}}');
  await expect(page.getByRole('checkbox', { name: 'Clean session' })).not.toBeChecked();
  await expect(page.getByRole('checkbox', { name: 'Auto reconnect' })).toBeChecked();
  await expect(page.locator('.postman-setting').filter({ hasText: 'Keep alive' }).locator('input')).toHaveValue('15');
  await expect(certSetting.getByRole('textbox', { name: 'Client certificate path' })).toHaveValue('/certs/device.crt');
});
