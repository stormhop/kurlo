import type { E2EWindow } from './support/bridge';
import { reviewShot } from './support/reviewShot';
import { installKurloBridge } from './support/bridge';

import { expect, test } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test('offers sign-in when a connected Claude Code CLI is signed out', async ({ page }, testInfo) => {
  await installKurloBridge(page);
  await page.addInitScript(() => {
    localStorage.setItem('kurlo.disclosure.settings-ai-agents', '1');
    const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
    let signedIn = false;
    const rateLimits = [{ limitId: 'claude', limitName: 'Claude', secondary: { usedPercent: 14, windowDurationMins: 10080, resetsAt: 4102444800 } }];
    app.ClaudeCodeStatus = async () => ({ installed: true, connected: true, authenticated: signedIn, path: '/test/claude', version: '2.1.308 (Claude Code)', account: signedIn ? 'dev@example.com · max' : '', authMethod: signedIn ? 'subscription' : '', model: 'claude-opus-5-5', models: [{ id: 'claude-opus-5-5', name: 'Opus 5.5', recommended: true }], defaultModel: 'claude-opus-5-5', rateLimits });
    app.SignInClaudeCode = async () => { signedIn = true; return { ok: true }; };
  });
  await page.goto('/');
  await page.getByLabel('Settings', { exact: true }).click();
  await page.getByRole('tab', { name: 'AI', exact: true }).click();
  const panel = page.locator('#settings-panel-ai');
  const connection = panel.getByRole('region', { name: 'Claude Code connection' });
  await expect(connection.getByRole('status')).toHaveText('Signed out');
  await expect(connection).toContainText('Signed out. Sign in to use your Claude subscription again.');
  await expect(connection.getByLabel('Claude plan limits')).toHaveCount(0);
  await expect(panel).toContainText('Claude Code signed out');
  await expect(panel).not.toContainText('Claude Code connected');
  await reviewShot(page, { path: join(tmpdir(), `kurlo-claude-signed-out-${testInfo.project.name}.png`), animations: 'disabled' });
  await connection.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected');
  await expect(connection).toContainText('Signed in: dev@example.com · max');
  await expect(connection.getByLabel('Claude plan limits')).toContainText('86% left');
  await expect(panel).toContainText('Claude Code connected');
});

