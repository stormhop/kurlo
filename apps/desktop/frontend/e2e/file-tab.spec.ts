import { expect, test, type Page } from '@playwright/test';
import { reviewShot } from './support/reviewShot';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { SavedRequest } from '../src/lib/types/models';
import type { RequestFileYAMLResult } from '../src/lib/wire';
import { installKurloBridge, type E2EWindow } from './support/bridge';
import { chooseRequestSection, chooseRequestType, clickTabClose, collectionRow, fillCodeEditor } from './support/actions';
import { DOCS_VIEWPORT, docsScreenshotDir } from './support/config';
import { captureDocsScreenshot } from './support/screenshots';

const requests: SavedRequest[] = [
  { id: 'file-one', name: 'One', collectionId: 'file-collection', collection: 'Core API', requestType: 'http', method: 'GET', url: 'https://one.kurlo.test' } as SavedRequest,
  { id: 'file-two', name: 'Two', collectionId: 'file-collection', collection: 'Core API', requestType: 'http', method: 'GET', url: 'https://two.kurlo.test' } as SavedRequest,
];

type RequestFileResult = Partial<RequestFileYAMLResult>;

type RequestFileApi = {
  LoadWorkspace: () => Promise<{ root?: string; payload?: string; diagnostics?: unknown[]; revision?: number }>;
  GetRequestFileYAML: (root: string, id: string, pathHint: string) => Promise<RequestFileResult>;
  SaveRequestFileYAML: (root: string, id: string, content: string, revision: string, pathHint: string) => Promise<RequestFileResult>;
  FormatRequestFileYAML: (content: string) => Promise<RequestFileResult>;
  CheckWorkspaceYAML: (path: string, content: string) => Promise<{ ok: boolean; line: number; message: string }>;
};

type RequestFileE2EState = {
  store: { requests: SavedRequest[] };
  calls: string[];
  requestFileConflicts?: string[];
  requestFileExternallyEdit?: (id: string, url: string) => void;
  requestFileLastSaved?: { id: string; content: string };
};

function starterStore(activeId = 'file-one', withRequests = true) {
  return {
    version: 2,
    activeId,
    activeWorkspaceId: 'workspace-e2e',
    activeEnvironmentId: '',
    openIds: withRequests ? requests.map(request => request.id) : [],
    workspaces: [{ id: 'workspace-e2e', name: 'E2E Workspace', filesystemName: 'E2E-Workspace', description: '' }],
    collections: [{ id: 'file-collection', workspaceId: 'workspace-e2e', name: 'Core API' }],
    environments: [],
    requests: withRequests ? requests : [],
    history: [],
  };
}

async function installRequestFileBridge(page: Page, conflicts: string[] = [], lineEnding = '\n') {
  await page.addInitScript(({ conflictIds, fileLineEnding }) => {
    const state = window.__kurloE2E as RequestFileE2EState;
    const app = (window as unknown as E2EWindow).go.api.App as unknown as RequestFileApi;
    const loadWorkspace = app.LoadWorkspace;
    const disk = new Map<string, { path: string; content: string; revision: string }>();
    state.requestFileConflicts = [...conflictIds];
    state.requestFileExternallyEdit = (id, url) => {
      const file = disk.get(id);
      if (!file) return;
      file.content = file.content.replace(/^\s+url:.*$/m, `  url: ${url}`);
      file.revision = `r${Number(file.revision.slice(1)) + 1}`;
    };

    function request(id: string) {
      return state.store.requests.find(item => item.id === id);
    }

    function format(content: string) {
      return content.replace(/^ {2}(?=\S)/gm, '    ');
    }

    function currentFile(id: string) {
      const existing = disk.get(id);
      if (existing) return existing;
      const item = request(id);
      if (!item) return null;
      const path = `workspaces/E2E-Workspace/collections/Core-API/requests/${item.name}.yml`;
      const content = [
        'version: 1',
        'request:',
        `  id: ${id}`,
        `  name: ${JSON.stringify(item.name)}`,
        `  requestType: ${item.requestType}`,
        `  method: ${JSON.stringify(item.method)}`,
        `  url: ${item.url}`,
        '',
      ].join(fileLineEnding);
      const file = { path, content: format(content), revision: 'r1' };
      disk.set(id, file);
      return file;
    }

    function scalar(content: string, key: string) {
      const match = new RegExp(`^\\s+${key}:\\s*(.*)$`, 'm').exec(content);
      if (!match) return undefined;
      const value = match[1].trim();
      if (value.startsWith('"')) {
        const quoted = /^"(?:\\.|[^"\\])*"/.exec(value)?.[0];
        try { return quoted ? JSON.parse(quoted) : value; } catch { return value; }
      }
      if (value.startsWith("'")) {
        const quoted = /^'(?:[^']|'')*'/.exec(value)?.[0];
        return quoted ? quoted.slice(1, -1).replace(/''/g, "'") : value;
      }
      return value.replace(/\s+#.*$/, '').trim();
    }

    const failure = (id: string, error: string, extras: RequestFileResult = {}): RequestFileResult => ({ ok: false, id, error, ...extras });

    app.LoadWorkspace = async () => ({ ...(await loadWorkspace()), root: '/workspace' });
    app.GetRequestFileYAML = async (_root, id, _pathHint) => {
      state.calls.push(`request-file-read:${id}`);
      const file = currentFile(id);
      return file ? { ok: true, id, ...file } : failure(id, 'Request not found');
    };
    app.FormatRequestFileYAML = async content => {
      state.calls.push('request-file-format');
      return { ok: true, content: format(content) };
    };
    app.CheckWorkspaceYAML = async (_path, content) => {
      state.calls.push('request-file-check');
      if (content.includes('isPinned: nope')) return { ok: false, line: 7, message: 'request.isPinned: Use true or false without quotes.' };
      return content.includes('url: [')
        ? { ok: false, line: 6, message: 'Invalid URL value' }
        : { ok: true, line: 0, message: '' };
    };
    app.SaveRequestFileYAML = async (_root, id, content, revision, _pathHint) => {
      state.calls.push(`request-file-save:${id}:${revision}`);
      const file = currentFile(id);
      if (!file) return failure(id, 'Request not found');
      if (content.includes('url: [')) return failure(id, 'Invalid YAML', { path: file.path, line: 6 });
      if (state.requestFileConflicts?.includes(id)) {
        state.requestFileConflicts = state.requestFileConflicts.filter(item => item !== id);
        file.content = content.replace(/url:.*$/m, 'url: https://external.kurlo.test');
        file.revision = 'r2';
        return failure(id, 'File changed outside the editor', { path: file.path, content: file.content, revision: file.revision, conflict: true });
      }
      if (revision !== file.revision) return failure(id, 'File changed outside the editor', { conflict: true, path: file.path, content: file.content, revision: file.revision });
      const item = request(id);
      if (!item) return failure(id, 'Request not found');
      content = format(content);
      const url = scalar(content, 'url') ?? item.url;
      const method = scalar(content, 'method') ?? item.method;
      const requestType = scalar(content, 'requestType') ?? item.requestType;
      const name = scalar(content, 'name') ?? item.name;
      const updated: SavedRequest = { ...item, name, url, requestType: requestType as SavedRequest['requestType'], method: method as SavedRequest['method'] };
      state.store.requests = state.store.requests.map(candidate => candidate.id === id ? updated : candidate);
      file.content = content;
      state.requestFileLastSaved = { id, content };
      file.revision = `r${Number(file.revision.slice(1)) + 1}`;
      return { ok: true, id, path: file.path, content, revision: file.revision, requestJson: JSON.stringify(updated) };
    };
  }, { conflictIds: conflicts, fileLineEnding: lineEnding });
}

