import { expect, test } from '@playwright/test';
import { collectionRow } from './support/actions';
import { installKurloBridge, type E2EWindow } from './support/bridge';
import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';
import { captureDocsScreenshot } from './support/screenshots';

test('exports native Postman v3 gRPC YAML and keeps Postman v2.1 JSON available', async ({ page }) => {
  if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
  const collection = { id: 'services', name: 'Services', workspaceId: 'workspace-e2e' };
  const grpc = {
    id: 'grpc-health',
    collectionId: collection.id,
    name: 'Check Health',
    requestType: 'grpc',
    url: 'grpc.example.com:443',
    grpcMethod: 'grpc.health.v1.Health/Check',
    bodyType: 'json',
    bodyContent: '{"service":"orders"}',
  };
  await installKurloBridge(page, '', 'browser/e2e', false, { collections: [collection], requests: [grpc] });
  await page.addInitScript(() => {
    const app = (window as unknown as E2EWindow).go.api.App;
    app.WriteNewCollectionTextFiles = async (parent, name, files) => {
      window.__kurloE2E.savedFiles.push(...files.map(file => ({ name, path: `${parent}/${name}/${file.path}`, content: file.content })));
      return '';
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Collections', exact: true }).click();
  const row = collectionRow(page, collection.name);
  const chooseExport = async () => {
    await row.hover();
    await row.getByRole('button', { name: 'Collection menu' }).click();
    await page.getByRole('button', { name: 'Export…', exact: true }).click();
    return page.getByRole('dialog', { name: 'Export collection' });
  };

  const formats = await chooseExport();
  await expect(formats.getByText('Postman collection v2.1', { exact: true })).toBeVisible();
  await expect(formats.getByText('Postman collection v3 (YAML folder)', { exact: true })).toBeVisible();
  await formats.getByText('Postman collection v3 (YAML folder)', { exact: true }).click();
  await captureDocsScreenshot(page, 'postman-export-formats', formats);
  await formats.getByRole('button', { name: 'Export', exact: true }).click();
  const prompt = page.getByRole('dialog', { name: 'Postman v3 folder' });
  await expect(prompt.getByRole('textbox')).toHaveValue('services-postman-v3');
  await prompt.getByRole('textbox').press('Enter');
  const success = page.getByRole('dialog', { name: 'Postman v3 folder exported' });
  await expect(success).toContainText('Workspaces → Local Files → Open Folder');
  const afterV3 = await page.evaluate(() => window.__kurloE2E.savedFiles);
  expect(afterV3.map(file => file.path)).toEqual([
    '/exports/services-postman-v3/postman/collections/services/.resources/definition.yaml',
    '/exports/services-postman-v3/postman/collections/services/check-health.request.yaml',
  ]);
  expect(afterV3[1].content).toContain('$kind: grpc-request');
  expect(afterV3[1].content).toContain('methodPath: grpc.health.v1.Health/Check');
  await success.getByRole('button', { name: 'OK' }).click();

  const v2 = await chooseExport();
  await v2.getByText('Postman collection v2.1', { exact: true }).click();
  await v2.getByRole('button', { name: 'Export', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.savedFiles.length)).toBe(3);
  const json = await page.evaluate(() => window.__kurloE2E.savedFiles[2]);
  expect(json.name).toBe('Services.postman_collection.json');
  expect(JSON.parse(json.content)).toMatchObject({
    info: { schema: 'https://schema.getpostman.com/json/collection/v2.1.0/collection.json' },
    item: [{ name: grpc.name, 'x-kurlo': { requestType: 'grpc', grpcMethod: grpc.grpcMethod } }],
  });
});