test('connects Claude Code like Codex and sends a workspace chat', async ({ page }, testInfo) => {
  await installKurloBridge(page);
  await page.addInitScript(() => {
    const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
    app.AiConnections = async () => ({ connections: [{ id: 'c1', label: 'Test API', kind: 'openai', provider: 'openai', model: 'test-model', hasKey: true, default: true }] });
    let signedIn = false;
    let account = 'dev@example.com · pro';
    let connected = false;
    let savedModel = 'claude-opus-5-5';
    let finishSignIn: () => void;
    const efforts = ['low', 'medium', 'high', 'xhigh', 'max'];
    const models = [{ id: 'claude-opus-5-5', name: 'Opus 5.5', recommended: true, efforts, defaultEffort: 'high' }, { id: 'claude-sonnet-5-5', name: 'Sonnet 5.5', efforts, defaultEffort: 'high' }];
    const rateLimits = [{ limitId: 'claude', limitName: 'Claude', primary: { usedPercent: 23, windowDurationMins: 300, resetsAt: 4102444800 }, secondary: { usedPercent: 61, windowDurationMins: 10080, resetsAt: 4102444800 } }];
    const status = () => ({ installed: true, connected, authenticated: signedIn, path: '/test/claude', version: '2.1.0 (Claude Code)', account: signedIn ? account : '', authMethod: signedIn ? 'subscription' : '', model: savedModel, models, defaultModel: 'claude-opus-5-5', ...(connected ? { rateLimits } : {}) });
    app.ClaudeCodeStatus = async () => status();
    app.ConnectClaudeCode = async (input: { model: string }) => {
      connected = true;
      savedModel = input.model || savedModel;
      return status();
    };
    app.RemoveClaudeCodeConnection = async () => { connected = false; account = 'refreshed@example.test · pro'; return { ok: true }; };
    app.SignInClaudeCode = async () => {
      await new Promise<void>(resolve => { finishSignIn = resolve; });
      signedIn = true;
      return { ok: true };
    };
    const e2e = window.__kurloE2E as unknown as Record<string, unknown>;
    e2e.finishClaudeSignIn = () => finishSignIn();
    const chats: Record<string, unknown>[] = [];
    app.AgentChats = async () => chats;
    app.SendAgentMessage = async (input: Record<string, string>) => {
      if (input.driver !== 'claude-code') throw new Error('Unexpected agent');
      e2e.claudeInput = input;
      const messages = [{ role: 'user', blocks: [{ type: 'text', text: input.text }] }, { role: 'assistant', blocks: [{ type: 'text', text: 'Claude checked the collection.' }] }];
      const usage = { input: 10, output: 400, cacheRead: 20000, cacheWrite: 5000, reasoning: 0, cost: 0.25 };
      const chat = { ...input, id: 'claude-chat', title: 'Check collection', externalThreadId: 'claude-session', messages, allowedTools: [], usage, contextTokens: 25010, contextWindow: 1000000, createdAt: Date.now(), updatedAt: Date.now() };
      chats.push(chat);
      return { chat, messages, steps: [], warnings: [], text: 'Claude checked the collection.', usage, hasUsage: true };
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const picker = page.getByRole('button', { name: /^Agent:/ });
  await picker.click();
  await expect(page.locator('.agent-pick-agent', { hasText: 'Claude Code' })).toContainText('Not signed in');
  await page.getByRole('button', { name: 'Manage connections' }).click();
  const connection = page.getByRole('region', { name: 'Claude Code connection' });
  await expect(connection.getByRole('status')).toHaveText('CLI detected');
  await expect(connection).toContainText('Claude Code CLI detected · 2.1.0 (Claude Code)');
  await expect(connection.getByRole('button', { name: 'Use this account' })).toHaveCount(0);
  await reviewShot(page, { path: join(tmpdir(), `kurlo-claude-sign-in-${testInfo.project.name}.png`), animations: 'disabled' });
  await connection.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(connection.getByRole('status')).toHaveText('Signing in…');
  await page.evaluate(() => (window.__kurloE2E as unknown as { finishClaudeSignIn: () => void }).finishClaudeSignIn());
  await expect(connection.getByRole('status')).toHaveText('Signed in');
  await expect(connection).toContainText('Signed in: dev@example.com · pro');
  await expect(connection.getByRole('button', { name: 'Reconnect' })).toBeVisible();
  await expect(connection.getByRole('button', { name: 'Check connection' })).toHaveCount(0);
  await connection.getByRole('button', { name: 'Use this account' }).click();
  await expect(connection.getByRole('status')).toHaveText('Connected');
  await expect(connection.getByRole('button', { name: 'Remove connection' })).toBeVisible();
  await expect(connection.getByRole('button', { name: 'Claude Code model: Opus 5.5' })).toBeVisible();
  await expect(connection.getByLabel('Claude plan limits')).toContainText('77% left');
  await expect(connection.locator('.claude-glyph .agent-brand-glyph')).toHaveCount(1);
  await reviewShot(page, { path: join(tmpdir(), `kurlo-claude-settings-${testInfo.project.name}.png`), animations: 'disabled' });
  await page.getByRole('button', { name: 'Close settings' }).click();
  await picker.click();
  await page.getByRole('radio', { name: /Claude Code/ }).click();
  await expect(page.getByRole('radiogroup', { name: 'Claude Code model' }).getByRole('radio')).toHaveText([/Opus 5\.5/, /Sonnet 5\.5/]);
  await page.getByRole('radio', { name: /^Sonnet 5\.5/ }).click();
  await expect(picker).toHaveAccessibleName('Agent: Claude Code · Sonnet 5.5');
  const effortPicker = page.getByRole('button', { name: /^Effort:/ });
  await expect(effortPicker).toHaveAccessibleName('Effort: High');
  await effortPicker.click();
  const effortList = page.getByRole('listbox', { name: 'Effort', exact: true });
  await expect(effortList.getByRole('option')).toHaveText([/Low/, /Medium/, /High/, /Extra high/, /Max/]);
  await effortList.getByRole('option', { name: 'Max', exact: true }).click();
  await expect(effortPicker).toHaveAccessibleName('Effort: Max');
  const composer = page.getByRole('textbox', { name: 'Message the agent' });
  await composer.fill('Check collection');
  await composer.press('Enter');
  await expect(page.locator('.agent-text')).toContainText('Claude checked the collection.');
  expect(await page.evaluate(() => (window.__kurloE2E as unknown as { claudeInput: Record<string, string> }).claudeInput)).toMatchObject({ driver: 'claude-code', model: 'claude-sonnet-5-5', effort: 'max' });
  await expect(page.locator('.agent-sidebar').getByRole('button', { name: /Claude Code.*Check collection/ })).toBeVisible();
  await expect(page.locator('.agent-composer .agent-usage')).toContainText('25.0k in');
  await expect(page.locator('.agent-plan-mini')).toHaveText('Plan 39% left');
  await page.getByRole('button', { name: 'Toggle chat details' }).click();
  const details = page.getByRole('complementary', { name: 'Chat details', exact: true });
  await details.getByRole('region', { name: 'Context' }).getByRole('button', { name: /^Context/ }).click();
  await expect(details).toContainText('Claude Code · Sonnet 5.5');
  await expect(details).toContainText('Cost at API prices$0.25');
  await expect(details.locator('.agent-context')).toContainText('3%');
  await expect(details.locator('.agent-context')).toContainText('25.0k / 1.0M');
  await expect(details.getByRole('region', { name: 'Claude plan' })).toContainText('39% left');
  await expect(details.locator('.agent-limits')).toContainText('77% left');
  await expect(details.locator('.agent-limits')).toContainText('39% left');
  await expect(details).toContainText('Shared with your other Claude Code sessions.');
  await reviewShot(page, { path: join(tmpdir(), `kurlo-claude-chat-${testInfo.project.name}.png`), animations: 'disabled' });
  await picker.click();
  await page.getByRole('button', { name: 'Manage connections', exact: true }).click();
  await connection.getByRole('button', { name: 'Remove connection', exact: true }).click();
  await expect(connection).toContainText('Signed in: refreshed@example.test · pro');
  await expect(connection.getByRole('button', { name: 'Use this account', exact: true })).toBeVisible();
  await expect(connection.getByLabel('Claude plan limits')).toHaveCount(0);
});

test('uses discovered Claude Code models and their own effort levels', async ({ page }, testInfo) => {
  await installKurloBridge(page);
  await page.addInitScript(() => {
    const app = (window as E2EWindow).go!.api!.App as Record<string, unknown>;
    const e2e = window.__kurloE2E as unknown as Record<string, unknown>;
    app.ClaudeCodeStatus = async () => ({
      installed: true, connected: true, authenticated: true, path: '/test/claude', version: '2.1.308 (Claude Code)',
      account: 'dev@example.com · max', authMethod: 'subscription', model: 'custom-fast', defaultModel: 'custom-fast',
      models: [
        { id: 'claude-future-42[1m]', name: 'Future 42', recommended: false, efforts: ['low', 'max'], defaultEffort: 'low' },
        { id: 'custom-fast', name: 'Custom Fast', recommended: true },
      ],
    });
    app.SendAgentMessage = async (input: Record<string, string>) => {
      e2e.claudeInput = input;
      const messages = [{ role: 'user', blocks: [{ type: 'text', text: input.text }] }, { role: 'assistant', blocks: [{ type: 'text', text: 'Future model replied.' }] }];
      const chat = { ...input, id: 'future-chat', title: 'Check models', externalThreadId: 'future-session', messages, allowedTools: [], usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, cost: 0 }, createdAt: Date.now(), updatedAt: Date.now() };
      return { chat, messages, steps: [], warnings: [], text: 'Future model replied.' };
    };
  });
  await page.goto('/');
  await page.getByRole('button', { name: 'Agent', exact: true }).click();
  const picker = page.getByRole('button', { name: /^Agent:/ });
  await picker.click();
  await page.getByRole('radio', { name: /Claude Code/ }).click();
  await expect(page.getByRole('radiogroup', { name: 'Claude Code model' }).getByRole('radio')).toHaveText([/Future 42/, /Custom Fast/]);
  await page.getByRole('radio', { name: /^Future 42/ }).click();
  await expect(picker).toHaveAccessibleName('Agent: Claude Code · Future 42');
  const effortPicker = page.getByRole('button', { name: /^Effort:/ });
  await expect(effortPicker).toHaveAccessibleName('Effort: Low');
  await effortPicker.click();
  const effortList = page.getByRole('listbox', { name: 'Effort', exact: true });
  await expect(effortList.getByRole('option')).toHaveText([/Low/, /Max/]);
  await effortList.getByRole('option', { name: 'Max', exact: true }).click();
  await picker.click();
  await page.getByRole('radio', { name: /^Custom Fast/ }).click();
  await expect(effortPicker).toHaveCount(0);
  await picker.click();
  await page.getByRole('radio', { name: /^Future 42/ }).click();
  await expect(effortPicker).toHaveAccessibleName('Effort: Max');
  await reviewShot(page, { path: join(tmpdir(), `kurlo-claude-discovered-models-${testInfo.project.name}.png`), animations: 'disabled' });
  const composer = page.getByRole('textbox', { name: 'Message the agent' });
  await composer.fill('Check models');
  await composer.press('Enter');
  await expect(page.locator('.agent-text')).toContainText('Future model replied.');
  expect(await page.evaluate(() => (window.__kurloE2E as unknown as { claudeInput: Record<string, string> }).claudeInput)).toMatchObject({ driver: 'claude-code', model: 'claude-future-42[1m]', effort: 'max' });
});