async function openSeededFileTab(page: Page, conflicts: string[] = [], lineEnding = '\n') {
  await installKurloBridge(page, '', 'darwin/e2e', false, {
    ...starterStore(),
  });
  await installRequestFileBridge(page, conflicts, lineEnding);
  await page.goto('/');
  await expect(page.locator('.request-composer')).toBeVisible();
  await chooseRequestSection(page, 'File');
  await expect(page.getByTestId('request-file-editor')).toBeVisible();
}

test('captures the File tab with a saved request YAML for the docs', async ({ page }) => {
  if (docsScreenshotDir) await page.setViewportSize(DOCS_VIEWPORT);
  await installKurloBridge(page, '', 'darwin/e2e', false, starterStore());
  await installRequestFileBridge(page);
  await page.addInitScript(() => {
    const app = (window as unknown as E2EWindow).go.api.App as unknown as RequestFileApi;
    const content = [
      'version: 1',
      'request:',
      '    auth:',
      '        bearerToken: "{{token}}"',
      '        type: bearer',
      '    collectionId: file-collection',
      '    headers:',
      '        - key: Accept',
      '          value: application/json',
      '    id: file-one',
      '    method: GET',
      '    name: One',
      '    params:',
      '        - key: limit',
      '          value: "20"',
      '    requestType: http',
      '    url: https://one.kurlo.test/users',
      '',
    ].join('\n');
    app.GetRequestFileYAML = async (_root, id) => ({ ok: true, id, path: 'workspaces/E2E-Workspace/collections/Core-API/requests/One.yml', content, revision: 'docs-r1' });
  });
  await page.goto('/');
  await expect(page.locator('.request-composer')).toBeVisible();
  await chooseRequestSection(page, 'File');
  await expect(page.getByTestId('request-file-editor').locator('.cm-content')).toContainText('https://one.kurlo.test/users');
  await expect(page.locator('.file-tab-saved')).toHaveText('Saved');
  const divider = page.getByRole('button', { name: 'Resize panels' });
  const box = await divider.boundingBox();
  if (box) {
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.mouse.move(box.x + box.width / 2, box.y + 200, { steps: 5 });
    await page.mouse.up();
  }
  await expect(page.getByTestId('request-file-editor').locator('.cm-line', { hasText: 'url: https://one.kurlo.test/users' })).toBeInViewport();
  await captureDocsScreenshot(page, 'request-file-tab');
});

