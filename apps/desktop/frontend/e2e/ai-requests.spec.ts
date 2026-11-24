import type { E2EWindow } from './support/bridge';
import { chooseRequestType, clickTabClose, fillCodeEditor } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';

import { captureDocsScreenshot } from './support/screenshots';

import { expect, test } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('cuts a long AI connection name inside the request bar button', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const label = 'Company OpenAI-compatible gateway for the analytics and reporting platform in Europe';
      const app = (window as E2EWindow).go.api.App as Record<string, unknown>;
      app.AiConnections = async () => ({ connections: [{ id: 'c1', kind: 'compatible', label, baseUrl: 'https://gateway.example.test/v1', model: 'gpt-4.1', hasKey: true, keyHint: 'sk-…d5e', default: true, provider: 'openai' }] });
    });
    await page.setViewportSize({ width: 1000, height: 700 });
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await page.getByLabel('Provider and model').click();
    await page.getByRole('radio', { name: 'Kurlo connection' }).click();
    await page.keyboard.press('Escape');
    const button = page.getByRole('button', { name: 'Default AI connection' });
    await expect(button).toContainText('Company OpenAI-compatible gateway');
    const layout = await button.evaluate(node => {
      const box = node.getBoundingClientRect();
      const label = node.querySelector('.ai-connection-url-label')!;
      const hint = node.querySelector('.ai-connection-url-hint')!.getBoundingClientRect();
      const text = label.getBoundingClientRect();
      return { labelInside: text.right <= box.right + 0.5, labelCut: label.scrollWidth > label.clientWidth, hintInside: hint.right <= box.right + 0.5 && hint.left >= text.right - 0.5, sameLine: Math.abs(hint.top - text.top) < 4 };
    });
    expect(layout).toEqual({ labelInside: true, labelCut: true, hintInside: true, sameLine: true });
    await page.screenshot({ path: join(tmpdir(), `kurlo-ai-connection-long-${test.info().project.name}.png`), clip: { x: 330, y: 80, width: 670, height: 60 } });
  });

  test('sends an AI request, streams the answer and shows the tool call', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await expect(page.getByLabel('Provider base URL')).toHaveValue('https://api.openai.com/v1');
    const endpoint = page.locator('.ai-endpoint');
    await expect(endpoint).toContainText('POST https://api.openai.com/v1/chat/completions');
    await expect(endpoint.locator('.ai-endpoint-suffix')).toHaveText('/chat/completions');
    await page.getByLabel('Provider base URL').fill('https://api.deepseek.com/v1/chat/completions');
    await expect(endpoint.locator('.ai-endpoint-suffix')).toHaveCount(0);
    await expect(endpoint).toContainText('POST https://api.deepseek.com/v1/chat/completions');
    await page.getByLabel('Provider base URL').fill('https://api.deepseek.com/v1');
    await expect(endpoint.locator('.ai-endpoint-suffix')).toHaveText('/chat/completions');
    await page.getByLabel('Provider base URL').fill('https://api.openai.com/v1');

    await page.getByLabel('Provider and model').click();
    await page.getByRole('radio', { name: 'Ollama' }).click();
    await expect(page.getByRole('radio', { name: 'Ollama' })).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByLabel('Provider base URL')).toHaveValue('http://localhost:11434/v1');
    await expect(page.getByRole('option', { name: 'qwen2.5:7b' })).toBeVisible();
    await page.getByRole('option', { name: 'llama3.2' }).click();
    await expect(page.getByLabel('Provider and model')).toContainText('Ollama');
    await expect(page.getByLabel('Provider and model')).toContainText('llama3.2');
    const picker = page.getByRole('button', { name: 'Provider and model' });
    await picker.click();
    await expect(page.getByRole('dialog', { name: 'Provider and model' })).toBeVisible();
    await expect(page.getByLabel('Model', { exact: true })).toBeFocused();
    await picker.click();
    await expect(page.getByRole('dialog', { name: 'Provider and model' })).toHaveCount(0);

    await fillCodeEditor(page, 'ai-prompt-editor', 'Do I need an umbrella in Lisbon tomorrow?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();

    await expect(page.locator('.ai-text').last()).toContainText('Bring an umbrella');
    await expect(page.locator('.ai-text').last().locator('strong')).toHaveText('72%');
    await expect(page.locator('.ai-text').last().locator('li')).toHaveCount(2);
    await expect(page.locator('.ai-text').last()).not.toContainText('**');
    await expect(page.locator('.ai-tool-name')).toContainText('get_weather');
    await expect(page.locator('.ai-tool-server')).toContainText('Weather');
    await expect(page.locator('.ai-tool-result')).toContainText('"rain":0.72');
    await expect(page.locator('.ai-metrics')).toContainText('TTFT');
    await expect(page.locator('.ai-stop')).toContainText('end_turn');
    await captureDocsScreenshot(page, 'request-ai');

    const sent = await page.evaluate(() => window.__kurloE2E.sentAiRequests);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ provider: 'openai', model: 'llama3.2' });
    expect(sent[0].messages).toEqual([{ role: 'user', blocks: [{ type: 'text', text: 'Do I need an umbrella in Lisbon tomorrow?' }] }]);
    expect((sent[0].http as Record<string, unknown>).auth).toMatchObject({ type: 'none' });

    await page.getByRole('tab', { name: /Tests/ }).click();
    await expect(page.locator('.test-row.fail')).toContainText('answers fast');

    await page.getByRole('tab', { name: 'Raw' }).click();
    const rawSteps = page.locator('.ai-raw-step');
    await expect(rawSteps).toHaveCount(2);
    await expect(rawSteps.first().locator('.ai-raw-head')).toHaveAttribute('aria-expanded', 'false');
    await expect(rawSteps.last().locator('.ai-raw-head')).toHaveAttribute('aria-expanded', 'true');
    await expect(rawSteps.last().locator('.ai-raw-body')).toContainText('Bring');
    await rawSteps.first().locator('.ai-raw-head').click();
    await expect(rawSteps.first().locator('.ai-raw-body')).toContainText('Let me');

    await page.getByRole('tab', { name: 'Chat' }).click();
    const panel = page.locator('.ai-panel');
    const chatBox = await page.locator('.ai-chat').boundingBox();
    const turnBox = await page.locator('.ai-turn').first().boundingBox();
    expect(turnBox!.width).toBeGreaterThan(chatBox!.width - 80);

    const reply = page.getByRole('textbox', { name: 'Reply' });
    await reply.click();
    await page.keyboard.type('And on');
    await page.keyboard.press('Shift+Enter');
    await page.keyboard.type('Saturday?');
    await expect(reply).toHaveValue('And on\nSaturday?');
    expect(await page.evaluate(() => window.__kurloE2E.sentAiRequests.length)).toBe(1);
    await expect(reply).toHaveAttribute('spellcheck', 'false');
    await expect(reply).toHaveAttribute('autocomplete', 'off');
    await page.keyboard.press('Enter');
    await expect(page.locator('.ai-user')).toHaveCount(2);
    await expect(reply).toHaveValue('');
    const followUp = await page.evaluate(() => window.__kurloE2E.sentAiRequests[1]);
    expect((followUp.messages as Array<{ role: string }>).map(m => m.role)).toEqual(['user', 'assistant', 'tool', 'assistant', 'user']);
    expect((followUp.messages as Array<{ blocks: Array<{ text: string }> }>).at(-1)?.blocks[0].text).toBe('And on\nSaturday?');
    await captureDocsScreenshot(page, 'request-ai-chat');

    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.locator('#ai-top-p').fill('5');
    const topPError = page.locator('#ai-top-p-error');
    await expect(topPError).toHaveText('Use a number from 0 to 1.');
    const [topP, topPMessage] = [await page.locator('#ai-top-p').boundingBox(), await topPError.boundingBox()];
    expect(topPMessage!.y).toBeGreaterThanOrEqual(topP!.y + topP!.height - 1);
    expect(Math.abs((topPMessage!.x + topPMessage!.width) - (topP!.x + topP!.width))).toBeLessThan(2);
    await reply.fill('Keep this follow-up when settings are invalid');
    await reply.press('Enter');
    await expect(reply).toHaveValue('Keep this follow-up when settings are invalid');
    await expect(page.locator('.ai-composer-error')).toBeVisible();
    await captureDocsScreenshot(page, 'request-ai-validation-error');
    await page.locator('#ai-top-p').fill('');
    await page.getByRole('tab', { name: /Prompt/ }).click();

    await panel.getByRole('button', { name: 'New chat' }).click();
    await expect(page.locator('.ai-user')).toHaveCount(0);
    await expect(panel).toContainText('Send the prompt to start a conversation.');
  });

  test('sends an AI request through the Kurlo connection from settings', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const connections = [
        { id: 'c1', kind: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', hasKey: true, keyHint: 'sk-ant-…XYZ', default: true, provider: 'anthropic' },
        { id: 'c2', kind: 'compatible', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hasKey: true, keyHint: 'sk-…d5e', default: false, provider: 'openai' },
      ];
      const app = (window as E2EWindow).go.api.App as Record<string, unknown>;
      app.AiConnections = async () => ({ connections: structuredClone(connections) });
      app.SetDefaultAiConnection = async (id: string) => {
        for (const connection of connections) connection.default = connection.id === id;
        return { connections: structuredClone(connections) };
      };
    });
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await page.getByLabel('Provider and model').click();
    await page.getByRole('radio', { name: 'Kurlo connection' }).click();
    await expect(page.getByLabel('Provider base URL')).toHaveCount(0);
    const menu = page.getByRole('dialog', { name: 'Provider and model' });
    await expect(menu).toContainText('Anthropic');
    await expect(menu).toContainText('claude-sonnet-4-5');
    await expect(menu.getByLabel('Model', { exact: true })).toHaveCount(0);
    await page.keyboard.press('Escape');
    const connectionButton = page.getByRole('button', { name: 'Default AI connection' });
    await expect(connectionButton).toContainText('Anthropic');
    await expect(page.getByRole('button', { name: 'Provider and model' })).toContainText('claude-sonnet-4-5');

    await fillCodeEditor(page, 'ai-prompt-editor', 'Hello');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.ai-text').last()).toBeVisible();
    const sent = await page.evaluate(() => window.__kurloE2E.sentAiRequests);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ provider: 'kurlo', model: '' });
    expect((sent[0].http as Record<string, unknown>).url).toBe('');
    expect((sent[0].http as Record<string, unknown>).auth).toMatchObject({ type: 'none' });

    await connectionButton.click();
    const panel = page.locator('#settings-panel-ai');
    await panel.getByRole('listitem').filter({ hasText: 'DeepSeek' }).getByRole('button', { name: 'Make default' }).click();
    await expect(panel.getByRole('listitem').filter({ hasText: 'DeepSeek' })).toContainText('Default');
    await page.getByRole('button', { name: 'Close settings' }).click();
    await expect(connectionButton).toContainText('DeepSeek');
    await expect(page.getByRole('button', { name: 'Provider and model' })).toContainText('deepseek-chat');
  });

  test('gives an AI request Kurlo tools and a chosen connection', async ({ page }, testInfo) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const connections = [
        { id: 'c1', kind: 'anthropic', label: 'Anthropic', baseUrl: 'https://api.anthropic.com/v1', model: 'claude-sonnet-4-5', hasKey: true, keyHint: 'sk-ant-…XYZ', default: true, provider: 'anthropic' },
        { id: 'c2', kind: 'compatible', label: 'DeepSeek', baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', hasKey: true, keyHint: 'sk-…d5e', default: false, provider: 'openai' },
      ];
      ((window as E2EWindow).go.api.App as Record<string, unknown>).AiConnections = async () => ({ connections: structuredClone(connections) });
    });
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await page.getByLabel('Provider and model').click();
    await page.getByRole('radio', { name: 'Kurlo connection' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('button', { name: 'Default AI connection' })).toContainText('Anthropic');

    await page.getByRole('tab', { name: 'Settings' }).click();
    await page.getByRole('button', { name: /^Connection/ }).click();
    await page.getByRole('option', { name: 'DeepSeek' }).click();
    await expect(page.getByRole('button', { name: 'AI connection', exact: true })).toContainText('DeepSeek');
    await expect(page.getByRole('button', { name: 'Provider and model' })).toContainText('deepseek-chat');

    await page.getByRole('tab', { name: /^Tools/ }).click();
    const kurloTools = page.getByRole('checkbox', { name: /Kurlo tools/ });
    await expect(kurloTools).not.toBeChecked();
    await kurloTools.check();
    await expect(page.getByRole('tab', { name: /^Tools/ })).toContainText('1');
    await page.screenshot({ path: join(tmpdir(), `kurlo-ai-kurlo-tools-${testInfo.project.name}.png`), animations: 'disabled' });

    await page.getByRole('tab', { name: /^Prompt/ }).click();
    await fillCodeEditor(page, 'ai-prompt-editor', 'Which requests are saved?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.ai-text').last()).toBeVisible();
    const sent = await page.evaluate(() => window.__kurloE2E.sentAiRequests);
    expect(sent.at(-1)).toMatchObject({ provider: 'kurlo', connectionId: 'c2', kurloTools: true });
  });

  test('ignores the old auth of a request switched to the Kurlo connection', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const app = (window as E2EWindow).go.api.App as Record<string, unknown>;
      app.AiConnections = async () => ({ connections: [{ id: 'c1', kind: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: 'deepseek-flash', hasKey: true, keyHint: 'sk-or-v1-…bb9', default: true, provider: 'openai' }] });
      app.TestAiConnection = async () => ({ ok: true, models: [{ id: 'deepseek-flash', name: 'DeepSeek Flash', recommended: false, weakTools: false }] });
    });
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await page.getByRole('tab', { name: /^Auth/ }).click();
    await page.locator('#bearer-token').fill('{{missingSecretKey}}');
    await page.getByLabel('Provider and model').click();
    await page.getByRole('radio', { name: 'Kurlo connection' }).click();
    await page.keyboard.press('Escape');
    await expect(page.getByRole('note')).toContainText('The auth below is not sent');

    await page.getByRole('tab', { name: /^Prompt/ }).click();
    await fillCodeEditor(page, 'ai-prompt-editor', 'привет bro');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    await expect(page.locator('.ai-text').last()).toBeVisible();
    const sent = await page.evaluate(() => window.__kurloE2E.sentAiRequests);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ provider: 'kurlo', model: '' });
    expect((sent[0].http as Record<string, unknown>).auth).toMatchObject({ type: 'none' });
    expect(JSON.stringify(sent[0].http)).not.toContain('missingSecretKey');
  });

  test('keeps a missing Kurlo vault reference out of the AI auth field', async ({ page }, testInfo) => {
    const secretReference = '{{kurloSecret:request.ai-missing-secret.auth.bearerToken}}';
    await installKurloBridge(page, '', 'darwin/e2e', false, {
      activeId: 'ai-missing-secret',
      openIds: ['ai-missing-secret'],
      collections: [{ id: 'collection-e2e', workspaceId: 'workspace-e2e', name: 'Core API' }],
      requests: [{
        id: 'ai-missing-secret', name: 'AI request', collectionId: 'collection-e2e',
        requestType: 'ai', requestTab: 'auth', method: 'POST', aiProvider: 'kurlo',
        auth: { type: 'bearer', bearerToken: secretReference },
      }],
    });
    await page.goto('/');

    const token = page.locator('#bearer-token');
    await expect(token).toHaveAttribute('placeholder', 'Secret unavailable on this device');
    await expect(token).toHaveValue('');
    await expect(page.getByRole('button', { name: 'Clear missing secret reference' })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Decode', exact: true })).toBeDisabled();
    await expect(page.locator('body')).not.toContainText(secretReference);
    await expect.poll(() => page.evaluate(() =>
      window.__kurloE2E.store.requests.find(request => request.id === 'ai-missing-secret')?.auth.bearerToken,
    )).toBe(secretReference);
    await page.screenshot({
      path: join(tmpdir(), `kurlo-ai-missing-secret-${testInfo.project.name}.png`),
      animations: 'disabled',
    });

    await token.click();
    await expect(token).toBeFocused();
    await page.keyboard.press('Tab');
    await expect(token).not.toBeFocused();
    await expect(page.locator('body')).not.toContainText(secretReference);
    await page.getByRole('tab', { name: /^Prompt/ }).click();
    await fillCodeEditor(page, 'ai-prompt-editor', 'Keep the unavailable reference while editing another field');
    await page.keyboard.press('Meta+s');
    await expect.poll(() => page.evaluate(() =>
      window.__kurloE2E.store.requests.find(request => request.id === 'ai-missing-secret')?.aiPrompt,
    )).toBe('Keep the unavailable reference while editing another field');
    await expect.poll(() => page.evaluate(() =>
      window.__kurloE2E.store.requests.find(request => request.id === 'ai-missing-secret')?.auth.bearerToken,
    )).toBe(secretReference);

    await page.getByRole('tab', { name: /^Auth/ }).click();
    await page.getByRole('button', { name: 'Clear missing secret reference' }).click();
    await expect(token).toBeFocused();
    await expect(token).toHaveValue('');
    await expect(token).toHaveAttribute('placeholder', 'Enter bearer token');
    await expect(page.getByRole('button', { name: 'Clear missing secret reference' })).toHaveCount(0);
    await page.keyboard.press('Meta+s');
    await expect.poll(() => page.evaluate(() =>
      window.__kurloE2E.store.requests.find(request => request.id === 'ai-missing-secret')?.auth.bearerToken,
    )).toBe('');

    await page.reload();
    await expect(token).toHaveAttribute('placeholder', 'Secret unavailable on this device');
    await token.click();
    await page.keyboard.type('{');
    await expect(token).toBeFocused();
    await page.keyboard.type('{userToken}}');
    await expect(token).toHaveValue('{{userToken}}');
    await page.keyboard.press('Meta+s');
    await expect.poll(() => page.evaluate(() =>
      window.__kurloE2E.store.requests.find(request => request.id === 'ai-missing-secret')?.auth.bearerToken,
    )).toBe('{{userToken}}');
    await expect(page.locator('body')).not.toContainText('ai-missing-secret');
  });

  test('keeps the AI prompt and settings inside a narrow request panel', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 470 });
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.responseLayout.v1', 'right'));
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await fillCodeEditor(page, 'ai-prompt-editor', 'привет братик');
    await page.getByTestId('ai-prompt-editor').locator('.cm-content').click();
    const scroller = page.getByTestId('ai-prompt-editor').locator('.cm-scroller');
    await expect.poll(() => scroller.evaluate(el => el.scrollTop)).toBe(0);
    const frame = await page.locator('.ai-editor-prompt').boundingBox();
    const line = await page.getByTestId('ai-prompt-editor').locator('.cm-line').first().boundingBox();
    expect(line!.y).toBeGreaterThanOrEqual(frame!.y + 6);
    expect(line!.y + line!.height).toBeLessThanOrEqual(frame!.y + frame!.height);
    expect(await scroller.evaluate(el => el.scrollHeight <= el.clientHeight + 1 && el.scrollWidth <= el.clientWidth + 1)).toBe(true);

    const divider = page.getByRole('button', { name: 'Resize panels' });
    const box = await divider.boundingBox();
    await page.mouse.move(box!.x + box!.width / 2, box!.y + 40);
    await page.mouse.down();
    await page.mouse.move(0, box!.y + 40, { steps: 8 });
    await page.mouse.up();
    const editor = await page.locator('.request-editor').boundingBox();
    expect(editor!.width).toBeGreaterThanOrEqual(24 * 16 - 1);

    await page.getByRole('button', { name: 'Request section' }).click();
    await page.getByRole('option', { name: 'Settings' }).click();
    const fits = await page.locator('.request-editor .postman-setting input.setting-number').evaluateAll(inputs => inputs.every(input => {
      const rect = input.getBoundingClientRect();
      const panel = input.closest('.request-editor')!.getBoundingClientRect();
      return rect.right <= panel.right + 0.5 && rect.width > 40;
    }));
    expect(fits).toBe(true);

    const rowOffset = () => page.locator('#ai-temperature').evaluate(input => {
      const rect = input.getBoundingClientRect();
      const row = input.closest('.postman-setting')!.getBoundingClientRect();
      return { top: Math.round(rect.top - row.top), right: Math.round(row.right - rect.right) };
    });
    const offsetBefore = await rowOffset();
    await page.locator('#ai-temperature').fill('2132312231');
    const error = page.locator('#ai-temperature-error');
    await expect(error).toHaveText('Use a number from 0 to 2.');
    await expect(page.locator('#ai-temperature')).toHaveAttribute('aria-invalid', 'true');
    const [field, message] = [await page.locator('#ai-temperature').boundingBox(), await error.boundingBox()];
    expect(message!.y).toBeGreaterThanOrEqual(field!.y + field!.height - 1);
    expect(message!.y - (field!.y + field!.height)).toBeLessThan(16);
    expect(field!.width).toBeLessThanOrEqual(8 * 16 + 1);
    expect(await rowOffset()).toEqual(offsetBefore);
    await page.locator('#ai-temperature').fill('');
    await expect(error).toHaveCount(0);

    await page.getByRole('button', { name: 'Provider and model' }).click();
    await page.getByRole('radio', { name: 'Ollama' }).click();
    await page.getByRole('option', { name: 'llama3.2' }).click();
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const badge = page.locator('.ai-panel .status-badge');
    await expect(badge).toContainText('200');
    expect(await badge.evaluate(el => el.scrollWidth <= el.clientWidth + 1 && el.getBoundingClientRect().right <= el.closest('.response-status-bar')!.getBoundingClientRect().right)).toBe(true);
    const newChat = page.locator('.ai-panel').getByRole('button', { name: 'New chat' });
    await expect(newChat).toBeVisible();
    const statusFits = await page.locator('.ai-panel .response-status-bar').evaluate(bar => [...bar.querySelectorAll('.status-left, .status-right')].every(part => part.getBoundingClientRect().right <= bar.getBoundingClientRect().right + 0.5));
    expect(statusFits).toBe(true);
    const [replyBox, sendBox] = [await page.getByRole('textbox', { name: 'Reply' }).boundingBox(), await page.getByRole('button', { name: 'Send reply' }).boundingBox()];
    expect(Math.abs(replyBox!.height - sendBox!.height)).toBeLessThan(1.5);
    expect(Math.abs((replyBox!.y + replyBox!.height) - (sendBox!.y + sendBox!.height))).toBeLessThan(1.5);
  });

  test('opens Settings → AI on the connections and models of an AI request', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.disclosure.settings-ai-kurlo', '0'));
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await page.getByRole('button', { name: 'Provider and model' }).click();
    await page.getByRole('radio', { name: 'Kurlo connection' }).click();
    await page.getByRole('button', { name: 'Open Settings → AI' }).click();
    const kurlo = page.getByRole('region', { name: 'Kurlo agent' }).getByRole('button', { name: /Kurlo agent/ });
    const agents = page.getByRole('region', { name: 'Your agents' }).getByRole('button', { name: /Your agents/ });
    await expect(kurlo).toHaveAttribute('aria-expanded', 'true');
    await expect(agents).toHaveAttribute('aria-expanded', 'false');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Default AI connection' }).click();
    await expect(kurlo).toHaveAttribute('aria-expanded', 'true');
    await expect(agents).toHaveAttribute('aria-expanded', 'false');
  });

  test('grows the AI prompt field with its text up to the free height', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 900 });
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.responseLayout.v1', 'right'));
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    const field = page.locator('.ai-editor-prompt');
    const root = page.locator('.ai-prompt');
    const empty = (await field.boundingBox())!.height;
    const free = (await root.boundingBox())!.height;
    expect(empty).toBeLessThan(free * 0.75);
    expect(empty).toBeGreaterThan(9 * 16 - 2);
    await fillCodeEditor(page, 'ai-prompt-editor', Array.from({ length: 8 }, (_, index) => `line ${index + 1}`).join('\n'));
    const grown = (await field.boundingBox())!.height;
    expect(grown).toBeGreaterThan(empty + 20);
    await fillCodeEditor(page, 'ai-prompt-editor', Array.from({ length: 80 }, (_, index) => `line ${index + 1}`).join('\n'));
    const rootBox = (await root.boundingBox())!;
    const fieldBox = (await field.boundingBox())!;
    expect(fieldBox.y + fieldBox.height).toBeLessThanOrEqual(rootBox.y + rootBox.height + 1);
    expect((await page.getByLabel('System prompt').boundingBox())!.height).toBeGreaterThan(40);
    const scroller = page.getByTestId('ai-prompt-editor').locator('.cm-scroller');
    expect(await scroller.evaluate(el => el.scrollHeight > el.clientHeight + 20)).toBe(true);
  });

  test('stops the AI prompt and system prompt at their length limits', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    const prompt = page.getByTestId('ai-prompt-editor').locator('.cm-content');
    await prompt.click();
    await page.keyboard.insertText('x'.repeat(200_010));
    await expect(page.locator('.ai-counter-full')).toHaveText('200,000 / 200,000');
    await page.keyboard.type('more');
    await expect(page.locator('.ai-counter-full')).toHaveText('200,000 / 200,000');
    await page.keyboard.press('Backspace');
    await expect(page.locator('.ai-counter')).toHaveText('199,999 / 200,000');
    await expect(page.locator('.ai-counter-full')).toHaveCount(0);

    const system = page.getByLabel('System prompt').locator('.cm-content');
    await system.click();
    await page.keyboard.insertText('s'.repeat(50_005));
    await expect(page.locator('.ai-counter-full')).toHaveText('50,000 / 50,000');
    await expect(page.getByRole('textbox', { name: 'Reply' })).toHaveCount(0);
  });

  test('shows a provider error inside the chat, with its status, link and a hint', async ({ page }) => {
    await page.setViewportSize({ width: 1180, height: 760 });
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.responseLayout.v1', 'right'));
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await page.getByRole('button', { name: 'Provider and model' }).click();
    await page.getByRole('radio', { name: 'Ollama' }).click();
    await page.getByRole('option', { name: 'llama3.2' }).click();
    await fillCodeEditor(page, 'ai-prompt-editor', 'Spend my credits');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const card = page.locator('.ai-error-card');
    await expect(card.locator('.ai-error-title')).toHaveText('The provider returned an error');
    await expect(card.locator('.ai-error-status')).toHaveText('402 Payment Required');
    await expect(card.locator('.ai-error-message')).toContainText('This request requires more credits');
    await expect(card.locator('.ai-error-message a')).toHaveAttribute('href', /^https:\/\/openrouter\.ai\/workspaces\/default\/keys\//);
    await expect(card.locator('.ai-error-hint')).toHaveText('Add credits at the provider, or lower Max tokens in Settings.');
    const chat = page.locator('.ai-chat');
    expect(await chat.evaluate(el => el.scrollWidth <= el.clientWidth + 1)).toBe(true);
    const [cardBox, chatBox] = [await card.boundingBox(), await chat.boundingBox()];
    expect(cardBox!.x).toBeGreaterThanOrEqual(chatBox!.x);
    expect(cardBox!.x + cardBox!.width).toBeLessThanOrEqual(chatBox!.x + chatBox!.width + 0.5);
  });

  test('keeps the status code and New chat on the AI status line when the model name is long', async ({ page }) => {
    await page.setViewportSize({ width: 1500, height: 820 });
    await installKurloBridge(page);
    await page.addInitScript(() => localStorage.setItem('kurlo.responseLayout.v1', 'right'));
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await page.getByRole('button', { name: 'Provider and model' }).click();
    await page.getByRole('radio', { name: 'Ollama' }).click();
    await page.getByLabel('Model', { exact: true }).fill('openai/gpt-4o-mini-2024-07-18-extended-preview-with-a-very-long-name');
    await page.keyboard.press('Enter');
    await fillCodeEditor(page, 'ai-prompt-editor', 'Do I need an umbrella in Lisbon tomorrow?');
    await page.getByRole('button', { name: 'Send', exact: true }).click();
    const bar = page.locator('.ai-panel .response-status-bar');
    await expect(bar.locator('.status-badge')).toContainText('200');
    const layout = await bar.evaluate(el => {
      const right = el.getBoundingClientRect().right - parseFloat(getComputedStyle(el).paddingRight);
      const box = (selector: string) => el.querySelector(selector)!.getBoundingClientRect();
      const model = el.querySelector('.ai-model-name') as HTMLElement;
      return {
        badgeFits: box('.status-badge').right <= right + 0.5,
        newChatFits: box('.ai-new-chat').right <= right + 0.5,
        modelTruncated: model.scrollWidth > model.clientWidth,
        modelBeforeMetrics: box('.ai-model-name').right <= box('.ai-metrics').left,
        metricsFit: (el.querySelector('.ai-metrics') as HTMLElement).scrollWidth <= (el.querySelector('.ai-metrics') as HTMLElement).clientWidth,
      };
    });
    expect(layout).toEqual({ badgeFits: true, newChatFits: true, modelTruncated: true, modelBeforeMetrics: true, metricsFit: true });
    await bar.screenshot({ path: test.info().outputPath('status.png') });
  });

  test('keeps the token visibility button clear of the token text', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await page.getByRole('tab', { name: /Auth/ }).click();
    await page.getByLabel('Auth type').click();
    await page.getByRole('option', { name: 'Bearer Token' }).click();
    const input = page.locator('#bearer-token');
    await input.fill('x'.repeat(200));
    const [field, button] = await Promise.all([input.evaluate(el => {
      const rect = el.getBoundingClientRect();
      return rect.right - parseFloat(getComputedStyle(el).paddingRight);
    }), page.getByRole('button', { name: 'Show token' }).boundingBox()]);
    expect(field).toBeLessThanOrEqual(button!.x + 0.5);
  });

  test('explains why the model list could not be loaded', async ({ page }) => {
    if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await page.getByRole('button', { name: 'Provider and model' }).click();
    await page.getByRole('radio', { name: 'Ollama' }).click();
    await page.keyboard.press('Escape');
    await page.getByLabel('Provider base URL').fill('https://no-models.kurlo.test/v1?key=secret');
    await page.getByRole('button', { name: 'Provider and model' }).click();
    const problem = page.locator('.ai-model-problem');
    await expect(problem).toBeVisible();
    await expect(problem.locator('.ai-model-problem-title')).toHaveText('This server has no model list');
    await expect(problem.locator('.ai-model-problem-status')).toHaveText('404 Not Found');
    await expect(problem.locator('.ai-model-problem-detail')).toHaveText('404 Not FoundGET https://no-models.kurlo.test/v1/models');
    await expect(problem).not.toContainText('secret');
    await expect(problem.locator('.ai-model-problem-hint')).toContainText('type the model name');
    const before = await page.evaluate(() => window.__kurloE2E.sentRequests.length);
    await problem.getByRole('button', { name: 'Try again' }).click();
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.sentRequests.length)).toBe(before + 1);
    await page.getByLabel('Model', { exact: true }).fill('my-model');
    await page.keyboard.press('Enter');
    await expect(page.getByRole('button', { name: 'Provider and model' })).toContainText('my-model');
  });

  test('opens a new MCP server from the AI tools tab as a draft that is dropped when closed unsaved', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'AI Request');
    await page.getByRole('tab', { name: /Tools/ }).click();
    const before = await page.evaluate(() => window.__kurloE2E.store.requests.length);
    await page.getByRole('button', { name: 'New MCP request' }).click();
    await expect(page.getByLabel('Method and protocol')).toContainText('MCP');
    await clickTabClose(page.locator('.saved-request-tab.active').getByRole('button', { name: 'Close tab' }));
    await expect(page.getByLabel('Method and protocol')).toContainText('AI');
    await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests.filter((request: { requestType?: string; isDraft?: boolean }) => request.requestType === 'mcp' && !request.isDraft).length)).toBe(0);
    expect(await page.evaluate(() => window.__kurloE2E.store.requests.length)).toBeLessThanOrEqual(before);
  });
});
