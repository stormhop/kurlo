import { installKurloBridge } from './bridge';
import { expect, type Page } from '@playwright/test';

export async function openRequestWithSavedMessages(page: Page, count: number) {
  const savedMessages = Array.from({ length: count }, (_, index) => ({ id: `m-${index + 1}`, name: `Message ${index + 1}`, content: `{"op":"subscribe","channel":"orders-${index + 1}"}`, bodyType: 'json' }));
  await installKurloBridge(page, '', 'browser/e2e', false, {
    collections: [{ id: 'col-ws', workspaceId: 'workspace-e2e', name: 'Test' }],
    requests: [{ id: 'ws-echo', collectionId: 'col-ws', collection: 'Test', name: 'WS echo', requestType: 'ws', method: 'GET', url: 'ws://localhost:4567/ws', auth: { type: 'none' }, savedMessages }],
    activeId: 'ws-echo',
    openIds: ['ws-echo'],
  });
  await page.goto('/');
  const trigger = page.getByRole('button', { name: /^Saved messages/ });
  await expect(trigger).toHaveAccessibleName(`Saved messages, ${count}`);
  await trigger.click();
  return page.getByRole('dialog', { name: 'Saved messages' });
}