test('places File before Settings in wide and compact tabs and wraps long tokens while preserving CRLF', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSeededFileTab(page, [], '\r\n');
  const tabList = page.locator('.request-editor-tabs-shell .tab-bar');
  const wideLabels = await tabList.getByRole('tab').allTextContents();
  expect(wideLabels.map(label => label.trim()).indexOf('File')).toBe(wideLabels.map(label => label.trim()).indexOf('Settings') - 1);

  await page.getByLabel('Show the response beside the request').click();
  const shell = page.locator('.request-editor-tabs-shell');
  await expect(shell).toHaveClass(/compact/);
  await shell.getByRole('button', { name: 'Request section' }).click();
  const compactLabels = await shell.getByRole('option').allTextContents();
  const compactOrder = compactLabels.map(label => label.replace(/^\s*✓\s*/, '').trim());
  expect(compactOrder.indexOf('File')).toBe(compactOrder.indexOf('Settings') - 1);
  await shell.getByRole('option', { name: /File/ }).click();

  const longToken = `https://wrapped.kurlo.test/${'x'.repeat(2400)}`;
  const content = `version: 1\nrequest:\n  id: file-one\n  name: "One"\n  method: GET\n  url: ${longToken}\n`;
  await fillCodeEditor(page, 'request-file-editor', content);
  const scroller = page.getByTestId('request-file-editor').locator('.cm-scroller');
  const urlLine = page.getByTestId('request-file-editor').locator('.cm-line').filter({ hasText: longToken });
  await expect.poll(async () => {
    const bounds = await urlLine.boundingBox();
    return bounds?.height ?? 0;
  }).toBeGreaterThan(24);
  await expect.poll(() => scroller.evaluate(element => element.scrollWidth - element.clientWidth)).toBeLessThanOrEqual(2);
  await page.locator('.file-tab').getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window.__kurloE2E as RequestFileE2EState).requestFileLastSaved?.content ?? '')).toBe(content.replace(/^ {2}/gm, '    ').replace(/\n/g, '\r\n'));
  await reviewShot(page, { path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), `file-tab-wrap-order-${test.info().project.name}.png`), animations: 'disabled' });
});

test('clears reverted URL edits and keeps a formatted file clean before and after saving', async ({ page }) => {
  await openSeededFileTab(page, [], '\r\n');
  const file = page.locator('.file-tab');
  const save = file.getByRole('button', { name: 'Save', exact: true });
  const revert = file.getByRole('button', { name: 'Revert', exact: true });
  const beautify = file.getByRole('button', { name: 'Beautify', exact: true });
  const url = page.getByLabel('Request URL');
  const lines = page.getByTestId('request-file-editor').locator('.cm-line');
  const original = (await lines.allTextContents()).join('\n');

  await beautify.click();
  await expect(beautify).toBeEnabled();
  await expect(revert).toBeDisabled();
  await url.focus();
  await url.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await url.pressSequentially('x');
  await expect(save).toBeEnabled();
  await url.press('Backspace');
  await expect(file.locator('.file-tab-saved')).toBeVisible();
  await expect(save).toBeDisabled();
  await expect(revert).toBeDisabled();
  expect((await lines.allTextContents()).join('\n')).toBe(original);
  expect(await page.evaluate(() => window.__kurloE2E.calls.some(call => call.startsWith('request-file-save:')))).toBe(false);
  await chooseRequestSection(page, 'Params');
  await expect(file).toHaveCount(0);
  await chooseRequestSection(page, 'File');
  await expect(file.locator('.file-tab-saved')).toBeVisible();

  const edited = '# keep my edit\n' + original.replace(/^ {4}/gm, '  ');
  await fillCodeEditor(page, 'request-file-editor', edited);
  await url.fill('https://one.kurlo.test/x');
  await url.fill('https://one.kurlo.test');
  await expect(revert).toBeEnabled();
  expect((await lines.allTextContents()).join('\n')).toBe(edited);
  await save.click();
  await expect(file.locator('.file-tab-saved')).toBeVisible();
  expect((await lines.allTextContents()).join('\n')).toBe('# keep my edit\n' + original);
  await beautify.click();
  await expect(beautify).toBeEnabled();
  await expect(save).toBeDisabled();
  await expect(revert).toBeDisabled();
});

test('saves a newly created request file from the File tab and updates the request', async ({ page }, testInfo) => {
  await installKurloBridge(page, '', 'darwin/e2e', false, starterStore('', false));
  await installRequestFileBridge(page);
  await page.goto('/');
  await collectionRow(page, 'Core API').getByLabel('Collection menu').click();
  await collectionRow(page, 'Core API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
  await chooseRequestType(page, 'HTTP Request');
  await page.getByLabel('Request name').fill('Created in editor');
  await page.getByLabel('Request URL').fill('https://created.kurlo.test');
  await chooseRequestSection(page, 'File');
  await page.getByRole('button', { name: 'Save request', exact: true }).click();
  const editor = page.getByTestId('request-file-editor').locator('.cm-content');
  await expect(editor).toContainText('https://created.kurlo.test');
  const yaml = await editor.innerText();
  await fillCodeEditor(page, 'request-file-editor', yaml.replace('https://created.kurlo.test', 'https://updated.kurlo.test'));
  await page.keyboard.press('ControlOrMeta+f');
  const searchInput = page.getByRole('textbox', { name: 'Find', exact: true });
  await expect(searchInput).toBeFocused();
  await searchInput.fill('https://updated');
  await page.keyboard.press('Escape');
  await expect(page.locator('.cm-search')).toHaveCount(0);
  await expect(page.getByTestId('request-file-editor').locator('.cm-content')).toBeFocused();
  await page.locator('.file-tab').getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests.find(request => request.name === 'Created in editor')?.url)).toBe('https://updated.kurlo.test');
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls.some(call => call.startsWith('request-file-save:')))).toBe(true);
  await reviewShot(page, { path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), `file-tab-created-${testInfo.project.name}.png`), animations: 'disabled' });
});

