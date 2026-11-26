import { expect, test } from '@playwright/test';
import { chooseRequestType, fillCodeEditor } from './support/actions';
import { installKurloBridge, type E2EWindow } from './support/bridge';
import { captureDocsScreenshot } from './support/screenshots';

test('produces and consumes Kafka records and saves the subscription', async ({ page }) => {
  await installKurloBridge(page);
  await page.goto('/');
  await page.evaluate(() => {
    const bridge = (window as E2EWindow).go.api.App;
    bridge.ListKafkaTopics = async () => ['orders.created', 'orders.paid', 'shipments.created'];
    bridge.SendRequest = async req => {
      window.__kurloE2E.sentRequests.push(req);
      const record = { topic: 'orders.created', key: 'order-42', value: '{"id":42,"event":"created"}', partition: 1, offset: '108', timestamp: '2026-01-01T11:23:10Z', headers: [] };
      return { statusCode: 200, status: req.kafka?.mode === 'produce' ? 'Produced' : 'Consumed', body: JSON.stringify(req.kafka?.mode === 'consume' ? [record, { ...record, key: 'order-43', value: '{"id":43,"event":"created"}', offset: '109' }, { ...record, key: 'order-44', value: '{"id":44,"event":"created"}', offset: '110' }] : [record]), headers: [], duration: 12 };
    };
  });
  await page.getByLabel('New unsaved request').click();
  await chooseRequestType(page, 'Kafka');
  await page.getByLabel('Bootstrap brokers').fill('localhost:9092');
  await expect(page.locator('.saved-request-tab.active svg[data-kind="kafka"]')).toBeVisible();
  await expect(page.getByLabel('Method and protocol').first().locator('svg[data-kind="kafka"]')).toBeVisible();
  await page.getByLabel('Producer topic').fill('orders.created');
  await page.getByLabel('Message key', { exact: true }).fill('order-42');
  await fillCodeEditor(page, 'kafka-message-editor', '{"id":42,"event":"created"}');
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByRole('button', { name: 'Connected', exact: true })).toBeVisible();
  await page.locator('.btn-send').click();
  await expect(page.getByLabel('Kafka response')).toContainText('Produced');
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.at(-1))).toMatchObject({
    url: 'localhost:9092', body: '{"id":42,"event":"created"}', kafka: { mode: 'produce', topic: 'orders.created', key: 'order-42' },
  });
  await captureDocsScreenshot(page, 'request-kafka-producer');
  await page.getByRole('button', { name: 'Kafka operation: Produce' }).click();
  await page.getByRole('option', { name: 'Consume', exact: true }).click();
  await page.getByRole('checkbox', { name: 'orders.created' }).check();
  await page.getByRole('button', { name: 'Start from: Latest' }).click();
  await page.getByRole('option', { name: 'Earliest' }).click();
  await page.getByLabel('Stop value').fill('3');
  await page.locator('.btn-send').click();
  await expect(page.getByLabel('Kafka response')).toContainText('Consumed');
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click();
  await expect(page.getByLabel('Selected Kafka record')).toContainText('"offset": "108"');
  await page.getByRole('tab', { name: 'Value', exact: true }).click();
  await captureDocsScreenshot(page, 'request-kafka');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  const dialog = page.getByRole('dialog');
  if (await dialog.isVisible()) await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests.find(r => r.requestType === 'kafka' && !r.isDraft)?.kafka)).toMatchObject({
    mode: 'consume', topics: [{ name: 'orders.created' }], startFrom: 'earliest', stopValue: '3',
  });
  const saved = await page.evaluate(() => window.__kurloE2E.store.requests.find(r => r.requestType === 'kafka' && !r.isDraft)!);
  const tab = page.locator('.saved-request-tab.active');
  await tab.hover();
  await tab.getByLabel('Close tab').click();
  await expect(page.locator('.collection-request').filter({ hasText: saved.name }).first().locator('svg[data-kind="kafka"]')).toBeVisible();
  await page.locator('.collection-request').filter({ hasText: saved.name }).first().click();
  await expect(page.getByLabel('Bootstrap brokers')).toHaveValue('localhost:9092');
  await expect(page.getByLabel('Stop value')).toHaveValue('3');
  await expect(page.getByLabel('Consume settings')).toContainText('orders.created');
  await page.evaluate(() => {
    const bridge = (window as E2EWindow).go.api.App;
    bridge.SendRequest = req => new Promise(resolve => {
      window.__kurloE2E.emit('kafka:records:' + req.kafkaStreamId, [{ topic: 'orders.created', key: null, value: 'live order', partition: 1, offset: '112', timestamp: '2026-01-01T12:00:00Z', headers: [] }]);
      bridge.CancelRequest = async () => { resolve({ error: 'context canceled' }); };
    });
  });
  await page.locator('.btn-send').click();
  await expect(page.getByLabel('Selected Kafka record')).toContainText('live order');
  await page.locator('.btn-send').click();
  await expect(page.getByLabel('Kafka response')).toContainText('Stopped');
  await expect(page.getByLabel('Selected Kafka record')).toContainText('live order');
});

test('keeps thousands of topics and records responsive and selectable', async ({ page }) => {
  await installKurloBridge(page);
  await page.goto('/');
  await page.evaluate(() => {
    const bridge = (window as E2EWindow).go.api.App;
    bridge.ListKafkaTopics = async () => Array.from({ length: 3000 }, (_, i) => `topic.${String(i).padStart(4, '0')}`);
    bridge.SendRequest = async () => {
      const records = Array.from({ length: 10000 }, (_, i) => ({ topic: 'topic.0001', key: 'key-' + i, value: JSON.stringify({ i }), partition: i % 3, offset: String(1000000 + i), timestamp: new Date(1767268990000 + i * 1000).toISOString(), headers: [] }));
      return { statusCode: 200, status: 'Consumed', body: JSON.stringify(records), headers: [], duration: 10 };
    };
  });
  await page.getByLabel('New unsaved request').click();
  await chooseRequestType(page, 'Kafka');
  await page.getByLabel('Bootstrap brokers').fill('localhost:9092');
  await page.getByRole('button', { name: 'Kafka operation: Produce' }).click();
  await page.getByRole('option', { name: 'Consume', exact: true }).click();
  await page.getByRole('button', { name: 'Test connection' }).click();
  await expect(page.getByText('3000', { exact: true })).toBeVisible();
  expect(await page.locator('.topic-option').count()).toBeLessThan(400);
  await page.getByLabel('Filter topics').fill('2999');
  await page.getByRole('checkbox', { name: 'topic.2999' }).check();
  await expect(page.getByLabel('Consume settings')).toContainText('topic.2999');
  await page.locator('.btn-send').click();
  await expect(page.getByLabel('Kafka response')).toContainText('10000 records');
  expect(await page.locator('.kafka-record').count()).toBeLessThan(400);
  await page.locator('.record-rows').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.locator('.kafka-record').filter({ hasText: 'key-9998' }).click();
  await expect(page.locator('.kafka-record[aria-pressed="true"]')).toContainText('key-9998');
  await page.getByRole('tab', { name: 'Metadata', exact: true }).click();
  await expect(page.getByLabel('Selected Kafka record')).toContainText('"offset": "1009998"');
  await page.getByLabel('Search records').fill('key-42');
  await expect(page.locator('.kafka-record').first()).toContainText('key-42');
});
