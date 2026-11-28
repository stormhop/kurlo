import type { E2EWindow } from './support/bridge';
import { reviewShot } from './support/reviewShot';
import { installLongAgentHistory, visibleHistoryAnchor } from './support/agent';

import { installKurloBridge } from './support/bridge';

import { DOCS_VIEWPORT } from './support/config';

import { captureDocsScreenshot } from './support/screenshots';

import { expect, test } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe('Codex agent connection', () => {
  test('connects an existing account and separates Codex chats from the Kurlo agent', async ({ page }, testInfo) => {
    await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const e2e = window.__kurloE2E as unknown as Record<string, unknown> & { emit: (name: string, payload: unknown) => void };
      const usage = { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: 0 };
      const status = { installed: true, connected: false, authenticated: true, path: '/usr/local/bin/codex', version: 'codex-cli 0.166.0', account: 'user@example.test · plus', authType: 'chatgpt', model: 'codex-test', models: [{ id: 'codex-test', name: 'Codex test', recommended: true, weakTools: false, efforts: ['low', 'medium', 'high', 'xhigh'], defaultEffort: 'medium' }, { id: 'small-test', name: 'Small test', recommended: false, weakTools: false, efforts: ['low'], defaultEffort: 'low' }], authUrl: '', waiting: false, rateLimits: [{ limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } }] };
      const chats: Array<Record<string, unknown>> = [{ id: 'api-chat', workspaceId: 'workspace-e2e', title: 'API conversation', driver: '', createdAt: Date.now(), updatedAt: Date.now() }];
      app.CodexStatus = async () => structuredClone(status);
      app.AiConnections = async () => ({ connections: [] });
      app.ConnectCodex = async () => { status.connected = true; return structuredClone(status); };
      app.RemoveCodexConnection = async () => { status.connected = false; status.account = 'refreshed@example.test · plus'; return { ok: true }; };
      app.AgentChats = async (workspaceId: string) => structuredClone(chats.filter(chat => chat.workspaceId === workspaceId));
      app.AgentChat = async (id: string) => structuredClone(chats.find(chat => chat.id === id));
      app.SetAgentChatArchived = async (id: string, workspaceId: string, archived: boolean) => {
        const chat = chats.find(item => item.id === id && item.workspaceId === workspaceId);
        if (!chat) throw new Error('Chat not found');
        chat.archivedAt = archived ? Date.now() : undefined;
        return structuredClone(chat);
      };
      app.AgentPendingApprovals = async () => [];
      app.SendAgentMessage = async (input: Record<string, string>) => {
        e2e.codexSent = input;
        const messages = [{ role: 'user', blocks: [{ type: 'text', text: input.text }] }, { role: 'assistant', blocks: [{ type: 'text', text: 'Codex checked the collection.' }] }];
        const chat = { id: 'codex-chat', workspaceId: input.workspaceId, title: 'Check collection', driver: 'codex', externalThreadId: 'native-thread', collection: input.collection, environment: input.environment, connectionId: '', model: 'codex-test', effort: input.effort, contextTokens: 12000, contextWindow: 128000, messages, usage, allowedTools: [], createdAt: Date.now(), updatedAt: Date.now() };
        chats.push(chat);
        e2e.emit('codex:rateLimits', { limitId: 'codex', limitName: 'Codex', primary: { usedPercent: 30, windowDurationMins: 300, resetsAt: 1800000000 }, secondary: { usedPercent: 40, windowDurationMins: 10080 } });
        e2e.emit('agent:context', { chatId: chat.id, turnId: input.turnId, tokens: 12000, window: 128000 });
        e2e.emit('ai:deltas', { sessionId: chat.id, turnId: input.turnId, deltas: [{ step: 0, index: 0, type: 'text', text: 'Codex checked the collection.' }] });
        return { chat, messages, steps: [], text: 'Codex checked the collection.', usage, hasUsage: true, warnings: [] };
      };
    });
    await page.goto('/');
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    const sidebar = page.locator('.agent-sidebar');
    await expect(sidebar).toContainText('API conversation');
    await page.getByRole('button', { name: /Codex on this computer/ }).click();
    const connection = page.getByRole('region', { name: 'Codex connection' });
    await expect(connection).toContainText('user@example.test');
    await expect(connection.locator('.agent-brand-glyph')).toHaveCount(1);
    await expect(connection).not.toContainText('Cx');
    await reviewShot(page, { path: join(tmpdir(), 'kurlo-codex-connect.png'), animations: 'disabled' });
    await captureDocsScreenshot(page, 'agent-codex-connect');
    await connection.getByRole('button', { name: 'Use this account', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings' }).click();

    const picker = page.getByRole('button', { name: /^Agent:/ });
    const effortPicker = page.getByRole('button', { name: /^Effort:/ });
    await expect(picker).toHaveAccessibleName('Agent: Codex · Codex test');
    await expect(picker.locator('.agent-brand-glyph')).toHaveCount(1);
    await expect(effortPicker).toHaveAccessibleName('Effort: Medium');
    await expect(page.locator('.agent-workspace')).toContainText('What should we check?');
    await expect(page.locator('.agent-starter')).toHaveCount(4);
    await effortPicker.click();
    const efforts = page.getByRole('listbox', { name: 'Effort', exact: true });
    await expect(efforts.getByRole('option')).toHaveText([/Low/, /Medium/, /High/, /Extra high/]);
    await expect(efforts.getByRole('option', { name: /Medium/ })).toHaveAttribute('aria-selected', 'true');
    await efforts.getByRole('option', { name: 'High', exact: true }).click();
    await expect(effortPicker).toHaveAccessibleName('Effort: High');
    await expect(page.getByRole('dialog', { name: 'Choose agent and model' })).toHaveCount(0);
    await reviewShot(page, { path: join(tmpdir(), `kurlo-model-effort-${testInfo.project.name}.png`), animations: 'disabled' });
    await picker.click();
    const agentPanel = page.getByRole('dialog', { name: 'Choose agent and model' });
    await expect(agentPanel).toContainText('Add a model');
    await expect(agentPanel.getByRole('radio', { name: /^Codex.*Ready$/ })).toHaveAttribute('aria-checked', 'true');
    const codexModels = agentPanel.getByRole('radiogroup', { name: 'Codex model' });
    await expect(codexModels.getByRole('radio', { name: /Codex test/ })).toBeFocused();
    const listTop = await codexModels.evaluate(element => element.getBoundingClientRect().top);
    const modelSearch = agentPanel.getByRole('searchbox', { name: 'Search Codex models' });
    await modelSearch.fill('small');
    await expect(codexModels.getByRole('radio')).toHaveCount(1);
    expect(Math.abs(await codexModels.evaluate(element => element.getBoundingClientRect().top) - listTop)).toBeLessThanOrEqual(1);
    await reviewShot(page, { path: join(tmpdir(), 'kurlo-agent-picker.png'), animations: 'disabled' });
    await codexModels.getByRole('radio', { name: /^Small test/ }).click();
    await expect(agentPanel).toHaveCount(0);
    await expect(picker).toHaveAccessibleName('Agent: Codex · Small test');
    await expect(effortPicker).toHaveAccessibleName('Effort: Low');
    await effortPicker.click();
    await expect(efforts.getByRole('option')).toHaveCount(1);
    await page.keyboard.press('Escape');
    await expect(effortPicker).toBeFocused();
    await picker.click();
    await expect(codexModels.getByRole('radio', { name: /^Small test/ })).toBeFocused();
    await page.keyboard.press('ArrowUp');
    await expect(codexModels.getByRole('radio', { name: /^Codex test/ })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(picker).toHaveAccessibleName('Agent: Codex · Codex test');
    await expect(effortPicker).toHaveAccessibleName('Effort: Medium');
    await effortPicker.click();
    await efforts.getByRole('option', { name: 'High', exact: true }).click();

    const input = page.getByRole('textbox', { name: 'Message the agent' });
    await input.fill('Check collection');
    await input.press('Enter');
    await expect(page.locator('.agent-text')).toContainText('Codex checked the collection.');
    await expect(sidebar.getByRole('button', { name: /Codex.*Check collection/ })).toHaveAttribute('aria-current', 'page');
    await expect(sidebar.getByRole('button', { name: /Kurlo agent.*API conversation/ })).toBeVisible();
    expect(await page.evaluate(() => (window.__kurloE2E as unknown as { codexSent: Record<string, string> }).codexSent)).toMatchObject({ driver: 'codex', text: 'Check collection', effort: 'high' });
    await expect(page.locator('.agent-header .agent-usage')).toHaveCount(0);
    await expect(page.locator('.agent-composer .agent-usage')).toContainText('10 in');
    const details = page.getByRole('complementary', { name: 'Chat details' });
    await expect(details).toHaveCount(0);
    await expect(page.locator('.agent-composer .agent-session-status')).not.toContainText('Context');
    await expect(page.locator('.agent-plan-mini')).toHaveText('Plan 60% left');
    const toggle = page.getByRole('button', { name: 'Toggle chat details' });
    await toggle.click();
    await expect(toggle).toHaveAttribute('aria-pressed', 'true');
    await expect(details.locator('.agent-context')).toContainText('9%');
    await expect(details.locator('.agent-context')).toContainText('12.0k / 128k');
    await expect(details.locator('.agent-limits')).toContainText('70% left');
    await expect(details.locator('.agent-limits')).toContainText('60% left');
    await expect(details.locator('.agent-limit-resets').first()).toContainText('resets');
    await details.getByRole('region', { name: 'Context' }).getByRole('button', { name: /^Context/ }).click();
    await expect(details).toContainText('Effort');
    await reviewShot(page, { path: join(tmpdir(), 'kurlo-codex-chat.png'), animations: 'disabled' });
    await captureDocsScreenshot(page, 'agent-codex-chat');
    await toggle.click();
    await expect(details).toHaveCount(0);
    expect(await page.evaluate(() => localStorage.getItem('kurlo.agentDetails.v1'))).toBe('0');
    await page.locator('.agent-plan-mini').click();
    await expect(details).toBeVisible();
    await toggle.click();

    await picker.click();
    await expect(page.getByRole('dialog', { name: 'Choose agent and model' })).toContainText('Start a new chat to switch to another agent.');
    await page.keyboard.press('Escape');
    await sidebar.getByRole('button', { name: 'New chat', exact: true }).click();
    await expect(picker).toHaveAccessibleName('Agent: Codex · Codex test');
    await expect(page.locator('.agent-empty')).toBeVisible();
    await expect(effortPicker).toHaveAccessibleName('Effort: High');
    await page.evaluate(() => {
      const app = (window as E2EWindow).go!.api!.App as Record<string, (...args: unknown[]) => Promise<unknown>>;
      const load = app.AgentChat;
      app.AgentChat = async (...args: unknown[]) => { await new Promise(resolve => setTimeout(resolve, 600)); return load(...args); };
    });
    await sidebar.getByRole('button', { name: /Check collection/ }).click();
    await expect(page.getByRole('textbox', { name: 'Chat name' })).toHaveValue('Check collection');
    expect(await page.locator('.agent-empty').count()).toBe(0);
    expect(await page.locator('.agent-text').count()).toBe(0);
    await expect(page.locator('.agent-text')).toContainText('Codex checked the collection.');
    await expect(picker).toHaveAccessibleName('Agent: Codex · Codex test');

    await picker.click();
    await page.getByRole('button', { name: 'Manage connections', exact: true }).click();
    await connection.getByRole('button', { name: 'Remove connection', exact: true }).click();
    await expect(connection).toContainText('Signed in: refreshed@example.test · plus');
    await expect(connection.getByRole('button', { name: 'Use this account', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(page.locator('.agent-workspace')).toContainText('Connect a model to start');
    const codexRow = sidebar.locator('.agent-chat').filter({ hasText: 'Check collection' });
    await codexRow.getByRole('button', { name: 'Chat menu' }).click({ force: true });
    await codexRow.getByRole('menuitem', { name: 'Archive', exact: true }).click();
    await expect(codexRow).toHaveCount(0);
    await sidebar.getByRole('button', { name: 'Archived', exact: true }).click();
    await codexRow.locator('.agent-chat-main').click();
    await expect(page.locator('.agent-text')).toContainText('Codex checked the collection.');
    await expect(page.locator('.agent-workspace')).toContainText('Archived chat. Restore it from the chat menu to continue.');

    await expect(page.locator('[title]:not(iframe)')).toHaveCount(0);
  });
  test('guides installation and completes sign-in through the CLI', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      const e2e = window.__kurloE2E as unknown as Record<string, unknown>;
      const status = { installed: false, connected: false, authenticated: false, path: '', version: '', account: '', authType: '', model: '', models: [] as unknown[], authUrl: '', waiting: false };
      let signingIn = false;
      app.CodexStatus = async () => {
        if (signingIn) { status.authenticated = true; status.waiting = false; status.account = 'Signed-in account'; status.model = 'codex-test'; status.models = [{ id: 'codex-test', name: 'Codex test', recommended: true, weakTools: false }]; }
        return structuredClone(status);
      };
      app.OpenFileDialog = async () => { status.installed = true; status.path = '/custom/codex'; return status.path; };
      app.StartCodexLogin = async () => { signingIn = true; return { ...status, waiting: true, authUrl: 'https://auth.openai.com/test' }; };
      app.ConnectCodex = async () => { status.connected = true; return structuredClone(status); };
      app.CancelCodexLogin = async () => { signingIn = false; e2e.codexLoginCancelled = true; };
      app.AiConnections = async () => ({ connections: [] });
      window.runtime!.BrowserOpenURL = (url: string) => { e2e.codexAuthURL = url; };
    });
    await page.goto('/');
    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    await expect(page.getByRole('region', { name: 'Codex connection' })).toContainText('npm install -g @openai/codex');
    await page.getByRole('region', { name: 'Codex connection' }).getByRole('button', { name: 'Choose executable', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Codex executable' })).toHaveValue('/custom/codex');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Cancel sign-in', exact: true })).toBeVisible();
    expect(await page.evaluate(() => (window.__kurloE2E as unknown as { codexAuthURL: string }).codexAuthURL)).toBe('https://auth.openai.com/test');
    await page.getByRole('button', { name: 'Cancel sign-in', exact: true }).click();
    expect(await page.evaluate(() => (window.__kurloE2E as unknown as { codexLoginCancelled: boolean }).codexLoginCancelled)).toBe(true);
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Use this account', exact: true })).toBeVisible();
    await page.getByRole('button', { name: 'Use this account', exact: true }).click();
    await page.getByRole('button', { name: 'Close settings' }).click();
    await page.getByRole('button', { name: 'Agent', exact: true }).click();
    await expect(page.getByRole('textbox', { name: 'Message the agent' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^Agent:/ })).toHaveAccessibleName(/^Agent: Codex/);
  });

  test('keeps CLI detection separate from a failed model list and retries it', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
      let attempts = 0;
      app.CodexStatus = async () => {
        attempts++;
        return { installed: true, connected: false, authenticated: true, path: '/usr/local/bin/codex', version: 'codex-cli 0.166.0', account: 'user@example.test · plus', authType: 'chatgpt', model: attempts > 1 ? 'codex-test' : '', models: attempts > 1 ? [{ id: 'codex-test', name: 'Codex test', recommended: true, weakTools: false }] : [], authUrl: '', waiting: false, error: attempts === 1 ? 'Could not load Codex models: model/list: unavailable' : '' };
      };
    });
    await page.goto('/');
    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    const connection = page.getByRole('region', { name: 'Codex connection' });
    await expect(connection).toContainText('Codex CLI detected');
    await expect(connection).toContainText('Signed in: user@example.test');
    await expect(connection).not.toContainText('Install Codex CLI');
    await expect(connection.getByRole('textbox', { name: 'Codex executable' })).toHaveValue('/usr/local/bin/codex');
    await expect(connection.getByRole('alert')).toContainText('Could not load Codex models');
    await expect(connection.getByRole('button', { name: 'Use this account', exact: true })).toBeDisabled();
    await reviewShot(page, { path: join(tmpdir(), 'kurlo-codex-model-error.png'), animations: 'disabled' });
    await connection.getByRole('button', { name: 'Check again', exact: true }).click();
    await expect(connection.getByRole('alert')).toHaveCount(0);
    await expect(connection.getByRole('button', { name: 'Use this account', exact: true })).toBeEnabled();
    await expect(connection.getByRole('button', { name: /^Codex model:/ })).toContainText('Codex test');
  });

});