test('saves the file with Cmd+S and synchronizes its request fields', async ({ page }) => {
  await openSeededFileTab(page);
  await fillCodeEditor(page, 'request-file-editor', 'version: 1\nrequest:\n  id: file-one\n  name: "One"\n  method: GET\n  url: https://edited.kurlo.test\n');
  await page.keyboard.press('Meta+S');
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests.find(request => request.id === 'file-one')?.url)).toBe('https://edited.kurlo.test');
});

test('keeps the request bar and YAML in sync while editing URL, method, protocol, and gRPC fields', async ({ page }, testInfo) => {
  await openSeededFileTab(page);
  const file = page.locator('.file-tab');
  const editor = page.getByTestId('request-file-editor');
  const urlLine = () => editor.locator('.cm-line').filter({ hasText: 'keep URL note' });
  const methodLine = () => editor.locator('.cm-line').filter({ hasText: /^\s*method:/ });
  const url = page.getByLabel('Request URL');
  const method = page.getByRole('button', { name: 'Method and protocol' });
  const startingYaml = 'version: 1\n# keep this comment\nrequest:\n  id: file-one\n  name: "One"\n  requestType: "http"\n  method: "GET"\n  url: "https://one.kurlo.test" # keep URL note\n';
  await fillCodeEditor(page, 'request-file-editor', startingYaml);
  await expect(url).toHaveValue('https://one.kurlo.test');
  await url.fill('https://toolbar.kurlo.test/path');
  await expect(urlLine()).toContainText('url: "https://toolbar.kurlo.test/path" # keep URL note');
  await method.click();
  await page.getByRole('option', { name: 'PATCH', exact: true }).click();
  await expect(methodLine()).toContainText('method: "PATCH"');

  const editedFromFile = startingYaml.replace('https://one.kurlo.test', 'https://yaml.kurlo.test/next').replace('"GET"', '"PATCH"');
  await fillCodeEditor(page, 'request-file-editor', editedFromFile);
  await expect(url).toHaveValue('https://yaml.kurlo.test/next');
  await method.click();
  await page.getByRole('option', { name: 'DELETE', exact: true }).click();
  await expect(urlLine()).toContainText('url: "https://yaml.kurlo.test/next" # keep URL note');
  await expect(editor.locator('.cm-line').filter({ hasText: 'keep this comment' })).toContainText('# keep this comment');
  await expect(methodLine()).toContainText('method: "DELETE"');

  await method.click();
  await expect(page.getByText('The protocol is fixed once a saved request has a URL.', { exact: false })).toBeVisible();
  await expect(page.getByRole('option', { name: 'gRPC', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await fillCodeEditor(page, 'request-file-editor', editedFromFile.replace('"PATCH"', '"POST"').replace('requestType: "http"', 'requestType: "grpc"'));
  const target = page.getByLabel('gRPC target');
  const grpcMethod = page.getByLabel('gRPC method');
  await expect(target).toHaveValue('https://yaml.kurlo.test/next');
  await target.fill('localhost:50051');
  await grpcMethod.fill('/inventory.v1.Inventory/GetItem');
  await expect(editor.locator('.cm-line').filter({ hasText: 'requestType:' })).toContainText('requestType: "grpc"');
  await expect(methodLine()).toContainText('method: "POST"');
  await expect(urlLine()).toContainText('url: "localhost:50051" # keep URL note');
  await expect(editor.locator('.cm-line').filter({ hasText: 'grpcMethod:' })).toContainText('grpcMethod: "/inventory.v1.Inventory/GetItem"');
  await file.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => {
    const request = window.__kurloE2E.store.requests.find(item => item.id === 'file-one');
    return [request?.name, request?.requestType, request?.method, request?.url].join('|');
  })).toBe('One|grpc|POST|localhost:50051');
  await expect.poll(() => page.evaluate(() => (window.__kurloE2E as RequestFileE2EState).requestFileLastSaved?.content ?? '')).toContain('grpcMethod: "/inventory.v1.Inventory/GetItem"');
  await reviewShot(page, { path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), `file-tab-request-bar-sync-${testInfo.project.name}.png`), animations: 'disabled' });

  await target.fill('localhost:50052');
  await expect(urlLine()).toContainText('localhost:50052');
  await file.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(target).toHaveValue('localhost:50051');
  await expect(grpcMethod).toHaveValue('/inventory.v1.Inventory/GetItem');
  await target.fill('localhost:50053');
  await page.keyboard.press('ControlOrMeta+z');
  await expect(target).toHaveValue('localhost:50051');
  await expect(urlLine()).toContainText('url: "localhost:50051" # keep URL note');
});

