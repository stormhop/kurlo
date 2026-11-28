import { expect, test } from '@playwright/test';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { installKurloBridge } from './support/bridge';
import { reviewShot } from './support/reviewShot';

const count = 21;
const messages = Array.from({ length: count }, (_, index) => ({ id: `m-${index + 1}`, name: `Message ${index + 1}`, content: `{"n":${index + 1}}`, bodyType: 'json' }));
const kinds = {
  http: { requestType: 'http', method: 'POST', url: 'https://api.example.test/orders', bodyType: 'json', rawBodyType: 'json', bodyContent: '{}', activeBodyVariant: 'Current', bodyVariants: messages.slice(0, 4).map(m => ({ name: m.name, bodyType: 'json', rawBodyType: 'json', bodyContent: m.content, bodyFilePath: '', bodyFileName: '', formRows: [] })), label: 'Saved body variants' },
  ws: { requestType: 'ws', method: 'GET', url: 'wss://echo.example.test', savedMessages: messages, label: 'Saved messages' },
  socketio: { requestType: 'socketio', method: 'GET', url: 'https://sio.example.test', savedMessages: messages, label: 'Saved messages' },
  mqtt: { requestType: 'mqtt', method: 'GET', url: 'mqtt://broker.example.test', mqtt: { savedMessages: messages.map(m => ({ id: m.id, name: m.name, topic: '', payload: m.content, format: 'json', qos: 0, retain: false })) }, label: 'Saved messages' },
};

for (const [kind, { label, ...request }] of Object.entries(kinds)) {
  for (const editorHeight of [180, 420, 700]) {
    test(`keeps the ${kind} Saved menu on screen with a ${editorHeight}px editor`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 860 });
      await installKurloBridge(page, '', 'browser/e2e', false, {
        collections: [{ id: 'col', workspaceId: 'workspace-e2e', name: 'Saved' }],
        requests: [{ id: 'req', collectionId: 'col', collection: 'Saved', name: 'Saved menu', auth: { type: 'none' }, requestTab: 'body', ...request }],
        activeId: 'req', openIds: ['req'],
      });
      await page.addInitScript(() => localStorage.setItem('kurlo.responseLayout.v1', 'below'));
      await page.goto('/');
      const divider = page.getByRole('button', { name: 'Resize panels', exact: true });
      const box = await divider.boundingBox();
      if (!box) throw new Error('Missing divider');
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.mouse.down();
      await page.mouse.move(box.x + box.width / 2, editorHeight, { steps: 6 });
      await page.mouse.up();
      const trigger = page.getByRole('button', { name: new RegExp(`^${label}`) });
      await trigger.click();
      const menu = page.getByRole('dialog', { name: label });
      await expect(menu).toBeVisible();
      await reviewShot(page, { path: join(tmpdir(), `kurlo-saved-menu-${kind}-${editorHeight}.png`), animations: 'disabled' });
      const visible = await menu.evaluate(node => {
        const rect = node.getBoundingClientRect();
        const inside = rect.top >= 0 && rect.left >= 0 && rect.bottom <= window.innerHeight && rect.right <= window.innerWidth;
        const points = [[rect.left + 12, rect.top + 12], [rect.right - 12, rect.bottom - 12], [rect.left + rect.width / 2, rect.top + rect.height / 2]];
        return { inside, onTop: points.every(([x, y]) => node.contains(document.elementFromPoint(x, y))), height: rect.height };
      });
      expect(visible).toMatchObject({ inside: true, onTop: true });
      expect(visible.height).toBeGreaterThan(150);
      await expect(menu.getByRole('button', { name: /^Load / })).toHaveCount(kind === 'http' ? 5 : count);
      const last = menu.getByRole('button', { name: /^Load / }).last();
      const list = menu.getByRole('list');
      await list.hover();
      for (let step = 0; step < 4; step += 1) await page.mouse.wheel(0, 3000);
      await expect.poll(() => list.evaluate(node => Math.ceil(node.scrollTop + node.clientHeight) >= node.scrollHeight)).toBe(true);
      await expect(last).toBeInViewport();
      await last.click();
      await expect(menu).toBeHidden();
    });
  }
}