test('reconnects a saved Codex connection after a routing failure and retries the first message', async ({ page }) => {
  await installKurloBridge(page);
  await page.addInitScript(() => {
    const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
    let checks = 0;
    let sends = 0;
    const status = { installed: true, connected: true, authenticated: true, path: '/usr/local/bin/codex', version: 'codex-cli test', account: 'user@example.test', authType: 'chatgpt', model: 'test-model', models: [{ id: 'test-model', name: 'Test model' }], authUrl: '', waiting: false };
    app.AiConnections = async () => ({ connections: [] });
    app.AgentChats = async () => [];
    app.AgentPendingApprovals = async () => [];
    app.CodexStatus = async () => {
      checks++;
      if (checks === 1 || checks === 3) return { ...status, authenticated: false, models: [], error: 'account/read: workspace routing discovery failed' };
      return structuredClone(status);
    };
    app.SendAgentMessage = async (input: Record<string, string>) => {
      sends++;
      if (sends === 1) return { error: 'account/read: workspace routing discovery failed' };
      if (checks < 4) throw new Error('Sent before reconnect succeeded');
      if (input.text !== 'Check connection') throw new Error('Lost the original prompt');
      return { text: 'Connection restored', chat: { id: 'recovered-chat', driver: 'codex', workspaceId: input.workspaceId, title: 'Recovered', model: 'test-model', messages: [{ role: 'user', blocks: [{ type: 'text', text: input.text }] }, { role: 'assistant', blocks: [{ type: 'text', text: 'Connection restored' }] }] } };
    };
  });
  await page.goto('/');
  await page.getByLabel('Settings', { exact: true }).click();
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  const connection = page.getByRole('region', { name: 'Codex connection' });
  await expect(connection).toContainText('Unavailable');
  await expect(connection.getByRole('alert')).toContainText('Could not reach the provider');
  await connection.getByText('Technical details', { exact: true }).click();
  await expect(connection.getByRole('alert')).toContainText('workspace routing discovery failed');
  await reviewShot(page, { path: join(tmpdir(), 'kurlo-codex-network-error.png'), animations: 'disabled' });
  await connection.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(connection.getByRole('alert')).toHaveCount(0);
  await expect(connection.locator('.settings-pill')).toHaveText('Connected');
  await page.getByRole('button', { name: 'Close settings' }).click();
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const input = page.getByRole('textbox', { name: 'Message the agent' });
  await input.fill('Check connection');
  await input.press('Enter');
  await expect(page.locator('.agent-workspace').getByRole('alert')).toContainText('Could not reach the provider');
  await expect(input).toHaveValue('Check connection');
  await reviewShot(page, { path: join(tmpdir(), 'kurlo-agent-network-error.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Reconnect and retry', exact: true }).click();
  await expect(page.locator('.agent-workspace').getByRole('alert')).toContainText('Could not reach the provider');
  await expect(page.getByRole('button', { name: /^Agent:/ })).toHaveAccessibleName(/^Agent: Codex/);
  await expect(input).toHaveValue('Check connection');
  await page.getByRole('button', { name: 'Reconnect and retry', exact: true }).click();
  await expect(page.locator('.agent-text')).toContainText('Connection restored');
  await expect(page.locator('.agent-workspace').getByRole('alert')).toHaveCount(0);
});

test('pages and virtualizes a long Codex chat while preserving the reading position', async ({ page }, testInfo) => {
  await page.emulateMedia({ colorScheme: 'dark' });
  await installLongAgentHistory(page);
  const chat = page.locator('.agent-main > .agent-chat');
  await expect.poll(() => chat.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(0);
  if (testInfo.project.name === 'chromium') {
    const scrollbar = await chat.evaluate(element => ({
      nativeWidth: getComputedStyle(element).scrollbarWidth,
      track: getComputedStyle(element, '::-webkit-scrollbar-track').backgroundColor,
      thumb: getComputedStyle(element, '::-webkit-scrollbar-thumb').backgroundColor,
    }));
    expect(scrollbar.nativeWidth).toBe('auto');
    expect(scrollbar.track).toBe('rgba(0, 0, 0, 0)');
    expect(scrollbar.thumb).not.toBe(scrollbar.track);
  }
  const rows = page.locator('.virtual-agent-row');
  expect(await rows.count()).toBeLessThan(20);
  for (let index = 0; index < 4; index++) {
    await page.evaluate(() => { (window.__kurloE2E as unknown as Record<string, unknown>).deferEarlier = true; });
    await chat.evaluate(element => { element.scrollTop = 30; });
    await expect.poll(() => page.evaluate(() => Boolean((window.__kurloE2E as unknown as Record<string, unknown>).releaseHistory))).toBe(true);
    const anchor = await visibleHistoryAnchor(page);
    await page.evaluate(() => {
      const e2e = window.__kurloE2E as unknown as { releaseHistory?: () => void; deferEarlier: boolean };
      e2e.deferEarlier = false;
      e2e.releaseHistory?.();
      delete e2e.releaseHistory;
    });
    await expect(chat.getByRole('status', { name: 'Loading earlier messages' })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
    await expect.poll(async () => {
      return page.locator(`[data-turn-id="${anchor.id}"]`).evaluate((element, expected) => Math.abs(element.getBoundingClientRect().top - element.closest('.agent-chat')!.getBoundingClientRect().top - expected), anchor.top);
    }).toBeLessThan(2);
    expect(await rows.count()).toBeLessThan(25);
  }
  const calls = await page.evaluate(() => (window.__kurloE2E as unknown as { historyRequests: Array<{ before: number; count: number }> }).historyRequests);
  expect(calls.map(call => call.before)).toEqual([-1, 19920, 19840, 19760, 19680]);
  expect(calls.every(call => call.count === 80)).toBe(true);
  await reviewShot(page, { path: join(tmpdir(), `kurlo-long-history-${testInfo.project.name}.png`), animations: 'disabled' });
  await page.setViewportSize({ width: 800, height: 620 });
  await expect.poll(() => rows.count()).toBeGreaterThan(0);
  expect(await rows.count()).toBeLessThan(25);
  await chat.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator('.agent-text').last()).toContainText('Answer 9999');
});

test('loads earlier history when the keyboard scrolls to the top', async ({ page }) => {
  await installLongAgentHistory(page);
  const chat = page.locator('.agent-main > .agent-chat');
  await chat.focus();
  const requests = () => page.evaluate(() => (window.__kurloE2E as unknown as { historyRequests: unknown[] }).historyRequests.length);
  for (let press = 0; press < 80 && (await requests()) < 2; press++) {
    await page.keyboard.press('PageUp');
    await page.waitForTimeout(50);
  }
  await expect.poll(requests).toBeGreaterThanOrEqual(2);
});

test('fills a short first page of history up to the window by itself', async ({ page }) => {
  await page.addInitScript(() => { (window as unknown as { __shortFirstPage: boolean }).__shortFirstPage = true; });
  await installLongAgentHistory(page);
  const chat = page.locator('.agent-main > .agent-chat');
  const requests = () => page.evaluate(() => (window.__kurloE2E as unknown as { historyRequests: Array<{ before: number }> }).historyRequests.map(request => request.before));
  await expect.poll(requests).toEqual([-1, 19998]);
  await expect.poll(() => chat.evaluate(element => element.scrollHeight - element.clientHeight)).toBeGreaterThan(160);
  await expect(page.locator('.agent-text').last()).toContainText('Answer 9999');
  await expect(page.getByRole('button', { name: 'Load earlier messages' })).toHaveCount(0);
});

test('keeps paged history failures and delayed pages separate from another chat', async ({ page }) => {
  await installLongAgentHistory(page);
  await page.evaluate(() => { (window.__kurloE2E as unknown as Record<string, unknown>).failEarlier = true; });
  await page.locator('.agent-main > .agent-chat').evaluate(element => { element.scrollTop = 0; });
  await expect(page.locator('.agent-main > .agent-chat').getByRole('alert')).toHaveText('History temporarily unavailable');
  await expect(page.locator('.agent-text').first()).toContainText('Answer 9960');
  await page.evaluate(() => { (window.__kurloE2E as unknown as Record<string, unknown>).deferEarlier = true; });
  await page.locator('.agent-main > .agent-chat').getByRole('button', { name: 'Retry', exact: true }).click();
  await expect.poll(() => page.evaluate(() => Boolean((window.__kurloE2E as unknown as Record<string, unknown>).releaseHistory))).toBe(true);
  await page.locator('.agent-sidebar').getByRole('button', { name: /Small chat/ }).click();
  await expect(page.locator('.agent-text')).toHaveText('Small answer');
  await page.evaluate(() => { (window.__kurloE2E as unknown as { releaseHistory: () => void }).releaseHistory(); });
  await expect(page.locator('.agent-text')).toHaveText('Small answer');
  await expect(page.getByRole('textbox', { name: 'Chat name' })).toHaveValue('Small chat');
});

test('shows Codex compaction, ignores unrelated events and does not jump during background streaming', async ({ page }, testInfo) => {
  await installLongAgentHistory(page);
  const input = page.getByRole('textbox', { name: 'Message the agent' });
  await input.fill('Continue');
  await input.press('Enter');
  await expect.poll(() => page.evaluate(() => Boolean((window.__kurloE2E as unknown as Record<string, unknown>).longInput))).toBe(true);
  const emitCompaction = async (active: boolean, unrelated = false) => page.evaluate(({ active, unrelated }) => {
    const e2e = window.__kurloE2E as unknown as { emit: (name: string, payload: unknown) => void; longInput: { turnId: string } };
    e2e.emit('agent:compaction', { chatId: 'long-history', turnId: unrelated ? 'old-turn' : e2e.longInput.turnId, active });
  }, { active, unrelated });
  await emitCompaction(true, true);
  await expect(page.getByText('Compacting context…', { exact: true })).toHaveCount(0);
  await emitCompaction(true);
  await expect(page.getByText('Compacting context…', { exact: true })).toBeVisible();
  await reviewShot(page, { path: join(tmpdir(), `kurlo-codex-compacting-${testInfo.project.name}.png`), animations: 'disabled' });
  const chat = page.locator('.agent-main > .agent-chat');
  const movement = await chat.evaluate(async element => {
    const e2e = window.__kurloE2E as unknown as { emit: (name: string, payload: unknown) => void; longInput: { turnId: string } };
    const holdScroll = (event: Event) => event.stopImmediatePropagation();
    element.addEventListener('scroll', holdScroll, true);
    element.scrollTop -= 1600;
    const expected = element.scrollTop;
    e2e.emit('ai:deltas', { sessionId: 'long-history', turnId: e2e.longInput.turnId, deltas: [{ step: 0, index: 0, type: 'text', text: 'Updated before the scroll handler. '.repeat(200) }] });
    for (let frame = 0; frame < 4; frame++) await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
    const difference = Math.abs(element.scrollTop - expected);
    element.removeEventListener('scroll', holdScroll, true);
    element.dispatchEvent(new Event('scroll'));
    return difference;
  });
  expect(movement).toBeLessThan(2);
  const anchor = await visibleHistoryAnchor(page);
  await page.evaluate(() => {
    const e2e = window.__kurloE2E as unknown as { emit: (name: string, payload: unknown) => void; longInput: { turnId: string } };
    e2e.emit('ai:deltas', { sessionId: 'long-history', turnId: e2e.longInput.turnId, deltas: [{ step: 0, index: 0, type: 'text', text: 'Streaming new text. '.repeat(200) }] });
  });
  await emitCompaction(false);
  await expect(page.getByText('Compacting context…', { exact: true })).toHaveCount(0);
  await expect.poll(async () => {
    const current = await visibleHistoryAnchor(page);
    return current.id === anchor.id ? Math.abs(current.top - anchor.top) : 9999;
  }).toBeLessThan(2);
  await emitCompaction(true);
  await page.evaluate(() => { (window.__kurloE2E as unknown as { finishLongTurn: () => void }).finishLongTurn(); });
  await expect(page.getByText('Compacting context…', { exact: true })).toHaveCount(0);
  await page.locator('.agent-main > .agent-chat').evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(page.locator('.agent-text').last()).toContainText('New answer finished');
});

test('keeps the running Codex chat visible after a disconnected status refresh', async ({ page }) => {
  await installLongAgentHistory(page);
  const composer = page.getByRole('textbox', { name: 'Message the agent' });
  await composer.fill('Keep this Codex turn visible');
  await composer.press('Enter');
  const stop = page.getByRole('button', { name: 'Stop the agent' });
  await expect(stop).toBeVisible();
  await page.evaluate(() => {
    const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
    app.CodexStatus = async () => ({ connected: false, installed: true, authenticated: true, path: '/test/codex', models: [] });
  });
  await page.getByLabel('Settings', { exact: true }).click();
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  const connection = page.getByRole('region', { name: 'Codex connection' });
  await connection.getByRole('button', { name: 'Reconnect', exact: true }).click();
  await expect(connection.getByRole('button', { name: 'Remove connection' })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close settings' }).click();
  await expect(stop).toBeVisible();
  await expect(page.getByText('Keep this Codex turn visible', { exact: true })).toBeVisible();
  await page.evaluate(() => (window.__kurloE2E as unknown as { finishLongTurn: () => void }).finishLongTurn());
  await expect(stop).toHaveCount(0);
});