test('switches File to AI from YAML and reverts to HTTP', async ({ page }) => {
  await openSeededFileTab(page);
  const editor = page.getByTestId('request-file-editor');
  const file = page.locator('.file-tab');
  const protocol = page.getByRole('button', { name: 'Method and protocol' });
  const yaml = 'version: 1\nrequest:\n  id: file-one\n  name: "One"\n  requestType: "ai"\n  url: "https://one.kurlo.test"\n';
  await fillCodeEditor(page, 'request-file-editor', yaml);
  await expect(page.getByLabel('Provider base URL')).toHaveValue('https://one.kurlo.test');

  await page.getByRole('button', { name: 'Provider and model' }).click();
  const picker = page.getByRole('dialog', { name: 'Provider and model' });
  await picker.getByRole('radio', { name: 'Anthropic' }).click();
  await expect(page.getByLabel('Provider base URL')).toHaveValue('https://api.anthropic.com/v1');
  await picker.getByLabel('Model').fill('claude-3-5-haiku-latest');
  await page.keyboard.press('Escape');
  await expect(editor.locator('.cm-line').filter({ hasText: /^\s*requestType:/ })).toContainText('requestType: "ai"');
  await expect(editor.locator('.cm-line').filter({ hasText: /^\s*aiProvider:/ })).toContainText('aiProvider: "anthropic"');
  await expect(editor.locator('.cm-line').filter({ hasText: /^\s*aiModel:/ })).toContainText('aiModel: "claude-3-5-haiku-latest"');

  await protocol.click();
  await expect(page.getByRole('option', { name: 'GET', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');

  await file.getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(page.getByLabel('Method and protocol')).toContainText('GET');
  await expect(page.getByLabel('Request URL')).toHaveValue('https://one.kurlo.test');
  await expect(editor.locator('.cm-line').filter({ hasText: /^\s*requestType:/ })).toContainText('requestType: http');
  await expect(editor.locator('.cm-line').filter({ hasText: /^\s*aiProvider:/ })).toHaveCount(0);
});

test('updates the toolbar from a large YAML draft and keeps subsequent edits in sync', async ({ page }) => {
  await openSeededFileTab(page);
  const body = ('    ' + 'text '.repeat(110) + '\n').repeat(520);
  await fillCodeEditor(page, 'request-file-editor', 'version: 1\nrequest:\n  id: file-one\n  url: https://large.test/first\n  name: Large request\n  bodyContent: |-\n' + body);
  const url = page.getByLabel('Request URL');
  await expect(url).toHaveValue('https://large.test/first');
  await url.fill('{{baseUrl}}/large');
  await page.getByLabel('Request name').fill('Edited large request');
  await url.focus();
  await url.press(process.platform === 'darwin' ? 'Meta+ArrowRight' : 'End');
  await url.pressSequentially('/items');
  await page.locator('.file-tab').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.file-tab-saved')).toBeVisible();
  const saved = await page.evaluate(() => (window.__kurloE2E as RequestFileE2EState).requestFileLastSaved?.content ?? '');
  expect(saved).toContain('url: "{{baseUrl}}/large/items"');
  expect(saved).toContain('name: "Edited large request"');
  expect(saved.endsWith(body)).toBe(true);
});

test('rejects an ambiguous URL edit and restores the toolbar value with an explanation', async ({ page }) => {
  await openSeededFileTab(page);
  const editor = page.getByTestId('request-file-editor');
  const url = page.getByLabel('Request URL');
  const ambiguous = 'version: 1\nrequest:\n  id: file-one\n  name: "One"\n  requestType: "http"\n  method: "GET"\n  url: "https://first.kurlo.test"\n  url: "https://second.kurlo.test"\n';
  await fillCodeEditor(page, 'request-file-editor', ambiguous);
  await expect(url).toHaveValue('https://one.kurlo.test');
  await url.fill('https://must-not-appear.kurlo.test');
  await expect(page.locator('.file-tab').getByRole('alert')).toContainText('url field is duplicated');
  await expect(url).toHaveValue('https://one.kurlo.test');
  await expect(editor.locator('.cm-line').filter({ hasText: 'url:' })).toHaveCount(2);
  await expect(editor).not.toContainText('must-not-appear.kurlo.test');
});

test('explains managed fields and keeps the saved request ID during a paste', async ({ page }) => {
  await openSeededFileTab(page);
  const file = page.getByTestId('request-file-editor');
  const id = file.locator('.cm-kurlo-managed-field').filter({ hasText: 'id: file-one' }).first();
  await expect(id).toHaveAttribute('title', /Managed by Kurlo/);
  const original = await file.locator('.cm-content').innerText();
  const viewport = await file.locator('.cm-scroller').boundingBox();
  await fillCodeEditor(page, 'request-file-editor', original.replace('id: file-one', 'id: another'));
  await expect(page.locator('.file-tab-managed-hint')).toContainText('id links this request');
  expect(await file.locator('.cm-scroller').boundingBox()).toEqual(viewport);
  await expect(file.locator('.cm-content')).toContainText('id: file-one');
  await expect(page.locator('.file-tab').getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await fillCodeEditor(page, 'request-file-editor', original.replace('https://one.kurlo.test', 'https://edited.kurlo.test'));
  await expect(page.locator('.file-tab-managed-hint')).toHaveCount(0);
  await expect(file.locator('.cm-content')).toContainText('https://edited.kurlo.test');
});

test('shows the disk version on conflict and reloads its latest content', async ({ page }) => {
  await openSeededFileTab(page, ['file-one']);
  await fillCodeEditor(page, 'request-file-editor', 'version: 1\nrequest:\n  id: file-one\n  name: "One"\n  method: GET\n  url: https://local.kurlo.test\n');
  await page.locator('.file-tab').getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.file-tab-conflict')).toContainText('This file changed on disk');
  await page.getByText('View version on disk').click();
  const diskVersion = page.locator('.file-tab-disk-version pre');
  await expect(diskVersion).toContainText('https://external.kurlo.test');
  await diskVersion.selectText();
  await expect.poll(() => page.evaluate(() => window.getSelection()?.toString() ?? '')).toContain('https://external.kurlo.test');
  await page.evaluate(() => (window.__kurloE2E as RequestFileE2EState).requestFileExternallyEdit?.('file-one', 'https://latest.kurlo.test'));
  await page.getByRole('button', { name: 'Reload from disk' }).click();
  await expect(page.getByTestId('request-file-editor').locator('.cm-content')).toContainText('https://latest.kurlo.test');
  await expect(page.locator('.file-tab-dirty')).toHaveCount(0);
});

test('keeps File controls inside a narrow side-by-side request panel', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 1280, height: 800 });
  await openSeededFileTab(page);
  await page.getByLabel('Show the response beside the request').click();
  const requestPanel = page.locator('.request-editor');
  await expect.poll(() => requestPanel.evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(544);
  const toolbar = page.locator('.file-tab-toolbar');
  await expect.poll(() => toolbar.evaluate(element => getComputedStyle(element).flexDirection)).toBe('column');
  const toolbarBounds = await toolbar.boundingBox();
  const actionBounds = await page.locator('.file-tab-actions').boundingBox();
  if (!toolbarBounds || !actionBounds) throw new Error('File tab controls are not visible');
  expect(actionBounds.x + actionBounds.width).toBeLessThanOrEqual(toolbarBounds.x + toolbarBounds.width);
  await reviewShot(page, { path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), `file-tab-narrow-split-${testInfo.project.name}.png`), animations: 'disabled' });
});

