import type { E2EWindow } from './support/bridge';
import { clickTabClose, collectionRow } from './support/actions';

import { agentStore, connection, installAgentBridge } from './support/agent';

import { installKurloBridge } from './support/bridge';

import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';

import { expectPanelSlide, samplePanelSlide } from './support/layout';

import { captureDocsScreenshot } from './support/screenshots';

import { expect, test, type Locator } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Agent", () => {
  test('keeps environment colors across agent controls, collection settings and k6 tests', async ({ page }, testInfo) => {
    const stagingName = 'Staging environment with a very long name for the payments integration';
    await installKurloBridge(page, '', 'browser/e2e', false, {
      ...agentStore,
      activeEnvironmentId: 'env-local',
      environments: [
        { ...agentStore.environments[0], color: 'red' },
        { id: 'env-staging', workspaceId: 'workspace-e2e', name: stagingName, color: 'blue', values: [] },
        { id: 'env-plain', workspaceId: 'workspace-e2e', name: 'Plain', values: [] },
        { id: 'env-other', workspaceId: 'another-workspace', name: 'Other workspace', color: 'green', values: [] },
      ],
    });
    await installAgentBridge(page, [connection]);
    await page.goto('/');
    const assertColor = async (element: Locator, token: string) => {
      const dot = element.locator('.env-color-dot');
      await expect(dot).toBeVisible();
      const actual = await dot.evaluate(node => getComputedStyle(node).backgroundColor);
      const expected = await page.evaluate(token => {
        const probe = document.createElement('span');
        probe.style.backgroundColor = `var(--${token})`;
        document.body.append(probe);
        const color = getComputedStyle(probe).backgroundColor;
        probe.remove();
        return color;
      }, token);
      expect(actual).toBe(expected);
    };
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const agent = page.locator('.agent-main');
    const agentEnvironment = agent.getByRole('button', { name: /^Environment:/ });
    await agentEnvironment.click();
    await assertColor(page.getByRole('option', { name: 'Local', exact: true }), 'danger');
    await page.getByRole('option', { name: 'Local', exact: true }).click();
    await assertColor(agentEnvironment, 'danger');
    await expect(agentEnvironment).not.toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await page.setViewportSize({ width: 640, height: 480 });
    const environmentChip = agentEnvironment.locator('..').locator('..');
    await expect(environmentChip).toHaveClass(/compact/);
    await expect(environmentChip.locator('.agent-composer-chip-icon')).toHaveCSS('color', await agentEnvironment.locator('.env-color-dot').evaluate(node => getComputedStyle(node).backgroundColor));
    await page.screenshot({ path: join(tmpdir(), `kurlo-environment-agent-compact-${testInfo.project.name}.png`), animations: 'disabled' });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.screenshot({ path: join(tmpdir(), `kurlo-environment-agent-${testInfo.project.name}.png`), animations: 'disabled' });
    await agentEnvironment.click();
    await page.getByRole('option', { name: stagingName, exact: true }).click();
    await assertColor(agentEnvironment, 'info');
    await agentEnvironment.click();
    await page.getByRole('option', { name: 'Plain', exact: true }).click();
    await expect(agentEnvironment).not.toHaveClass(/env-colored/);
    await expect(agentEnvironment.locator('.env-color-dot')).toHaveCount(0);
    await agentEnvironment.click();
    await page.getByRole('option', { name: 'No environment', exact: true }).click();
    await expect(agentEnvironment).not.toHaveClass(/env-colored/);

    await page.getByRole('button', { name: 'Collections', exact: true }).click();
    await collectionRow(page, 'Shop API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Shop API').getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('button', { name: 'Pin environment', exact: true }).click();
    await expect(page.getByRole('option', { name: /Local/ }).locator('.env-color-dot')).toHaveCSS('background-color', await page.evaluate(() => {
      const probe = document.createElement('span');
      probe.style.backgroundColor = 'var(--danger)';
      document.body.append(probe);
      const color = getComputedStyle(probe).backgroundColor;
      probe.remove();
      return color;
    }));
    await page.getByRole('option', { name: /Local/ }).click();
    await expect(page.getByRole('list', { name: 'Pinned environments' }).locator('.env-color-dot')).toBeVisible();
    await page.screenshot({ path: join(tmpdir(), `kurlo-environment-collection-${testInfo.project.name}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Revert unsaved changes', exact: true }).click();

    await collectionRow(page, 'Shop API').getByLabel('Collection menu').click();
    await collectionRow(page, 'Shop API').getByRole('button', { name: 'New load test', exact: true }).click();
    const loadTest = page.locator('section[aria-label="Load test"]');
    const loadEnvironment = loadTest.getByRole('button', { name: /^Environment:/ });
    await expect(loadEnvironment).toHaveAccessibleName('Environment: Active environment');
    await assertColor(loadEnvironment, 'danger');
    await loadEnvironment.click();
    await expect(page.getByRole('option', { name: 'Other workspace', exact: true })).toHaveCount(0);
    await expect(page.getByRole('option', { name: 'Local', exact: true }).locator('.env-color-dot')).toBeVisible();
    await page.getByRole('option', { name: 'Local', exact: true }).click();
    const shortWidth = (await loadEnvironment.boundingBox())!.width;
    const rem = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
    expect(shortWidth).toBeCloseTo(8.625 * rem, 1);
    await page.screenshot({ path: join(tmpdir(), `kurlo-k6-environment-short-${testInfo.project.name}.png`), animations: 'disabled' });
    await loadEnvironment.click();
    await expect(page.getByRole('option', { name: stagingName, exact: true })).toContainText(stagingName);
    await page.getByRole('option', { name: stagingName, exact: true }).click();
    expect((await loadEnvironment.boundingBox())!.width).toBeCloseTo(shortWidth, 1);
    const label = loadEnvironment.locator('span:last-of-type');
    await expect(label).toHaveCSS('text-overflow', 'ellipsis');
    expect(await label.evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
    await expect(loadEnvironment).toHaveAccessibleName(`Environment: ${stagingName}`);
    await assertColor(loadEnvironment, 'info');
    await page.screenshot({ path: join(tmpdir(), `kurlo-environment-k6-${testInfo.project.name}.png`), animations: 'disabled' });
    await page.emulateMedia({ colorScheme: 'dark' });
    await page.screenshot({ path: join(tmpdir(), `kurlo-environment-k6-dark-${testInfo.project.name}.png`), animations: 'disabled' });
    await loadEnvironment.click();
    await page.getByRole('option', { name: 'Plain', exact: true }).click();
    await expect(loadEnvironment).not.toHaveClass(/env-colored/);
    await loadEnvironment.click();
    await page.getByRole('option', { name: 'Active environment', exact: true }).click();
    await assertColor(loadEnvironment, 'danger');
    await page.locator('.environment-select').click();
    await page.locator('.environment-menu').getByRole('button', { name: stagingName, exact: true }).click();
    await assertColor(loadEnvironment, 'info');
    await page.locator('.environment-select').click();
    await page.locator('.environment-menu').getByRole('button', { name: 'No environment', exact: true }).click();
    await expect(loadEnvironment).not.toHaveClass(/env-colored/);
  });

  for (const driver of ['', 'codex']) {
    test(`keeps ${driver || 'Kurlo'} chat controls inside narrow and short windows`, async ({ page }, testInfo) => {
      const collectionName = 'Orders and payments integration with a very long collection name';
      const environmentName = 'Production staging environment with a very long name';
      const modelName = 'A very long model name with extended context and reasoning';
      await installKurloBridge(page, '', 'browser/e2e', false, {
        ...agentStore,
        collections: [{ ...agentStore.collections[0], name: collectionName }],
        environments: [{ ...agentStore.environments[0], name: environmentName }],
      });
      await installAgentBridge(page, driver ? [] : [{ ...connection, model: modelName }]);
      await page.addInitScript(({ driver, modelName }) => {
        const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
        const usage = { input: 3000, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
        if (driver) app.CodexStatus = async () => ({ installed: true, connected: true, authenticated: true, path: '/test/codex', account: 'Test account', model: modelName, models: [{ id: modelName, name: modelName, recommended: true, weakTools: false, efforts: ['low', 'medium', 'xhigh'], defaultEffort: 'xhigh' }] });
        const chat = { id: 'long-chat', workspaceId: 'workspace-e2e', driver, title: 'A long saved conversation title that should leave room for its actions', collection: '', environment: '', model: modelName, messages: [{ role: 'user', blocks: [{ type: 'text', text: 'Explain this response' }] }, { role: 'assistant', blocks: [{ type: 'text', text: 'Response details\n\n' + 'A'.repeat(200) }, { type: 'tool_use', id: 'pending-write', name: 'save_request', input: '{}' }] }], usage, allowedTools: [], createdAt: Date.now(), updatedAt: Date.now() };
        app.AgentChats = async (workspaceId: string) => workspaceId === chat.workspaceId ? [chat] : [];
        app.AgentChat = async () => structuredClone(chat);
        app.AgentPendingApprovals = async () => [{ id: 'narrow-approval', chatId: chat.id, toolUseId: 'pending-write', tool: 'save_request', kind: 'write', reason: 'Add tests to the selected request.', arguments: '{}', changes: [{ path: 'workspaces/Shop/collections/A-very-long-collection-name/requests/A-very-long-request-name.yml', before: 'name: Orders\n', after: 'name: Orders\ntestScriptJs: ' + 'x'.repeat(200) + '\n' }] }];
      }, { driver, modelName });
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.goto('/');
      await page.getByRole('button', { name: 'Agent', exact: true }).click();
      const workspace = page.locator('.agent-workspace');
      const main = workspace.locator('.agent-main');
      const composer = page.getByRole('textbox', { name: 'Message the agent' });
      const assertFits = async (scope: Locator, selectors: string) => {
        await expect.poll(() => scope.evaluate((element, selectors) => {
          const bounds = element.getBoundingClientRect();
          return [...element.querySelectorAll<HTMLElement>(selectors)].filter(item => {
            const rect = item.getBoundingClientRect();
            return rect.width > 0 && rect.height > 0 && (rect.left < bounds.left - 1 || rect.right > bounds.right + 1 || rect.bottom > window.innerHeight + 1);
          }).map(item => item.getAttribute('aria-label') || item.className);
        }, selectors)).toEqual([]);
      };
      await main.getByRole('button', { name: /^Collection:/ }).click();
      await page.getByRole('option', { name: collectionName, exact: true }).click();
      await main.getByRole('button', { name: /^Environment:/ }).click();
      await page.getByRole('option', { name: environmentName, exact: true }).click();
      for (const size of [{ width: 1120, height: 640 }, { width: 900, height: 540 }, { width: 760, height: 480 }, { width: 640, height: 420 }]) {
        await page.setViewportSize(size);
        await assertFits(main, '.agent-composer-box, .agent-composer-bar button, .agent-composer-bar .agent-picker-trigger');
        const compactChip = main.locator('.agent-composer-chip.compact').first();
        if (await compactChip.count()) {
          await compactChip.hover();
          await expect(compactChip.locator('.agent-composer-chip-icon')).toBeVisible();
          expect(await compactChip.evaluate(chip => getComputedStyle(chip.querySelector('.agent-composer-chip-icon')!).zIndex)).toBe('1');
          await compactChip.screenshot({ path: join(tmpdir(), `kurlo-chip-hover-${driver || 'kurlo'}-${size.width}.png`) });
        }
        const actionOverlap = await main.locator('.agent-composer-actions').evaluate(element => {
          const buttons = [...element.querySelectorAll<HTMLButtonElement>('.agent-picker-trigger, .agent-effort .app-select-trigger, .agent-send')].map(button => button.getBoundingClientRect());
          return buttons.slice(1).some((button, index) => button.left < buttons[index].right - 1);
        });
        expect(actionOverlap).toBe(false);
        const barOverlap = await main.locator('.agent-composer-bar').evaluate(bar => {
          const left = [...bar.querySelectorAll<HTMLElement>('.agent-composer-context > *')].map(item => item.getBoundingClientRect()).filter(rect => rect.width > 0);
          const right = [...bar.querySelectorAll<HTMLElement>('.agent-composer-actions > *')].map(item => item.getBoundingClientRect()).filter(rect => rect.width > 0);
          return left.some(a => right.some(b => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1));
        });
        expect(barOverlap).toBe(false);
        const squeezed = await main.locator('.agent-composer-chip').evaluateAll(chips => chips.filter(chip => {
          if (chip.classList.contains('compact')) return chip.querySelector('.agent-composer-chip-icon')!.getBoundingClientRect().width === 0;
          const label = chip.querySelector<HTMLElement>('.app-select-trigger > span')!;
          return chip.getBoundingClientRect().width < Number.parseFloat(getComputedStyle(chip).maxWidth) - 1 && label.scrollWidth > label.clientWidth + 1;
        }).length);
        expect(squeezed).toBe(0);
        const overflow = await main.evaluate(element => element.scrollWidth - element.clientWidth);
        expect(overflow).toBeLessThanOrEqual(1);
        expect(await workspace.locator('.agent-chat').evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(1);
        await main.getByRole('button', { name: /^Agent:/ }).click();
        const picker = page.getByRole('dialog', { name: 'Choose agent and model' });
        await assertFits(main, '.agent-picker-panel');
        expect((await picker.boundingBox())!.y).toBeGreaterThanOrEqual((await workspace.boundingBox())!.y - 1);
        await page.keyboard.press('Escape');
        await main.getByRole('button', { name: 'Templates', exact: true }).click();
        await assertFits(main, '.agent-templates-menu');
        await page.getByRole('menu', { name: 'Templates' }).getByRole('menuitem').first().click();
        await expect(composer).not.toHaveValue('');
        await composer.fill('');
        await page.screenshot({ path: join(tmpdir(), `kurlo-narrow-${driver || 'kurlo'}-${size.width}-${testInfo.project.name}.png`), animations: 'disabled' });
      }
      await page.setViewportSize({ width: 900, height: 540 });
      await page.locator('.agent-chat-main').click();
      await expect(page.locator('.agent-approval')).toBeVisible();
      expect((await page.locator('.agent-approval').boundingBox())!.height).toBeGreaterThan(120);
      await page.locator('.agent-approval').getByRole('button', { name: 'Reject', exact: true }).scrollIntoViewIfNeeded();
      await assertFits(workspace, '.agent-header input, .agent-header button, .agent-composer-box, .agent-approval button');
      await page.setViewportSize({ width: 1440, height: 900 });
      await page.getByRole('button', { name: 'Toggle chat details' }).click();
      const details = page.getByRole('complementary', { name: 'Chat details', exact: true });
      await expect(details).toBeVisible();
      expect(await page.getByRole('dialog').count()).toBe(0);
      const docked = await workspace.evaluate(element => {
        const main = element.querySelector('.agent-main')!.getBoundingClientRect();
        const panel = element.querySelector('.agent-context-panel')!.getBoundingClientRect();
        return { sideBySide: main.right <= panel.left + 1, mainWidth: main.width };
      });
      expect(docked.sideBySide).toBe(true);
      expect(docked.mainWidth).toBeGreaterThan(400);
      await page.screenshot({ path: join(tmpdir(), `kurlo-docked-details-${driver || 'kurlo'}-${testInfo.project.name}.png`), animations: 'disabled' });
      await page.setViewportSize({ width: 900, height: 540 });
      await expect(main).toBeHidden();
      await expect(details).toBeVisible();
      await expect(page.locator('.agent-details-scrim')).toHaveCount(0);
      await page.getByRole('button', { name: 'Toggle chat details' }).click();
      await page.getByRole('button', { name: 'Toggle chat details' }).click();
      await expect(details.getByRole('button', { name: 'Close chat details' })).toBeFocused();
      await page.screenshot({ path: join(tmpdir(), `kurlo-narrow-details-${driver || 'kurlo'}-${testInfo.project.name}.png`), animations: 'disabled' });
      await page.keyboard.press('Escape');
      await expect(details).toHaveCount(0);
      await expect(page.getByRole('button', { name: 'Toggle chat details' })).toBeFocused();
      await page.getByRole('button', { name: 'Toggle chat details' }).click();
      await page.setViewportSize({ width: 1600, height: 900 });
      await expect(page.getByRole('complementary', { name: 'Chat details' })).toBeVisible();
      await expect(page.locator('.agent-details-scrim')).toHaveCount(0);
      await assertFits(main, '.agent-composer-box, .agent-composer-bar button');
      await page.getByRole('button', { name: 'Close chat details' }).click();
      await page.setViewportSize({ width: 1120, height: 620 });
      await page.evaluate(() => { document.documentElement.style.fontSize = '20px'; });
      await composer.fill('A long prompt that wraps. '.repeat(100));
      await assertFits(main, '.agent-composer-box, .agent-composer-bar button');
      await expect(composer).toHaveCSS('overflow-y', 'auto');
      await page.screenshot({ path: join(tmpdir(), `kurlo-narrow-zoom-${driver || 'kurlo'}-${testInfo.project.name}.png`), animations: 'disabled' });
    });
  }

  test('runs turns in two chats at once and keeps each chat its own controls', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.addInitScript(() => {
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const e2e = window.__kurloE2E as unknown as Record<string, unknown> & { emit: (name: string, payload: unknown) => void };
      const chats: Array<Record<string, unknown>> = [];
      const releases: Record<string, () => void> = {};
      const sent: unknown[] = [];
      e2e.parallelSent = sent;
      e2e.release = (id: string) => releases[id]?.();
      const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
      app.AgentChats = async () => chats.map(chat => ({ id: chat.id, title: chat.title, workspaceId: chat.workspaceId, createdAt: chat.createdAt, updatedAt: chat.updatedAt }));
      app.AgentChat = async (id: string) => structuredClone(chats.find(chat => chat.id === id));
      app.AgentChatPage = async (id: string) => structuredClone(chats.find(chat => chat.id === id));
      app.SendAgentMessage = async (input: Record<string, unknown>) => {
        sent.push(structuredClone(input));
        const id = (input.chatId as string) || `chat-${chats.length + 1}`;
        const now = Date.now();
        let chat = chats.find(item => item.id === id);
        if (!chat) {
          chat = { id, workspaceId: input.workspaceId, title: input.text, createdAt: now, updatedAt: now, collection: '', environment: '', connectionId: 'c1', model: '', messages: [], usage, allowedTools: [] };
          chats.push(chat);
        }
        e2e.emit('ai:deltas', { sessionId: id, turnId: input.turnId, deltas: [{ sessionId: id, step: 0, index: 0, type: 'text', text: `Working on ${input.text}` }] });
        await new Promise<void>(resolve => { releases[id] = resolve; });
        const messages = [{ role: 'user', blocks: [{ type: 'text', text: input.text }] }, { role: 'assistant', blocks: [{ type: 'text', text: `Done: ${input.text}` }] }];
        (chat.messages as unknown[]).push(...messages);
        chat.updatedAt = Date.now();
        return { chat: structuredClone(chat), messages, steps: [], text: `Done: ${input.text}`, usage, hasUsage: true, warnings: [] };
      };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message the agent' });
    await composer.fill('first task');
    await composer.press('Enter');
    await expect(page.getByText('Working on first task')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop the agent' })).toBeVisible();
    await page.locator('.agent-sidebar').getByRole('button', { name: /New/ }).first().click();
    await expect(page.getByRole('button', { name: 'Stop the agent' })).toHaveCount(0);
    await composer.fill('second task');
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toBeEnabled();
    await composer.press('Enter');
    await expect(page.getByText('Working on second task')).toBeVisible();
    await expect(page.locator('.agent-chat-live')).toHaveCount(2);
    await page.evaluate(() => (window.__kurloE2E as unknown as { release: (id: string) => void }).release('chat-1'));
    await expect(page.locator('.agent-chat-live')).toHaveCount(1);
    await expect(page.getByText('Working on second task')).toBeVisible();
    await page.evaluate(() => (window.__kurloE2E as unknown as { release: (id: string) => void }).release('chat-2'));
    await expect(page.getByText('Done: second task')).toBeVisible();
    await page.locator('.agent-sidebar').getByRole('button', { name: /first task/ }).click();
    await expect(page.getByText('Done: first task')).toBeVisible();
    expect(await page.evaluate(() => ((window.__kurloE2E as unknown as { parallelSent: unknown[] }).parallelSent).length)).toBe(2);
  });

  test('edits an earlier message and branches a chat from it', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.addInitScript(() => {
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const e2e = window.__kurloE2E as unknown as Record<string, unknown>;
      const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
      const base = { workspaceId: 'workspace-e2e', createdAt: Date.now(), updatedAt: Date.now(), collection: '', environment: '', connectionId: 'c1', model: '', usage, allowedTools: [] };
      const chats: Array<Record<string, unknown>> = [{ ...base, id: 'chat-edit', title: 'Two questions', messages: [
        { role: 'user', blocks: [{ type: 'text', text: 'first question' }] },
        { role: 'assistant', blocks: [{ type: 'text', text: 'first answer' }] },
        { role: 'user', blocks: [{ type: 'text', text: 'second question' }] },
        { role: 'assistant', blocks: [{ type: 'text', text: 'second answer' }] },
      ] }];
      const sent: Array<Record<string, unknown>> = [];
      e2e.editSent = sent;
      app.AgentChats = async () => chats.map(chat => ({ id: chat.id, title: chat.title, workspaceId: chat.workspaceId, createdAt: chat.createdAt, updatedAt: chat.updatedAt }));
      app.AgentChat = async (id: string) => structuredClone(chats.find(chat => chat.id === id));
      app.AgentChatPage = async (id: string) => structuredClone(chats.find(chat => chat.id === id));
      app.BranchAgentChat = async (id: string, _workspaceId: string, before: number) => {
        const source = chats.find(chat => chat.id === id)!;
        const branch = { ...structuredClone(source), id: 'chat-branch', title: `${source.title} (branch)`, messages: structuredClone((source.messages as unknown[]).slice(0, before)) };
        chats.push(branch);
        e2e.branched = { id, before };
        return structuredClone(branch);
      };
      app.SendAgentMessage = async (input: Record<string, unknown>) => {
        sent.push(structuredClone(input));
        const chat = chats.find(item => item.id === input.chatId)!;
        const messages = chat.messages as unknown[];
        if (typeof input.editFrom === 'number') messages.splice(input.editFrom);
        const added = [{ role: 'user', blocks: [{ type: 'text', text: input.text }] }, { role: 'assistant', blocks: [{ type: 'text', text: `answer to ${input.text}` }] }];
        messages.push(...added);
        return { chat: structuredClone(chat), messages: added, steps: [], text: `answer to ${input.text}`, usage, hasUsage: true, warnings: [] };
      };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.locator('.agent-sidebar').getByRole('button', { name: /Two questions/ }).click();
    await expect(page.getByText('second answer')).toBeVisible();
    const second = page.locator('.agent-user-row').filter({ hasText: 'second question' });
    await second.hover();
    await second.getByRole('button', { name: 'Edit message' }).click();
    const composer = page.getByRole('textbox', { name: 'Message the agent' });
    await expect(composer).toHaveValue('second question');
    await expect(page.locator('.agent-edit-note')).toContainText('Sending replaces it');
    await composer.fill('second question, sharper');
    await composer.press('Enter');
    await expect(page.getByText('answer to second question, sharper')).toBeVisible();
    await expect(page.getByText('second answer')).toHaveCount(0);
    await expect(page.locator('.agent-edit-note')).toHaveCount(0);
    const edit = await page.evaluate(() => ((window.__kurloE2E as unknown as { editSent: Array<Record<string, unknown>> }).editSent)[0]);
    expect(edit.editFrom).toBe(2);
    expect(edit.chatId).toBe('chat-edit');

    const first = page.locator('.agent-user-row').filter({ hasText: 'first question' });
    await first.hover();
    await first.getByRole('button', { name: 'Branch from here' }).click();
    await expect(composer).toHaveValue('first question');
    await expect(page.locator('.agent-sidebar')).toContainText('Two questions (branch)');
    expect(await page.evaluate(() => (window.__kurloE2E as unknown as { branched: unknown }).branched)).toEqual({ id: 'chat-edit', before: 0 });
    await expect(page.getByText('first answer')).toHaveCount(0);
  });

  test('compacts a long chat from Chat details', async ({ page }, testInfo) => {
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.addInitScript(() => {
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const e2e = window.__kurloE2E as unknown as Record<string, unknown>;
      const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
      const chat: Record<string, unknown> = { workspaceId: 'workspace-e2e', createdAt: Date.now(), updatedAt: Date.now(), collection: '', environment: '', connectionId: 'c1', model: '', usage, allowedTools: [], id: 'chat-long', title: 'Orders API', messages: [
        { role: 'user', blocks: [{ type: 'text', text: 'Create a request that lists orders' }] },
        { role: 'assistant', blocks: [{ type: 'text', text: 'Saved List orders in Shop.' }] },
        { role: 'user', blocks: [{ type: 'text', text: 'Add a status test' }] },
        { role: 'assistant', blocks: [{ type: 'text', text: 'Added a test for status 200.' }] },
      ] };
      app.AgentChats = async () => [{ id: chat.id, title: chat.title, workspaceId: chat.workspaceId, createdAt: chat.createdAt, updatedAt: chat.updatedAt }];
      app.AgentChat = async () => structuredClone(chat);
      app.AgentChatPage = async () => structuredClone(chat);
      app.CompactAgentChat = async (id: string, workspaceId: string) => {
        e2e.compacted = { id, workspaceId };
        Object.assign(chat, { summary: 'The user asked for a List orders request in Shop and a status test; both are saved.', summaryBefore: 4, contextTokens: 40, contextWindow: 200000 });
        return structuredClone(chat);
      };
      app.SendAgentMessage = async (input: Record<string, unknown>) => {
        const added = [{ role: 'user', blocks: [{ type: 'text', text: input.text }] }, { role: 'assistant', blocks: [{ type: 'text', text: 'Renamed it.' }] }];
        (chat.messages as unknown[]).push(...added);
        return { chat: structuredClone(chat), messages: added, steps: [], text: 'Renamed it.', usage, hasUsage: true, warnings: [] };
      };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.locator('.agent-sidebar').getByRole('button', { name: /Orders API/ }).click();
    await expect(page.getByText('Added a test for status 200.')).toBeVisible();
    if (!(await page.getByRole('complementary', { name: 'Chat details' }).isVisible())) await page.getByRole('button', { name: 'Toggle chat details' }).click();
    const history = page.getByRole('region', { name: 'History' });
    await expect(history.getByRole('button', { name: /^History/ })).toContainText('4 messages');
    if ((await history.getByRole('button', { name: /^History/ }).getAttribute('aria-expanded')) !== 'true') await history.getByRole('button', { name: /^History/ }).click();
    await history.getByRole('button', { name: 'Compact chat' }).click();
    await expect(history.getByRole('button', { name: /^History/ })).toContainText('4 compacted');
    expect(await page.evaluate(() => (window.__kurloE2E as unknown as { compacted: unknown }).compacted)).toEqual({ id: 'chat-long', workspaceId: 'workspace-e2e' });
    await expect(page.locator('.agent-compact-divider')).toBeVisible();
    await expect(history.getByRole('button', { name: 'Compact chat' })).toBeDisabled();
    await history.getByRole('button', { name: 'Show summary' }).click();
    await expect(history.getByRole('region', { name: 'Chat summary' })).toContainText('List orders request in Shop');
    await page.screenshot({ path: join(tmpdir(), `kurlo-agent-compact-${testInfo.project.name}.png`), animations: 'disabled' });

    const composer = page.getByRole('textbox', { name: 'Message the agent' });
    await composer.fill('Rename it to All orders');
    await composer.press('Enter');
    await expect(page.getByText('Renamed it.')).toBeVisible();
    await expect(page.locator('.agent-compact-divider')).toHaveCount(1);
    await expect(page.locator('.agent-turn').filter({ hasText: 'Rename it to All orders' }).locator('.agent-compact-divider')).toHaveCount(1);
  });

  test('scrolls the chat right up to the composer box', async ({ page }, testInfo) => {
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.addInitScript(() => {
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const usage = { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
      const messages = Array.from({ length: 24 }, (_, index) => ({
        role: index % 2 ? 'assistant' : 'user',
        blocks: [{ type: 'text', text: index % 2 ? `Answer ${index}: saved the request and ran it.` : `Question ${index}: add a test for status 200` }],
      }));
      const chat = { workspaceId: 'workspace-e2e', createdAt: Date.now(), updatedAt: Date.now(), collection: '', environment: '', connectionId: 'c1', model: '', usage, allowedTools: [], id: 'chat-scroll', title: 'Scroll chat', messages };
      app.AgentChats = async () => [{ id: chat.id, title: chat.title, workspaceId: chat.workspaceId, createdAt: chat.createdAt, updatedAt: chat.updatedAt }];
      app.AgentChat = async () => structuredClone(chat);
      app.AgentChatPage = async () => structuredClone(chat);
    });
    await page.setViewportSize({ width: 1280, height: 720 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await page.locator('.agent-sidebar').getByRole('button', { name: /Scroll chat/ }).click();
    await expect(page.getByText('Answer 23: saved the request and ran it.')).toBeVisible();
    const chat = page.locator('.agent-main .agent-chat');
    await chat.evaluate(element => { element.scrollTop = element.scrollHeight; });
    const atEnd = await chat.evaluate(element => {
      const main = element.closest('.agent-main')!;
      const chat = element.getBoundingClientRect();
      const box = main.querySelector('.agent-composer-box')!.getBoundingClientRect();
      const turns = [...element.querySelectorAll('.agent-turn')];
      const last = turns[turns.length - 1].getBoundingClientRect();
      return { chatBottom: chat.bottom, boxTop: box.top, lastBottom: last.bottom };
    });
    expect(atEnd.chatBottom).toBeGreaterThanOrEqual(atEnd.boxTop - 1);
    expect(atEnd.lastBottom).toBeLessThanOrEqual(atEnd.boxTop - 8);
    await chat.evaluate(element => { element.scrollTop = element.scrollHeight - element.clientHeight - 105; });
    await page.screenshot({ path: join(tmpdir(), `kurlo-agent-composer-edge-${testInfo.project.name}.png`), animations: 'disabled' });
  });

  test('keeps the approval mode clear of the composer buttons at every width', async ({ page }, testInfo) => {
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [{ ...connection, model: 'deepseek-v4-pro' }]);
    await page.addInitScript(() => {
      (window.__kurloE2E as unknown as { gitStatusOverride: Record<string, unknown> }).gitStatusOverride = { isRepo: true, workspaceRoot: '/e2e', root: '/e2e', branch: 'main2', clean: true, files: [], remotes: [], stashes: [] };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const main = page.locator('.agent-main');
    await expect(main.getByRole('button', { name: 'Agent branch' })).toBeVisible();
    for (let width = 640; width <= 1400; width += 40) {
      await page.setViewportSize({ width, height: 700 });
      await expect.poll(() => main.locator('.agent-composer-bar').evaluate(bar => {
        const boxes = (selector: string) => [...bar.querySelectorAll<HTMLElement>(selector)].map(item => item.getBoundingClientRect()).filter(rect => rect.width > 0);
        const left = boxes('.agent-composer-context > *');
        const right = boxes('.agent-composer-actions > *');
        const overlap = left.some(a => right.some(b => a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1));
        const actions = bar.querySelector('.agent-composer-actions')!.getBoundingClientRect();
        const clipped = right.some(rect => rect.left < actions.left - 1 || rect.right > actions.right + 1);
        const rows = new Set([...left, ...right].map(rect => Math.round(rect.top + rect.height / 2))).size;
        return { overlap, clipped, rows: window.innerWidth >= 760 ? rows : 1 };
      }), { message: `width ${width}`, timeout: 3000 }).toEqual({ overlap: false, clipped: false, rows: 1 });
      if (width === 840 || width === 760) await page.locator('.agent-composer').screenshot({ path: join(tmpdir(), `kurlo-composer-${width}-${testInfo.project.name}.png`) });
    }
    await page.setViewportSize({ width: 1280, height: 700 });
    await expect(main.locator('.agent-composer-chip.compact')).toHaveCount(0);
    await expect(main.getByRole('button', { name: /^Collection:/ })).toContainText('Any collection');
    await expect(main.getByRole('button', { name: /^Approvals:/ })).toContainText('Ask for changes');
    await page.setViewportSize({ width: 900, height: 700 });
    await page.locator('.agent-composer').screenshot({ path: join(tmpdir(), `kurlo-composer-mode-${testInfo.project.name}.png`) });
  });

  test('slides chat details without squeezing content in docked and narrow layouts', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const input = page.getByRole('textbox', { name: 'Message the agent' });
    await input.fill('Keep this draft while the details panel moves');
    const toggle = page.getByRole('button', { name: 'Toggle chat details' });
    const panel = page.locator('.agent-details-shell');
    const selectors = { toggle: '[aria-label="Toggle chat details"]', panel: '.agent-details-shell', content: '.agent-context-panel', main: '.agent-main-slot' };
    expectPanelSlide(await samplePanelSlide(page, selectors), true);
    await page.screenshot({ path: join(tmpdir(), `kurlo-details-slide-open-${testInfo.project.name}.png`), animations: 'disabled' });
    expectPanelSlide(await samplePanelSlide(page, selectors), false);
    await expect(panel).toBeHidden();
    await expect(panel).toHaveAttribute('inert');
    await toggle.click();
    await toggle.click();
    await toggle.click();
    await expect(page.getByRole('complementary', { name: 'Chat details' })).toBeVisible();
    await expect.poll(() => page.locator('.agent-body').evaluate(node => node.getAnimations().length)).toBe(0);
    await page.getByRole('button', { name: 'Close chat details' }).click();
    await expect(panel).toBeHidden();
    await expect(input).toHaveValue('Keep this draft while the details panel moves');
    await page.setViewportSize({ width: 900, height: 650 });
    await expect(page.locator('.agent-body')).toHaveClass(/details-cover/);
    expectPanelSlide(await samplePanelSlide(page, selectors), true);
    await expect(page.locator('.agent-main-slot')).toBeHidden();
    await expect(page.getByRole('button', { name: 'Close chat details' })).toBeFocused();
    await page.screenshot({ path: join(tmpdir(), `kurlo-details-slide-narrow-${testInfo.project.name}.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(panel).toBeHidden();
    await expect(toggle).toBeFocused();
    await expect(input).toHaveValue('Keep this draft while the details panel moves');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(page.locator('.agent-body')).toHaveCSS('transition-duration', '0s');
    await toggle.click();
    expect(await page.locator('.agent-body').evaluate(node => node.getAnimations().length)).toBe(0);
    await page.getByRole('button', { name: 'Close chat details' }).click();
    await expect(panel).toBeHidden();
  });

  test('keeps the chat beside docked chat details when the sidebar is widened', async ({ page }, testInfo) => {
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.addInitScript(() => localStorage.setItem('kurlo.agentDetails.v1', '1'));
    await page.setViewportSize({ width: 1120, height: 700 });
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const details = page.getByRole('complementary', { name: 'Chat details', exact: true });
    if (!(await details.isVisible())) await page.getByRole('button', { name: 'Toggle chat details' }).click();
    await expect(details).toBeVisible();
    const divider = page.getByRole('button', { name: 'Resize sidebar' });
    const box = (await divider.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 200);
    await page.mouse.down();
    await page.mouse.move(box.x + 400, box.y + 200, { steps: 8 });
    await page.mouse.up();
    await divider.focus();
    await page.keyboard.press('ArrowRight');
    const main = page.locator('.agent-main');
    await expect(main).toBeVisible();
    const layout = await page.locator('.agent-workspace').evaluate(element => {
      const main = element.querySelector('.agent-main')!.getBoundingClientRect();
      const panel = element.querySelector('.agent-context-panel')!.getBoundingClientRect();
      return { sideBySide: main.right <= panel.left + 1, mainWidth: main.width, panelRight: panel.right };
    });
    expect(layout.sideBySide).toBe(true);
    expect(layout.mainWidth).toBeGreaterThan(400);
    expect(layout.panelRight).toBeLessThanOrEqual(1121);
    await page.screenshot({ path: join(tmpdir(), `kurlo-agent-docked-sidebar-${testInfo.project.name}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Close chat details' }).click();
    const moved = (await divider.boundingBox())!;
    await page.mouse.move(moved.x + moved.width / 2, moved.y + 200);
    await page.mouse.down();
    await page.mouse.move(moved.x + 300, moved.y + 200, { steps: 8 });
    await page.mouse.up();
    expect((await page.locator('.sidebar').first().boundingBox())!.width).toBeGreaterThan(420);
  });

  for (const driver of ['', 'codex']) {
    test(`scopes ${driver || 'Kurlo'} chats, drafts and late replies to the selected workspace`, async ({ page }) => {
      await installKurloBridge(page, '', 'browser/e2e', false, {
        ...agentStore,
        workspaces: [{ id: 'workspace-e2e', name: 'Shop workspace' }, { id: 'workspace-other', name: 'Other workspace' }],
        collections: [...agentStore.collections, { id: 'col-other', workspaceId: 'workspace-other', name: 'Other API' }],
      });
      await installAgentBridge(page, driver ? [] : [connection]);
      await page.addInitScript(driver => {
        const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
        const e2e = window.__kurloE2E as unknown as Record<string, unknown> & { emit: (name: string, payload: unknown) => void };
        const usage = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
        const chats = [
          { id: 'chat-shop', title: 'Shop chat', workspaceId: 'workspace-e2e' },
          { id: 'chat-other', title: 'Other chat', workspaceId: 'workspace-other' },
        ].map(chat => ({ ...chat, driver, workspace: '/e2e', createdAt: Date.now(), updatedAt: Date.now(), collection: '', environment: '', connectionId: 'c1', model: 'test-model', messages: [{ role: 'assistant', blocks: [{ type: 'text', text: `${chat.title} answer` }] }], usage, allowedTools: [] }));
        if (driver) app.CodexStatus = async () => ({ installed: true, connected: true, authenticated: true, path: '/test/codex', account: 'Test account', model: 'test-model', models: [{ id: 'test-model', name: 'Test model', recommended: true, weakTools: false }] });
        app.AgentChats = async (workspaceId: string) => {
          const result = structuredClone(chats.filter(chat => chat.workspaceId === workspaceId));
          if (e2e.delayChatList && workspaceId === 'workspace-e2e') {
            e2e.delayChatList = false;
            await new Promise<void>(resolve => { e2e.releaseChatList = resolve; });
          }
          return result;
        };
        app.AgentChat = async (id: string) => {
          const result = structuredClone(chats.find(chat => chat.id === id));
          if (e2e.delayChatLoad && id === 'chat-shop') {
            e2e.delayChatLoad = false;
            await new Promise<void>(resolve => { e2e.releaseChatLoad = resolve; });
          }
          return result;
        };
        app.SendAgentMessage = async (input: Record<string, string>) => {
          e2e.scopedSend = input;
          await new Promise<void>(resolve => { e2e.finishScopedTurn = resolve; });
          const messages = [{ role: 'user', blocks: [{ type: 'text', text: input.text }] }, { role: 'assistant', blocks: [{ type: 'text', text: 'Finished in Shop' }] }];
          const chat = { ...chats[0], id: 'chat-new-shop', title: 'New in Shop', workspaceId: input.workspaceId, messages };
          chats.push(chat);
          e2e.emit('ai:deltas', { sessionId: chat.id, turnId: input.turnId, deltas: [{ step: 0, index: 0, type: 'text', text: 'Finished in Shop' }] });
          return { chat, messages, steps: [], text: 'Finished in Shop', usage, hasUsage: true, warnings: [] };
        };
      }, driver);
      await page.goto('/');
      await page.getByRole('button', { name: 'Agent', exact: true }).click();
      const sidebar = page.locator('.agent-sidebar');
      const composer = page.getByRole('textbox', { name: 'Message the agent' });
      const switchWorkspace = async (name: string) => {
        await page.getByRole('button', { name: 'Workspace switcher' }).click();
        await page.locator('.workspace-menu-select').filter({ hasText: name }).click();
        await page.getByRole('button', { name: 'Agent', exact: true }).click();
      };
      await expect(sidebar.locator('.agent-chat-title')).toHaveText(['Shop chat']);
      await page.evaluate(() => { (window.__kurloE2E as unknown as Record<string, unknown>).delayChatLoad = true; });
      await sidebar.getByRole('button', { name: /Shop chat/ }).click();
      await expect.poll(() => page.evaluate(() => typeof (window.__kurloE2E as unknown as Record<string, unknown>).releaseChatLoad)).toBe('function');
      await composer.fill('Shop draft');
      await page.evaluate(() => { (window.__kurloE2E as unknown as Record<string, unknown>).delayChatList = true; });
      await page.locator('.status-search-btn').click();
      await page.getByRole('combobox', { name: 'Search requests, chats and commands' }).fill('chat');
      await expect(page.locator('[data-chat-id]')).toHaveAttribute('data-chat-id', 'chat-shop');
      await page.keyboard.press('Escape');
      await switchWorkspace('Other workspace');
      await expect(sidebar.locator('.agent-chat-title')).toHaveText(['Other chat']);
      await expect(composer).toHaveValue('');
      await page.evaluate(() => ((window.__kurloE2E as unknown as Record<string, unknown>).releaseChatList as () => void)());
      await page.evaluate(() => ((window.__kurloE2E as unknown as Record<string, unknown>).releaseChatLoad as () => void)());
      await expect(sidebar.locator('.agent-chat-title')).toHaveText(['Other chat']);
      await expect(page.locator('.agent-text')).toHaveCount(0);
      await sidebar.getByRole('button', { name: /Other chat/ }).click();
      await expect(page.locator('.agent-text')).toContainText('Other chat answer');
      await composer.fill('Other draft');
      await page.locator('.status-search-btn').click();
      const search = page.getByRole('combobox', { name: 'Search requests, chats and commands' });
      await search.fill('Shop');
      await expect(page.locator('[data-chat-id]')).toHaveCount(0);
      await search.fill('Other chat');
      await expect(page.locator('[data-chat-id]')).toHaveAttribute('data-chat-id', 'chat-other');
      await search.press('Enter');
      await expect(composer).toHaveValue('Other draft');
      await switchWorkspace('Shop workspace');
      await expect(composer).toHaveValue('Shop draft');
      await expect(page.getByRole('textbox', { name: 'Chat name' })).toHaveValue('Shop chat');
      await expect(page.locator('.agent-text')).toContainText('Shop chat answer');
      await sidebar.getByRole('button', { name: 'New chat', exact: true }).click();
      await composer.fill('Work in Shop');
      await composer.press('Enter');
      await expect.poll(() => page.evaluate(() => (window.__kurloE2E as unknown as { scopedSend?: Record<string, string> }).scopedSend?.workspaceId)).toBe('workspace-e2e');
      await switchWorkspace('Other workspace');
      await expect(composer).toHaveValue('Other draft');
      await page.evaluate(() => ((window.__kurloE2E as unknown as Record<string, unknown>).finishScopedTurn as () => void)());
      await expect(page.locator('.agent-text')).toHaveText('Other chat answer');
      await expect(composer).toHaveValue('Other draft');
      await expect(page.getByRole('textbox', { name: 'Chat name' })).toHaveValue('Other chat');
      await expect(sidebar.locator('.agent-chat-title')).toHaveText(['Other chat']);
      await switchWorkspace('Shop workspace');
      await expect(page.getByRole('textbox', { name: 'Chat name' })).toHaveValue('New in Shop');
      await expect(page.locator('.agent-text')).toContainText('Finished in Shop');
      await expect(composer).toHaveValue('');
    });
  }

  test('keeps agent collection and environment choices inside their workspace', async ({ page }, testInfo) => {
    await installKurloBridge(page, '', 'browser/e2e', false, {
      ...agentStore,
      workspaces: [{ id: 'workspace-e2e', name: 'Shop workspace' }, { id: 'workspace-other', name: 'Other workspace' }],
      collections: [...agentStore.collections, { id: 'col-other', workspaceId: 'workspace-other', name: 'Other API' }],
      environments: [...agentStore.environments, { id: 'env-other', workspaceId: 'workspace-other', name: 'Staging', values: [] }],
    });
    await installAgentBridge(page, [connection]);
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const collection = page.getByRole('button', { name: /^Collection:/ });
    const environment = page.locator('.agent-composer').getByRole('button', { name: /^Environment:/ });
    await collection.click();
    await page.getByRole('option', { name: 'Shop API', exact: true }).click();
    await environment.click();
    await page.getByRole('option', { name: 'Local', exact: true }).click();
    await page.getByRole('button', { name: 'Workspace switcher' }).click();
    await page.locator('.workspace-menu-select').filter({ hasText: 'Other workspace' }).click();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(collection).toHaveAccessibleName('Collection: Any collection');
    await expect(environment).toHaveAccessibleName('Environment: No environment');
    await environment.click();
    await expect(page.getByRole('option', { name: 'Local', exact: true })).toHaveCount(0);
    await expect(page.getByRole('option', { name: /No environment/ }).locator('.app-select-check')).toBeHidden();
    await page.getByRole('option', { name: 'Staging', exact: true }).click();
    await collection.click();
    await page.getByRole('option', { name: 'Other API', exact: true }).click();
    await page.screenshot({ path: join(tmpdir(), `kurlo-agent-workspace-${testInfo.project.name}.png`), animations: 'disabled' });
    await page.getByRole('button', { name: 'Workspace switcher' }).click();
    await page.locator('.workspace-menu-select').filter({ hasText: 'Shop workspace' }).click();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(collection).toHaveAccessibleName('Collection: Shop API');
    await expect(environment).toHaveAccessibleName('Environment: Local');
  });

  for (const [runtime, shortcut] of [['darwin/e2e', 'Meta+w'], ['windows/e2e', 'Control+w'], ['linux/e2e', 'Control+w']]) {
    test(`closes the agent tab with ${shortcut} on ${runtime}`, async ({ page }) => {
      await installKurloBridge(page, '', runtime, false, agentStore);
      await installAgentBridge(page, [connection]);
      await page.addInitScript(() => {
        const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
        app.CodexStatus = async () => ({ installed: true, connected: true, authenticated: true, path: '/test/codex', version: 'codex-cli test', account: 'Test account', authType: 'chatgpt', model: 'test-model', models: [{ id: 'test-model', name: 'Test model', recommended: true, weakTools: false }], authUrl: '', waiting: false });
      });
      await page.goto('/');
      for (const mode of ['Kurlo agent', 'Codex']) {
        await page.getByRole('button', { name: 'Agent', exact: true }).click();
        const composer = page.getByRole('textbox', { name: 'Message the agent' });
        if (mode === 'Codex') {
          await page.getByRole('button', { name: /^Agent:/ }).click();
          const pickerPanel = page.getByRole('dialog', { name: 'Choose agent and model' });
          await pickerPanel.getByRole('radio', { name: /^Codex.*Ready$/ }).click();
          await expect(pickerPanel).toBeVisible();
          await expect(pickerPanel.getByRole('radio', { name: /^Codex.*Ready$/ })).toHaveAttribute('aria-checked', 'true');
          await expect(page.getByRole('button', { name: /^Agent:/ })).toHaveAccessibleName(/^Agent: Codex · Test model/);
          await pickerPanel.getByRole('radiogroup', { name: 'Codex model' }).getByRole('radio', { name: /Test model/ }).click();
          await expect(page.getByRole('button', { name: /^Agent:/ })).toHaveAccessibleName(/^Agent: Codex · Test model/);
          await expect(composer).toHaveValue('Draft for Kurlo agent');
        }
        await composer.fill(`Draft for ${mode}`);
        await composer.press(shortcut);
        await expect(page.getByRole('tab', { name: 'Agent', exact: true })).toHaveCount(0);
        await expect(page.locator('.agent-sidebar')).toHaveCount(0);
        await expect(page.getByLabel('Request URL')).toBeVisible();
        await page.getByRole('button', { name: 'Agent', exact: true }).click();
        await expect(page.getByRole('textbox', { name: 'Message the agent' })).toHaveValue(`Draft for ${mode}`);
        await clickTabClose(page.getByRole('button', { name: 'Close agent', exact: true }));
      }
    });
  }

  test('keeps a separate agent draft for each chat across closing the tab and restarting', async ({ page }) => {
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, [connection]);
    await page.addInitScript(() => {
      const app = (window as E2EWindow).go.api.App;
      const send = app.SendAgentMessage;
      app.SendAgentMessage = async (...args) => {
        const result = await send(...args);
        sessionStorage.setItem('e2e-agent-chat', JSON.stringify(result.chat));
        return result;
      };
      const drafts = sessionStorage.getItem('e2e-agent-drafts');
      if (drafts) localStorage.setItem('kurlo.agentDrafts.v1', drafts);
      const saved = sessionStorage.getItem('e2e-agent-chat');
      if (!saved) return;
      const chat = JSON.parse(saved);
      (app as Record<string, unknown>).AgentChats = async () => [{ id: chat.id, title: chat.title, workspaceId: chat.workspaceId, createdAt: chat.createdAt, updatedAt: chat.updatedAt }];
      (app as Record<string, unknown>).AgentChat = async () => structuredClone(chat);
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const composer = page.getByRole('textbox', { name: 'Message the agent' });
    const sidebarChat = page.locator('.agent-sidebar').getByText('Review batch changes').first();
    const restart = async () => {
      await page.evaluate(() => sessionStorage.setItem('e2e-agent-drafts', localStorage.getItem('kurlo.agentDrafts.v1') ?? '{}'));
      await page.reload();
      await page.getByRole('button', { name: 'Agent', exact: true }).click();
    };
    await composer.fill('Review batch changes');
    await composer.press('Enter');
    await composer.fill('Draft typed while the agent works');
    await page.getByRole('group', { name: 'Apply these changes?' }).getByRole('button', { name: 'Apply', exact: true }).click();
    await expect(sidebarChat).toBeVisible();
    await expect(composer).toHaveValue('Draft typed while the agent works');
    await composer.fill('Draft in the first chat');

    await clickTabClose(page.getByRole('button', { name: 'Close agent', exact: true }));
    await expect(composer).toHaveCount(0);
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(composer).toHaveValue('Draft in the first chat');

    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(composer).toHaveValue('');
    await composer.fill('Draft for a new chat');
    await sidebarChat.click();
    await expect(composer).toHaveValue('Draft in the first chat');
    await page.getByRole('button', { name: 'New chat' }).click();
    await expect(composer).toHaveValue('Draft for a new chat');

    await restart();
    await expect(composer).toHaveValue('Draft for a new chat');
    await sidebarChat.click();
    await expect(composer).toHaveValue('Draft in the first chat');
    await composer.fill('');
    await restart();
    await sidebarChat.click();
    await expect(composer).toHaveValue('');
  });

  for (const [runtime, mod] of [['darwin/e2e', 'Meta'], ['windows/e2e', 'Control'], ['linux/e2e', 'Control']]) {
    test(`keeps request shortcuts away from the hidden request in the agent tab on ${runtime}`, async ({ page, browserName }) => {
      await installKurloBridge(page, '', runtime, false, agentStore);
      await installAgentBridge(page, [connection]);
      await page.goto('/');
      await page.getByText('List orders').first().click();
      await expect(page.getByLabel('Request URL')).toBeVisible();
      const workspace = page.locator('.agent-mode-workspace');
      const chatRow = page.locator('.agent-sidebar').getByText('Review batch changes').first();
      const sentRequests = () => page.evaluate(() => window.__kurloE2E.sentRequests.length);

      await page.keyboard.press(`Alt+${mod}+4`);
      await expect(workspace).toBeVisible();
      const composer = page.getByRole('textbox', { name: 'Message the agent' });
      await composer.fill('Review batch changes');
      await composer.press(`${mod}+Enter`);
      await page.getByRole('group', { name: 'Apply these changes?' }).getByRole('button', { name: 'Apply', exact: true }).click();
      await expect(chatRow).toBeVisible();
      await expect.poll(() => page.evaluate(() => ((window.__kurloE2E as unknown as Record<string, unknown[]>).agentSent ?? []).length)).toBe(1);
      expect(await sentRequests()).toBe(0);

      for (const key of ['ArrowDown', 'ArrowUp', 'ArrowRight', 'Alt+ArrowLeft', ...(browserName === 'webkit' ? [] : ['Backspace']), `${mod}+E`, `${mod}+D`, `${mod}+V`, `Shift+${mod}+C`, `Shift+${mod}+F`]) {
        await chatRow.focus();
        await page.keyboard.press(key);
        await expect(workspace, key).toBeVisible();
        await expect(page.getByRole('dialog'), key).toHaveCount(0);
      }
      await composer.fill('Review batch changes');
      await composer.press(`${mod}+Enter`);
      await expect.poll(() => page.evaluate(() => ((window.__kurloE2E as unknown as Record<string, unknown[]>).agentSent ?? []).length)).toBe(2);
      expect(await sentRequests()).toBe(0);
      await page.getByRole('group', { name: 'Apply these changes?' }).getByRole('button', { name: 'Apply', exact: true }).click();

      await chatRow.focus();
      await page.keyboard.press(`${mod}+F`);
      await expect(page.getByRole('textbox', { name: 'Filter chats' })).toBeFocused();

      await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
      await page.keyboard.press(`${mod}+1`);
      await expect(page.getByLabel('Request URL')).toBeVisible();
      await page.getByLabel('Request URL').press(`${mod}+Enter`);
      await expect.poll(sentRequests).toBe(1);
    });
  }

  test('offers four ways to connect a model when there is none', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page, '', 'browser/e2e', false, agentStore);
    await installAgentBridge(page, []);
    await page.goto('/');

    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const onboarding = page.locator('.agent-onboarding');
    await expect(onboarding).toBeVisible();
    await expect(onboarding.locator('.agent-onboarding-card')).toHaveCount(4);
    await expect(page.locator('.agent-chat-new')).toHaveCount(0);
    await expect(page.locator('.agent-sidebar').getByRole('button', { name: 'New chat' })).toBeDisabled();
    await captureDocsScreenshot(page, 'agent-onboarding');
    await onboarding.getByRole('button', { name: /Your API key/ }).click();
    await expect(page.locator('#settings-panel-ai')).toBeVisible();
    await expect(page.locator('#ai-key-value')).toBeFocused();
  });
});

for (const connected of [true, false]) {
  test(`shows the agent welcome before connection checks finish (${connected ? 'API model' : 'no connection'})`, async ({ page }, testInfo) => {
    await installKurloBridge(page);
    await page.addInitScript(connected => {
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const e2e = window.__kurloE2E as unknown as Record<string, unknown>;
      const connections = connected ? [{ id: 'instant-model', kind: 'openai', label: 'My API', baseUrl: 'https://example.test/v1', model: 'test-model', hasKey: true, default: true, provider: 'openai' }] : [];
      app.AiConnections = async () => {
        await new Promise<void>(resolve => { e2e.finishConnectionCheck = resolve; });
        return { connections };
      };
      app.CodexStatus = async () => {
        await new Promise<void>(resolve => { e2e.finishCodexCheck = resolve; });
        return { installed: true, connected: false, authenticated: false, path: '/test/codex', models: [], error: 'account/read: workspace routing discovery failed' };
      };
      app.AgentChats = async () => [];
      app.AgentPendingApprovals = async () => [];
    }, connected);
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'What should we check?' })).toBeVisible();
    await expect(page.locator('.agent-starter')).toHaveCount(4);
    const input = page.getByRole('textbox', { name: 'Message the agent' });
    await input.fill('Draft while connections are checked');
    await expect.poll(() => page.evaluate(() => {
      const e2e = window.__kurloE2E as unknown as Record<string, unknown>;
      return Boolean(e2e.finishConnectionCheck && e2e.finishCodexCheck);
    })).toBe(true);
    if (connected) await page.screenshot({ path: join(tmpdir(), `kurlo-agent-instant-welcome-${testInfo.project.name}.png`), animations: 'disabled' });
    await page.evaluate(() => { (window.__kurloE2E as unknown as { finishConnectionCheck: () => void }).finishConnectionCheck(); });
    await expect(page.getByRole('heading', { name: 'What should we check?' })).toBeVisible();
    await expect(input).toHaveValue('Draft while connections are checked');
    await page.evaluate(() => { (window.__kurloE2E as unknown as { finishCodexCheck: () => void }).finishCodexCheck(); });
    if (connected) {
      await expect(page.getByRole('button', { name: /^Agent:/ })).toHaveAccessibleName('Agent: Kurlo agent · test-model');
      await expect(page.getByRole('heading', { name: 'What should we check?' })).toBeVisible();
      await expect(input).toHaveValue('Draft while connections are checked');
    } else {
      await expect(page.getByRole('heading', { name: 'Connect a model to start' })).toBeVisible();
      await expect(page.locator('.agent-onboarding-card')).toHaveCount(4);
    }
  });
}

for (const driver of ['', 'codex']) {
  test(`stops ${driver || 'API'} before the first chat ID arrives and keeps event subscriptions stable`, async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(driver => {
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const e2e = window.__kurloE2E as unknown as Record<string, unknown> & { emit: (name: string, payload: unknown) => void };
      const connections = [{ id: 'c1', label: 'Test API', kind: 'openai', provider: 'openai', model: 'test-model', hasKey: true, default: true }];
      app.AiConnections = async () => ({ connections: driver ? [] : connections });
      app.CodexStatus = async () => ({ installed: true, connected: driver === 'codex', authenticated: driver === 'codex', path: '/test/codex', models: [{ id: 'test-model', name: 'Test model' }], model: 'test-model' });
      app.AgentChats = async () => [];
      app.AgentPendingApprovals = async () => [];
      let registered = false;
      let release: (() => void) | undefined;
      const stopped: string[] = [];
      e2e.stoppedTurns = stopped;
      app.StopAgentTurn = async (turnId: string) => { stopped.push(turnId); if (registered) release?.(); };
      app.SendAgentMessage = async (input: Record<string, string>) => {
        e2e.lifecycleInput = input;
        await new Promise<void>(resolve => { e2e.registerLifecycleTurn = resolve; });
        registered = true;
        await new Promise<void>(resolve => {
          release = resolve;
          e2e.emit('ai:deltas', { sessionId: 'lifecycle-chat', turnId: input.turnId, deltas: [] });
        });
        return { error: 'Cancelled' };
      };
    }, driver);
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(page.getByRole('button', { name: /^Agent:/ })).toHaveAccessibleName(driver ? 'Agent: Codex · Test model' : 'Agent: Kurlo agent · test-model');
    const counts = () => page.evaluate(() => window.__kurloE2E.calls.filter(call => /^event:(ai:|agent:|codex:)/.test(call)));
    const original = await counts();
    for (let i = 0; i < 12; i++) {
      await page.getByRole('tab', { name: /New Request/ }).last().click();
      await page.getByRole('tab', { name: 'Agent', exact: true }).click();
    }
    expect(await counts()).toEqual(original);
    const composer = page.getByRole('textbox', { name: 'Message the agent' });
    await composer.fill('Stop immediately');
    await composer.press('Enter');
    await expect(page.getByRole('button', { name: 'Stop the agent' })).toBeVisible();
    await page.getByRole('button', { name: 'Stop the agent' }).click();
    await expect.poll(() => page.evaluate(() => (window.__kurloE2E as unknown as { stoppedTurns: string[] }).stoppedTurns.length)).toBe(1);
    await page.evaluate(() => { (window.__kurloE2E as unknown as { registerLifecycleTurn: () => void }).registerLifecycleTurn(); });
    await expect(page.getByRole('button', { name: 'Stop the agent' })).toHaveCount(0);
    const stopped = await page.evaluate(() => (window.__kurloE2E as unknown as { stoppedTurns: string[] }).stoppedTurns);
    expect(stopped).toHaveLength(2);
    expect(stopped[0]).toBe(stopped[1]);
    await page.evaluate(() => {
      const e2e = window.__kurloE2E as unknown as { emit: (name: string, payload: unknown) => void; lifecycleInput: { turnId: string } };
      e2e.emit('agent:approval', { id: 'late', chatId: 'lifecycle-chat', turnId: e2e.lifecycleInput.turnId, tool: 'save_request', kind: 'write', arguments: '{}', reason: '', changes: [] });
      e2e.emit('agent:compaction', { chatId: 'lifecycle-chat', turnId: e2e.lifecycleInput.turnId, active: true });
    });
    await expect(page.locator('.agent-approval')).toHaveCount(0);
    await expect(page.getByText('Compacting context…', { exact: true })).toHaveCount(0);
    await expect(composer).toBeEnabled();
  });
}

test('keeps streaming chat history and restores failed drafts only in their original chat', async ({ page }) => {
  await installKurloBridge(page);
  await page.addInitScript(() => {
    const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
    const e2e = window.__kurloE2E as unknown as Record<string, unknown>;
    const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 };
    const base = { workspaceId: 'workspace-e2e', model: 'test-model', connectionId: 'c1', collection: '', environment: '', createdAt: Date.now(), updatedAt: Date.now(), usage, allowedTools: [] };
    const user = (text: string): { role: string; blocks: Array<Record<string, string>> } => ({ role: 'user', blocks: [{ type: 'text', text }] });
    const thinking = { type: 'thinking', text: 'Working through the request.' };
    const tool = { type: 'tool_use', id: 'tool-1', name: 'list_requests', input: '{"scope":"test"}' };
    const first = { ...base, id: 'first', title: 'First chat', messages: [user('Existing history')] };
    const other = { ...base, id: 'other', title: 'Other chat', messages: [user('Other history')] };
    app.AiConnections = async () => ({ connections: [{ id: 'c1', label: 'Test API', kind: 'openai', provider: 'openai', model: 'test-model', hasKey: true, default: true }] });
    app.AgentChats = async () => [first, other];
    app.AgentChatPage = async (id: string) => structuredClone(id === 'first' ? first : other);
    app.AgentPendingApprovals = async () => [];
    app.SendAgentMessage = async (input: { text: string; turnId: string }) => {
      if (input.text === 'Streaming prompt') {
        const emit = e2e.emit as (name: string, payload: unknown) => void;
        emit('ai:deltas', { sessionId: 'first', turnId: input.turnId, deltas: [{ ...thinking, step: 0, index: 0 }, { ...tool, step: 0, index: 1 }] });
      }
      if (input.text === 'Streaming prompt' || input.text === 'Saved before failure') first.messages.push(user(input.text));
      const outcome = await new Promise<string>(resolve => { e2e.finishAgentSend = resolve; });
      if (outcome === 'reject') throw new Error('The bridge rejected the send.');
      if (outcome === 'saved-error') return { chat: structuredClone(first), error: 'The agent stopped after saving.' };
      if (outcome === 'unsaved') return { chat: structuredClone(first), error: 'The prompt could not be saved.' };
      if (outcome === 'no-chat') return { error: 'The chat could not be created.' };
      first.messages.push({ role: 'assistant', blocks: [thinking, tool] });
      return { chat: structuredClone(first) };
    };
  });
  const finish = (outcome: string) => page.evaluate(value => {
    (window.__kurloE2E as unknown as { finishAgentSend: (result: string) => void }).finishAgentSend(value);
  }, outcome);

  await page.goto('/');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const sidebar = page.locator('.agent-sidebar');
  const composer = page.getByRole('textbox', { name: 'Message the agent' });
  const stop = page.getByRole('button', { name: 'Stop the agent' });
  const first = sidebar.getByRole('button', { name: /First chat/ });
  const other = sidebar.getByRole('button', { name: /Other chat/ });
  await first.click();
  await expect(page.getByText('Existing history', { exact: true })).toBeVisible();
  await composer.fill('Streaming prompt');
  await composer.press('Enter');
  await expect(stop).toBeVisible();
  await other.click();
  await expect(page.getByText('Other history', { exact: true })).toBeVisible();
  await first.click();
  await expect(page.getByText('Existing history', { exact: true })).toBeVisible();
  await expect(page.getByText('Streaming prompt', { exact: true })).toHaveCount(1);
  await expect(page.getByText('Other history', { exact: true })).toHaveCount(0);
  await page.locator('.agent-step-toggle').click();
  await page.locator('.agent-tool-toggle').click();
  await finish('saved');
  await expect(stop).toHaveCount(0);
  await expect(page.locator('.agent-step-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(page.locator('.agent-tool-toggle')).toHaveAttribute('aria-expanded', 'true');

  for (const outcome of ['reject', 'unsaved']) {
    await composer.fill('Retry this prompt');
    await composer.press('Enter');
    await expect(stop).toBeVisible();
    await finish(outcome);
    await expect(composer).toHaveValue('Retry this prompt');
  }

  await composer.fill('Saved before failure');
  await composer.press('Enter');
  await expect(stop).toBeVisible();
  await finish('saved-error');
  await expect(stop).toHaveCount(0);
  await expect(page.getByText('Saved before failure', { exact: true })).toHaveCount(1);
  await expect(composer).toHaveValue('');

  await sidebar.getByRole('button', { name: 'New chat', exact: true }).click();
  await composer.fill('Keep out of other chat');
  await composer.press('Enter');
  await expect(stop).toBeVisible();
  await other.click();
  await expect(page.getByText('Other history', { exact: true })).toBeVisible();
  await finish('no-chat');
  await expect(composer).toBeEnabled();
  await expect(composer).toHaveValue('');
});

test('shows a failed chat deletion in the agent sidebar', async ({ page }) => {
  await installKurloBridge(page);
  await page.addInitScript(() => {
    const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
    const chat = { id: 'locked-chat', workspaceId: 'workspace-e2e', title: 'Locked chat', createdAt: Date.now(), updatedAt: Date.now(), model: 'test-model', connectionId: 'c1', messages: [] };
    app.AiConnections = async () => ({ connections: [{ id: 'c1', label: 'Test API', kind: 'openai', provider: 'openai', model: 'test-model', hasKey: true, default: true }] });
    app.AgentChats = async () => [chat];
    app.AgentChatPage = async () => chat;
    app.AgentPendingApprovals = async () => [];
    app.DeleteAgentChat = async () => ({ ok: false, error: 'Chat storage is read-only.' });
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const sidebar = page.locator('.agent-sidebar');
  const row = sidebar.locator('.agent-chat').filter({ hasText: 'Locked chat' });
  await row.hover();
  const trigger = row.getByRole('button', { name: 'Chat menu' });
  await trigger.press('Enter');
  const menu = row.getByRole('menu');
  await expect(menu.getByRole('menuitem', { name: 'Rename' })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitem', { name: 'Delete' })).toBeFocused();
  await sidebar.screenshot({ path: join(tmpdir(), 'kurlo-agent-sidebar-menu.png'), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.press('Enter');
  await menu.getByRole('menuitem', { name: 'Delete' }).click();
  await expect(sidebar.getByRole('alert')).toHaveText('Chat storage is read-only.');
  await expect(row).toBeVisible();
  await sidebar.screenshot({ path: join(tmpdir(), 'kurlo-agent-delete-error.png'), animations: 'disabled' });
  await row.getByRole('button', { name: /Locked chat/ }).click();
  await expect(page.locator('.agent-header').getByRole('button', { name: 'Chat actions' })).toHaveCount(0);
});

test('restores the selected agent when reopening a workspace', async ({ page }) => {
  await installKurloBridge(page, '', 'browser/e2e', false);
  await page.addInitScript(() => {
    const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
    app.AiConnections = async () => ({ connections: [{ id: 'c1', label: 'Test API', kind: 'openai', provider: 'openai', model: 'test-model', hasKey: true, default: true }] });
    app.CodexStatus = async () => ({ installed: true, connected: true, authenticated: true, path: '/test/codex', model: 'codex-test', models: [{ id: 'codex-test', name: 'Codex test' }] });
    let opens = 0;
    app.OpenWorkspaceRoot = async () => {
      const id = ++opens === 1 ? 'second-workspace' : 'workspace-e2e';
      return {
        ok: true,
        root: '/exports',
        payload: JSON.stringify({ workspaces: [{ id, name: id }], activeWorkspaceId: id }),
      };
    };
  });

  await page.goto('/');
  const agent = page.getByRole('button', { name: 'Agent', exact: true });
  const picker = page.getByRole('button', { name: /^Agent:/ });
  const openWorkspace = async () => {
    await page.getByLabel('Open Git and storage status').click();
    await page.getByRole('button', { name: /Open existing repo/ }).click();
    await expect(page.getByRole('button', { name: /Open existing repo/ })).toBeEnabled();
    await agent.click();
  };
  await agent.click();
  await picker.click();
  await page.getByRole('radio', { name: /^Codex/ }).click();
  await page.getByRole('radio', { name: /^Codex test/ }).click();
  await expect(picker).toHaveAccessibleName('Agent: Codex · Codex test');

  await openWorkspace();
  await picker.click();
  await page.getByRole('radio', { name: /^Test API/ }).click();
  await page.keyboard.press('Escape');
  await expect(picker).toHaveAccessibleName('Agent: Kurlo agent · test-model');

  await openWorkspace();
  await expect(picker).toHaveAccessibleName('Agent: Codex · Codex test');
});