test('retains invalid YAML across requests and reviews it before leaving or closing the file', async ({ page }) => {
  await openSeededFileTab(page);
  await fillCodeEditor(page, 'request-file-editor', 'version: 1\nrequest:\n  id: file-one\n  name: "One"\n  method: GET\n  url: [broken\n');
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls.includes('request-file-check'))).toBe(true);
  await expect(page.locator('.file-tab .cm-kurlo-issue-announcer')).toContainText('Invalid URL value');
  await expect(page.locator('.cm-lintRange-error').first()).toBeVisible();
  await expect(page.locator('.file-tab').getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.locator('.file-tab').getByRole('button', { name: 'Revert', exact: true }).click();
  await expect(page.getByTestId('request-file-editor').locator('.cm-content')).toContainText('https://one.kurlo.test');
  await expect(page.locator('.cm-lintRange-error')).toHaveCount(0);
  await fillCodeEditor(page, 'request-file-editor', 'version: 1\nrequest:\n  id: file-one\n  name: "One"\n  method: GET\n  url: [broken\n');
  await expect(page.locator('.cm-lintRange-error').first()).toBeVisible();
  await expect(page.locator('.file-tab').getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await page.locator('.saved-request-tab').filter({ hasText: 'Two' }).click();
  await expect(page.locator('.saved-request-tab.active .tab-title')).toHaveText('Two');
  await page.locator('.saved-request-tab').filter({ hasText: 'One' }).click();
  await expect(page.getByTestId('request-file-editor').locator('.cm-content')).toContainText('url: [broken');
  await expect(page.locator('.cm-lintRange-error').first()).toBeVisible();
  const paramsTab = page.locator('.request-editor-tabs-shell').getByRole('tab', { name: 'Params' });
  await paramsTab.click();
  const dialog = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByTestId('request-file-editor').locator('.cm-content')).toContainText('url: [broken');
  await expect(page.locator('.cm-lintRange-error').first()).toBeVisible();
  const activeRequestTab = page.locator('.saved-request-tab.active');
  await clickTabClose(activeRequestTab.getByLabel('Close tab'));
  const cancelCloseDialog = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(cancelCloseDialog).toBeVisible();
  await cancelCloseDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(cancelCloseDialog).toBeHidden();
  await expect(page.getByTestId('request-file-editor').locator('.cm-content')).toContainText('url: [broken');
  await clickTabClose(page.locator('.saved-request-tab.active').getByLabel('Close tab'));
  const closeDialog = page.getByRole('dialog', { name: 'Unsaved changes' });
  await expect(closeDialog).toBeVisible();
  await closeDialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(closeDialog).toBeHidden();
  await expect(page.getByTestId('request-file-editor').locator('.cm-content')).toContainText('url: [broken');
  await clickTabClose(page.locator('.saved-request-tab.active').getByLabel('Close tab'));
  await page.getByRole('dialog', { name: 'Unsaved changes' }).getByRole('button', { name: "Don't Save" }).click();
  await expect(page.locator('.saved-request-tab.active .tab-title')).toHaveText('Two');
});

test('checks edited fields before Save and formats the draft as one undoable edit', async ({ page }) => {
  await openSeededFileTab(page);
  const file = page.locator('.file-tab');
  const editor = page.getByTestId('request-file-editor').locator('.cm-content');
  const save = file.getByRole('button', { name: 'Save', exact: true });
  const initial = 'version: 1\nrequest:\n  id: file-one\n  name: "One"\n  method: GET\n  url: https://one.kurlo.test\n';
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.calls.filter(call => call === 'request-file-check').length)).toBe(0);
  const invalid = initial.trimEnd() + '\n  isPinned: nope\n';
  await fillCodeEditor(page, 'request-file-editor', invalid);
  const marked = file.locator('.cm-lintRange-error').first();
  await expect(marked).toContainText('isPinned');
  await expect(save).toBeDisabled();
  await marked.hover();
  await expect(page.locator('.cm-tooltip-lint .cm-diagnosticText')).toContainText('true or false');
  await expect(file.getByRole('alert')).toHaveCount(0);
  await reviewShot(page, { path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), `request-file-live-validation-${test.info().project.name}.png`), animations: 'disabled' });
  const valid = invalid.replace('isPinned: nope', 'isPinned: false');
  await fillCodeEditor(page, 'request-file-editor', valid);
  await expect(marked).toHaveCount(0);
  await expect(save).toBeEnabled();
  await file.getByRole('button', { name: 'Beautify', exact: true }).click();
  await expect.poll(() => editor.innerText()).toContain('\n    isPinned: false');
  await editor.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect.poll(() => editor.innerText()).toContain('\n  isPinned: false');
  await page.keyboard.press('Alt+Shift+f');
  await expect.poll(() => editor.innerText()).toContain('\n    isPinned: false');
  expect(await page.evaluate(() => window.__kurloE2E.calls.some(call => call.startsWith('request-file-save:')))).toBe(false);
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await save.click();
  await expect(save).toBeDisabled();
});

test('keeps a failed save visible and the draft in place for a retry', async ({ page }) => {
  await openSeededFileTab(page);
  const file = page.locator('.file-tab');
  const editor = page.getByTestId('request-file-editor');
  await page.evaluate(() => {
    const app = (window as unknown as E2EWindow).go.api.App as unknown as RequestFileApi;
    const save = app.SaveRequestFileYAML;
    app.SaveRequestFileYAML = async () => {
      app.SaveRequestFileYAML = save;
      return { ok: false, error: 'Could not write the request file' };
    };
  });
  const content = editor.locator('.cm-content');
  const changed = (await content.innerText()).replace('https://one.kurlo.test', 'https://edited.kurlo.test');
  await fillCodeEditor(page, 'request-file-editor', changed);
  const viewport = await editor.locator('.cm-scroller').boundingBox();
  const save = file.getByRole('button', { name: 'Save', exact: true });
  await save.click();
  await expect(file.getByRole('alert')).toContainText('Could not write');
  expect(await editor.locator('.cm-scroller').boundingBox()).toEqual(viewport);
  await expect(content).toContainText('https://edited.kurlo.test');
  await save.click();
  await expect(file.getByRole('alert')).toHaveCount(0);
  await expect(save).toBeDisabled();
  await expect.poll(() => page.evaluate(() => window.__kurloE2E.store.requests[0].url)).toBe('https://edited.kurlo.test');
});

test('remembers each request section locally across relaunch, including the legacy tab and File', async ({ page }) => {
  await installKurloBridge(page, '', 'darwin/e2e', false, {
    ...starterStore(),
    requests: requests.map((request, index) => ({ ...request, requestTab: index === 0 ? 'headers' : 'body' })),
  }, { preserveStorage: true });
  await installRequestFileBridge(page);
  await page.goto('/');
  const tabs = page.locator('.request-editor-tabs-shell');
  const open = page.locator('.saved-request-tabs');
  await expect(tabs.getByRole('tab', { name: 'Headers' })).toHaveAttribute('aria-selected', 'true');
  await chooseRequestSection(page, 'Settings');
  await open.getByRole('tab', { name: /Two/ }).click();
  await expect(tabs.getByRole('tab', { name: 'Body' })).toHaveAttribute('aria-selected', 'true');
  await open.getByRole('tab', { name: /One/ }).click();
  await expect(tabs.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
  await page.reload();
  await expect(tabs.getByRole('tab', { name: 'Settings' })).toHaveAttribute('aria-selected', 'true');
  const writes = () => page.evaluate(() => window.__kurloE2E.calls.filter(call => call === 'SaveRequestStore' || call.startsWith('request-file-save:')));
  const before = await writes();
  await chooseRequestSection(page, 'File');
  await expect(page.getByTestId('request-file-editor')).toBeVisible();
  await expect(page.locator('.saved-request-tab.active')).not.toHaveClass(/\bunsaved\b/);
  expect(await writes()).toEqual(before);
  await page.reload();
  await expect(page.getByTestId('request-file-editor')).toBeVisible();
  await clickTabClose(page.locator('.saved-request-tab.active').getByLabel('Close tab'));
  await page.locator('.collection-list .collection-request').filter({ hasText: 'One' }).click();
  await expect(page.getByTestId('request-file-editor')).toBeVisible();
});

test('completes YAML fields for the selected auth type without saving the draft', async ({ page }) => {
  await openSeededFileTab(page);
  const editor = page.getByTestId('request-file-editor').locator('.cm-content');
  const options = page.locator('.cm-tooltip-autocomplete .cm-completionLabel');
  const base = 'version: 1\nrequest:\n  id: file-one\n  name: "One"\n  method: GET\n  url: https://one.kurlo.test\n  ';
  await fillCodeEditor(page, 'request-file-editor', base);
  await page.keyboard.type('au');
  await page.getByRole('option', { name: 'auth', exact: true }).click({ timeout: 10_000 });
  await page.getByRole('option', { name: 'type', exact: true }).click({ timeout: 10_000 });
  await page.getByRole('option', { name: 'basic', exact: true }).click({ timeout: 10_000 });
  await expect(editor).toContainText('type: basic');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Space');
  await expect(options).toHaveText(['basicUser', 'basicPass']);
  await reviewShot(page, { path: join(process.env.KURLO_E2E_ARTIFACT_DIR ?? tmpdir(), `file-tab-auth-completion-${test.info().project.name}.png`), animations: 'disabled' });
  await page.getByRole('option', { name: 'basicUser', exact: true }).click({ timeout: 10_000 });
  await page.keyboard.type('user@example.test');
  await page.keyboard.press('Enter');
  await page.keyboard.press('Control+Space');
  await expect(options).toHaveText(['basicPass']);
  await page.keyboard.press('Escape');
  await expect(editor).toContainText('basicUser: user@example.test');
  expect(await page.evaluate(() => window.__kurloE2E.calls.some(call => call.startsWith('request-file-save:')))).toBe(false);
});

test('inserts typed YAML values in settings and header rows', async ({ page }) => {
  await openSeededFileTab(page);
  const editor = page.getByTestId('request-file-editor').locator('.cm-content');
  const base = 'version: 1\nrequest:\n  id: file-one\n  name: "One"\n  method: GET\n  url: https://one.kurlo.test\n';
  await fillCodeEditor(page, 'request-file-editor', base + '  settings:\n    httpVersion: ');
  await page.keyboard.press('Control+Space');
  await page.getByRole('option', { name: '2', exact: true }).click({ timeout: 10_000 });
  await expect(editor).toContainText('httpVersion: "2"');

  const releaseCheck = await page.evaluateHandle(() => {
    const app = (window as unknown as E2EWindow).go.api.App as unknown as RequestFileApi;
    const check = app.CheckWorkspaceYAML;
    let release!: () => void;
    const pending = new Promise<void>(resolve => { release = resolve; });
    app.CheckWorkspaceYAML = async (path, content) => {
      if (content.endsWith('enabled: fa')) {
        await pending;
        return { ok: false, line: 9, message: 'Use true or false without quotes.' };
      }
      return check(path, content);
    };
    return release;
  });
  await fillCodeEditor(page, 'request-file-editor', base + '  headers:\n    - key: X-Optional\n      enabled: ');
  await page.keyboard.type('fa');
  const disabled = page.getByRole('option', { name: 'false', exact: true });
  await expect(disabled).toBeVisible();
  const scroller = page.getByTestId('request-file-editor').locator('.cm-scroller');
  const viewport = await scroller.boundingBox();
  const option = await disabled.boundingBox();
  await releaseCheck.evaluate(release => release());
  const marked = editor.locator('.cm-lintRange-error').first();
  await expect(marked).toBeVisible();
  expect(await scroller.boundingBox()).toEqual(viewport);
  expect(await disabled.boundingBox()).toEqual(option);
  await page.keyboard.press('Enter');
  await expect(editor).toContainText('enabled: false');
  await expect(marked).toHaveCount(0);
  expect(await scroller.boundingBox()).toEqual(viewport);
  await releaseCheck.dispose();
});

test('completes an inline YAML mapping and preserves existing values when replacing a key', async ({ page }) => {
  await openSeededFileTab(page);
  const editor = page.getByTestId('request-file-editor').locator('.cm-content');
  const base = 'version: 1\nrequest:\n  id: file-one\n  name: "One"\n  method: GET\n  url: https://one.kurlo.test\n';
  await fillCodeEditor(page, 'request-file-editor', base + '  auth: {type: basic, }');
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Control+Space');
  await page.getByRole('option', { name: 'basicUser', exact: true }).click({ timeout: 10_000 });
  await page.keyboard.type('alice');
  await expect(editor).toContainText('auth: {type: basic, basicUser: alice}');

  await fillCodeEditor(page, 'request-file-editor', base + '  settings:\n    followRedirects: false # keep');
  for (let i = 0; i < 'lowRedirects: false # keep'.length; i++) await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('Control+Space');
  await page.getByRole('option', { name: 'followOriginalMethod', exact: true }).click({ timeout: 10_000 });
  await expect(editor).toContainText('followOriginalMethod: false # keep');
});

test('moves the File YAML caret with the deleted character', async ({ page }) => {
  await openSeededFileTab(page);
  const editor = page.getByTestId('request-file-editor');
  const content = editor.locator('.cm-content');
  const base = 'version: 1\nrequest:\n  id: file-one\n  name: "One"\n  method: GET\n  url: https://one.kurlo.test\n  headers:\n    - key: X-Note\n      value: ';
  await fillCodeEditor(page, 'request-file-editor', base);
  await page.keyboard.type('pm');
  await page.keyboard.press('Space');
  await page.keyboard.press('Backspace');
  await expect(content.locator('.cm-line').last()).toContainText('value: pm');
  const measurement = await editor.evaluateHandle(root => {
    const frame = new Promise(resolve => {
      root.addEventListener('keyup', () => requestAnimationFrame(() => {
        const line = root.querySelector('.cm-line:last-child')!;
        const text = document.createRange();
        const walker = document.createTreeWalker(line, NodeFilter.SHOW_TEXT);
        let lastTextNode: Text | null = null;
        while (walker.nextNode()) {
          if (walker.currentNode.textContent) lastTextNode = walker.currentNode as Text;
        }
        if (lastTextNode) {
          text.setStart(lastTextNode, lastTextNode.length);
          text.collapse(true);
        }
        const caret = root.querySelector('.cm-cursor-primary')?.getBoundingClientRect();
        resolve({
          text: line.textContent,
          aligned: !!lastTextNode && !!caret && Math.abs(caret.left - text.getBoundingClientRect().left) <= 1,
          nativeCaret: getComputedStyle(line).caretColor,
        });
      }), { once: true });
    });
    return { frame };
  });
  await page.keyboard.press('Backspace');
  expect(await measurement.evaluate(result => result.frame)).toEqual({
    text: '      value: p', aligned: true, nativeCaret: 'rgba(0, 0, 0, 0)',
  });
  await measurement.dispose();
});
