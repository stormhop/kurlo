import type { E2EWindow } from './support/bridge';
import { reviewShot } from './support/reviewShot';
import { chooseRequestSection, chooseRequestType, clickTabClose, collectionRow, fillCodeEditor, fillPrompt } from './support/actions';

import { installKurloBridge } from './support/bridge';

import { readmeScreenshotPath } from './support/config';

import { captureDocsScreenshot } from './support/screenshots';

import { expect, test, type Page } from '@playwright/test';

import { tmpdir } from 'node:os';

import { join } from 'node:path';

test.describe("Kurlo desktop browser E2E", () => {
  test('keeps the macOS titlebar compact with search moved to the status bar', async ({ page }) => {
    await page.setViewportSize({ width: 1024, height: 800 });
    await installKurloBridge(page, '', 'darwin/e2e');
    await page.goto('/');

    await page.getByLabel('New unsaved request').click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Code snippet', { exact: true }).click();
    await expect(page.locator('.code-snippet-panel')).toBeVisible();
    await expect.poll(() => page.locator('.code-snippet-panel').evaluate(panel => panel.getAnimations().length)).toBe(0);
    const toolbarOpenFrames = await page.locator('.searchbar-right').evaluate((actions) => new Promise<number[]>((resolve) => {
      const frames: number[] = [];
      const sample = () => {
        frames.push(actions.getBoundingClientRect().x);
        if (frames.length >= 8) {
          resolve(frames);
          return;
        }
        requestAnimationFrame(sample);
      };
      requestAnimationFrame(sample);
    }));
    expect(Math.max(...toolbarOpenFrames) - Math.min(...toolbarOpenFrames)).toBeLessThanOrEqual(0.1);
    await expect(page.locator('.workspace-searchbar .status-search-btn')).toHaveCount(0);
    await expect(page.locator('.status-bar-right .status-search-btn')).toBeVisible();
    await expect(page.locator('.status-search-label')).toHaveText('Search');
    await expect(page.locator('.status-search-btn .keycaps')).toHaveCount(0);

    const tabStrip = page.locator('.request-tab-strip');
    const savedTabs = page.locator('.saved-request-tabs');
    const overviewTab = page.getByRole('tab', { name: 'Overview' });
    const newRequestButton = page.getByLabel('New unsaved request');
    for (let index = 0; index < 2; index += 1) {
      await newRequestButton.click();
      await chooseRequestType(page, 'HTTP Request');
    }
    await expect(tabStrip).toHaveCSS('border-top-style', 'none');
    await expect(tabStrip).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(overviewTab).toHaveText('Overview');
    await expect.poll(async () => overviewTab.evaluate((tab) => tab.closest('.saved-request-tabs') !== null)).toBe(true);
    await expect.poll(async () => savedTabs.evaluate((tabs) => tabs.scrollWidth > tabs.clientWidth)).toBe(true);
    await savedTabs.evaluate((tabs) => {
      tabs.scrollLeft = tabs.scrollWidth;
    });
    await expect.poll(async () => savedTabs.evaluate((tabs) => {
      const overview = tabs.querySelector<HTMLElement>('.overview-request-tab');
      if (!overview) return false;
      return overview.getBoundingClientRect().right <= tabs.getBoundingClientRect().left;
    })).toBe(true);
    await expect.poll(async () => tabStrip.evaluate((strip) => {
      const tabs = strip.querySelector<HTMLElement>('.saved-request-tabs');
      const create = strip.querySelector<HTMLElement>('.new-request-tab-btn');
      if (!tabs || !create) return false;
      const stripBox = strip.getBoundingClientRect();
      const tabsBox = tabs.getBoundingClientRect();
      const createBox = create.getBoundingClientRect();
      return tabsBox.right <= createBox.left
        && createBox.right <= stripBox.right
        && createBox.width >= 28;
    })).toBe(true);
    await page.mouse.move(0, 0);
    await expect(newRequestButton).toHaveCSS('border-left-color', 'rgba(0, 0, 0, 0)');
    await expect(newRequestButton).toHaveCSS('border-radius', '6px');

    await page.setViewportSize({ width: 900, height: 800 });
    await expect(page.locator('.status-search-label')).toBeVisible();

    const toolbarButtons = page.locator('.searchbar-right > .save-btn, .searchbar-right > .searchbar-settings-btn');
    const toolbarButtonCount = await toolbarButtons.count();
    const toolbarGeometry = async () => toolbarButtons.evaluateAll((buttons) => buttons.map((button) => {
      const buttonBox = button.getBoundingClientRect();
      const iconBox = button.querySelector('svg')?.getBoundingClientRect();
      return {
        buttonX: buttonBox.x,
        buttonY: buttonBox.y,
        buttonWidth: buttonBox.width,
        buttonHeight: buttonBox.height,
        iconX: iconBox?.x ?? 0,
        iconY: iconBox?.y ?? 0,
        iconWidth: iconBox?.width ?? 0,
        iconHeight: iconBox?.height ?? 0,
      };
    }));
    const toolbarBeforeHover = await toolbarGeometry();
    for (let index = 0; index < toolbarButtonCount; index += 1) {
      await toolbarButtons.nth(index).hover();
      const toolbarDuringHover = await toolbarGeometry();
      expect(toolbarDuringHover).toEqual(toolbarBeforeHover);
    }
    for (const item of toolbarBeforeHover) {
      expect(Number.isInteger(item.iconX)).toBe(true);
      expect(Number.isInteger(item.iconY)).toBe(true);
    }
    await expect.poll(async () => page.locator('.workspace-searchbar').evaluate((header) => {
      const actions = header.querySelector<HTMLElement>('.searchbar-right');
      if (!actions) return false;
      return actions.scrollWidth === actions.clientWidth
        && actions.getBoundingClientRect().right <= header.getBoundingClientRect().right + 1;
    })).toBe(true);
    const runnerButton = page.getByRole('button', { name: 'Collection runner', exact: true });
    const runnerIcon = runnerButton.locator('svg');
    await page.locator('.request-editor').hover();
    const runnerIconBeforeHover = await runnerIcon.screenshot({ animations: 'disabled' });
    await runnerButton.hover();
    const runnerIconDuringHover = await runnerIcon.screenshot({ animations: 'disabled' });
    expect(runnerIconDuringHover.equals(runnerIconBeforeHover)).toBe(true);

    const requestSectionButton = page.getByRole('button', { name: 'Request section', exact: true });
    await expect(requestSectionButton).toBeVisible();
    await requestSectionButton.click();
    const requestSectionList = page.getByRole('listbox', { name: 'Request sections' });
    await expect(requestSectionList).toBeVisible();
    await expect(requestSectionList.getByRole('option', { name: 'Settings', exact: true })).toBeVisible();
    await requestSectionList.getByRole('option', { name: 'Body' }).click();
    const bodyModeRow = page.locator('.body-mode-row');
    const bodyTypeButton = page.getByRole('button', { name: 'Body type', exact: true });
    await expect(bodyTypeButton).toBeVisible();
    await bodyTypeButton.click();
    await expect(page.getByRole('listbox', { name: 'Body types' })).toBeVisible();
    await page.getByRole('option', { name: 'Raw', exact: true }).click();

    const rawTypeButton = page.locator('.raw-type-menu .app-select-trigger');
    const beautifyButton = bodyModeRow.getByRole('button', { name: 'Beautify', exact: true });
    await expect(rawTypeButton).toBeVisible();
    await expect(beautifyButton).toBeVisible();
    await expect.poll(async () => {
      const [rawBox, beautifyBox] = await Promise.all([
        rawTypeButton.boundingBox(),
        beautifyButton.boundingBox(),
      ]);
      if (!rawBox || !beautifyBox) return false;
      return Math.abs(
        (rawBox.y + rawBox.height / 2) - (beautifyBox.y + beautifyBox.height / 2),
      ) <= 1;
    }).toBe(true);

    const compactBodyLayout = await bodyModeRow.evaluate((row) => {
      const content = row.nextElementSibling;
      return {
        rowHeight: row.getBoundingClientRect().height,
        contentTop: content?.getBoundingClientRect().top ?? 0,
      };
    });
    await bodyTypeButton.click();
    await expect(page.getByRole('listbox', { name: 'Body types' })).toBeVisible();
    await expect.poll(async () => bodyModeRow.evaluate((row, before) => {
      const content = row.nextElementSibling;
      return row.getBoundingClientRect().height === before.rowHeight
        && (content?.getBoundingClientRect().top ?? 0) === before.contentTop;
    }, compactBodyLayout)).toBe(true);
    await page.getByRole('option', { name: 'URL-encoded', exact: true }).click();

    const compactKvTable = page.locator('.tab-content .headers-kv-table');
    await expect(compactKvTable).toBeVisible();
    await expect.poll(async () => compactKvTable.evaluate((table) => {
      const head = table.querySelector<HTMLElement>('.kv-head');
      const row = table.querySelector<HTMLElement>('.kv-row');
      const descriptionHead = head?.querySelectorAll<HTMLElement>('.kv-head-cell')[2];
      const descriptionInput = row?.querySelector<HTMLElement>('.kv-desc');
      const valueInput = row?.querySelectorAll<HTMLElement>('.kv-input')[1];
      if (!head || !row || !descriptionHead || !descriptionInput || !valueInput) return false;

      const tableBox = table.getBoundingClientRect();
      const valueInputBox = valueInput.getBoundingClientRect();
      return table.scrollWidth <= table.clientWidth + 1
        && getComputedStyle(descriptionHead).display === 'none'
        && getComputedStyle(descriptionInput).display === 'none'
        && valueInputBox.width >= 80
        && valueInputBox.right <= tableBox.right + 1;
    })).toBe(true);
    await expect(page.getByLabel('Resize key column')).toBeHidden();
    await expect(page.getByLabel('Resize value column')).toBeHidden();
    await expect(page.getByLabel('Resize panels')).toHaveCSS('height', '7px');
    await expect.poll(async () => compactKvTable.evaluate((table) => {
      const tabContent = table.closest<HTMLElement>('.tab-content');
      if (!tabContent) return false;
      const style = getComputedStyle(tabContent);
      if (CSS.supports('selector(::-webkit-scrollbar)')) {
        const thumb = getComputedStyle(tabContent, '::-webkit-scrollbar-thumb').backgroundColor;
        return (style.scrollbarColor === undefined || style.scrollbarColor === 'auto')
          && style.getPropertyValue('--scroll-thumb').trim() !== ''
          && thumb !== '' && thumb !== 'rgba(0, 0, 0, 0)'
          && !thumb.includes('rgb(206, 212, 218)');
      }
      const scrollbarColor = style.scrollbarColor;
      if (scrollbarColor === undefined) return true;
      return scrollbarColor !== 'auto'
        && scrollbarColor !== ''
        && !scrollbarColor.includes('rgb(206, 212, 218)');
    })).toBe(true);

    await chooseRequestSection(page, 'Headers');
    const headersTable = page.locator('.tab-content .headers-kv-table');
    const panelDivider = page.getByLabel('Resize panels');
    const headerActionGeometry = async () => headersTable.evaluate((table) => {
      const content = table.closest<HTMLElement>('.tab-content');
      const remove = table.querySelector<HTMLElement>('.kv-del');
      if (!content || !remove) return null;

      const contentBox = content.getBoundingClientRect();
      const tableBox = table.getBoundingClientRect();
      const removeBox = remove.getBoundingClientRect();
      return {
        tableWidth: tableBox.width,
        removeLeft: removeBox.left,
        removeWidth: removeBox.width,
        rightClearance: contentBox.left + content.clientWidth - removeBox.right,
        scrollable: content.scrollHeight > content.clientHeight,
      };
    });
    const headersBeforeScroll = await headerActionGeometry();
    expect(headersBeforeScroll).not.toBeNull();
    for (let index = 0; index < 12; index += 1) await panelDivider.press('ArrowUp');
    await expect.poll(async () => (await headerActionGeometry())?.scrollable ?? false).toBe(true);
    const headersWithScroll = await headerActionGeometry();
    expect(headersWithScroll).not.toBeNull();
    if (headersBeforeScroll && headersWithScroll) {
      expect(Math.abs(headersWithScroll.tableWidth - headersBeforeScroll.tableWidth)).toBeLessThanOrEqual(1);
      expect(Math.abs(headersWithScroll.removeLeft - headersBeforeScroll.removeLeft)).toBeLessThanOrEqual(1);
      expect(Math.abs(headersWithScroll.removeWidth - headersBeforeScroll.removeWidth)).toBeLessThanOrEqual(1);
      expect(headersWithScroll.rightClearance).toBeGreaterThanOrEqual(7);
    }
    for (let index = 0; index < 12; index += 1) await panelDivider.press('ArrowDown');

    await page.setViewportSize({ width: 1024, height: 800 });

    const codePanelResizer = page.getByLabel('Resize code snippet panel');
    await expect(codePanelResizer).toHaveCSS('cursor', 'col-resize');
    expect(await codePanelResizer.evaluate((resizer) => getComputedStyle(resizer, '::after').content)).toBe('none');
    await expect.poll(async () => page.locator('.workspace-searchbar').evaluate((header) => {
      const workspace = document.querySelector<HTMLElement>('.workspace-switcher-trigger');
      const actions = header.querySelector<HTMLElement>('.searchbar-right');
      const codePanel = document.querySelector<HTMLElement>('.code-snippet-panel');
      if (!workspace || !actions || !codePanel) return false;

      const headerBox = header.getBoundingClientRect();
      const workspaceBox = workspace.getBoundingClientRect();
      const actionsBox = actions.getBoundingClientRect();
      const codePanelBox = codePanel.getBoundingClientRect();
      return workspaceBox.right <= actionsBox.left
        && actionsBox.right <= codePanelBox.left
        && headerBox.right <= codePanelBox.left;
    })).toBe(true);

    await page.setViewportSize({ width: 1440, height: 800 });
    const resizerBox = await codePanelResizer.boundingBox();
    expect(resizerBox).not.toBeNull();
    if (!resizerBox) return;
    await page.mouse.move(resizerBox.x + resizerBox.width / 2, resizerBox.y + 80);
    await page.mouse.down();
    await page.mouse.move(300, resizerBox.y + 80);
    await page.mouse.up();

    await expect.poll(async () => page.locator('.workspace').evaluate((workspace) => {
      const codePanel = document.querySelector<HTMLElement>('.code-snippet-panel');
      if (!codePanel) return false;
      const workspaceBox = workspace.getBoundingClientRect();
      const codePanelBox = codePanel.getBoundingClientRect();
      const availableWidth = workspaceBox.width;
      const editorWidth = codePanelBox.left - workspaceBox.left;
      return editorWidth >= 560 && codePanelBox.width <= availableWidth / 2 + 1;
    })).toBe(true);

    await page.getByLabel('Code snippet', { exact: true }).click();
    await expect(page.locator('.code-snippet-panel')).toBeHidden();
    await expect(requestSectionButton).toBeHidden();
    await expect(page.getByRole('tab', { name: 'Settings', exact: true })).toBeVisible();
    await expect(page.locator('.request-editor-tabs-shell')).not.toHaveClass(/compact/);
    await chooseRequestSection(page, 'Body');
    await page.locator('.body-mode-label:has(input[value="raw"])').click();
    await expect(page.getByRole('button', { name: 'Body type', exact: true })).toBeHidden();
    await expect.poll(async () => bodyModeRow.evaluate((row) => {
      const binaryLabel = Array.from(row.querySelectorAll<HTMLElement>('.body-mode-label'))
        .find((label) => label.textContent?.trim() === 'Binary');
      const rawType = row.querySelector<HTMLElement>('.raw-type-menu');
      const beautify = row.querySelector<HTMLElement>('.body-mode-actions');
      if (!binaryLabel || !rawType || !beautify) return false;

      const rowBox = row.getBoundingClientRect();
      const binaryBox = binaryLabel.getBoundingClientRect();
      const rawTypeBox = rawType.getBoundingClientRect();
      const beautifyBox = beautify.getBoundingClientRect();
      return rawTypeBox.left >= binaryBox.right
        && rawTypeBox.left - binaryBox.right <= 16
        && beautifyBox.left > rawTypeBox.right
        && rowBox.right - beautifyBox.right <= 16;
    })).toBe(true);
  });

  test('keeps the Windows titlebar actions clear of the tab strip at scaled-window width', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 800 });
    await installKurloBridge(page, '', 'windows/e2e');
    await page.goto('/');

    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Windows UI');
    await collectionRow(page, 'Windows UI').getByLabel('Collection menu').click();
    await collectionRow(page, 'Windows UI').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
    await chooseRequestType(page, 'HTTP Request');
    await page.getByLabel('Request name').fill('Cursor request');
    await page.getByLabel('Request name').press('Enter');
    await expect(page.locator('.win-controls')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(page.locator('.collection-request').filter({ hasText: 'Cursor request' })).toHaveCSS('cursor', 'default');
    await expect(page.locator('.saved-request-tab').filter({ hasText: 'Cursor request' }).getByRole('tab')).toHaveCSS('cursor', 'default');

    const expectHeaderNotToOverlap = async () => {
      const [header, tabs, save, settings, controls] = await Promise.all([
        page.locator('.workspace-searchbar').boundingBox(),
        page.locator('.request-tab-strip').boundingBox(),
        page.locator('.save-btn:not(.revert-btn)').first().boundingBox(),
        page.getByLabel('Settings', { exact: true }).boundingBox(),
        page.locator('.win-controls').boundingBox(),
      ]);

      expect(header).not.toBeNull();
      expect(tabs).not.toBeNull();
      expect(save).not.toBeNull();
      expect(settings).not.toBeNull();
      expect(controls).not.toBeNull();
      if (!header || !tabs || !save || !settings || !controls) return;

      expect(tabs.x + tabs.width).toBeLessThanOrEqual(save.x);
      expect(settings.x + settings.width).toBeLessThanOrEqual(controls.x);
      expect(controls.x + controls.width).toBeLessThanOrEqual(header.x + header.width);
      expect(tabs.x).toBeGreaterThanOrEqual(header.x);
    };

    await expectHeaderNotToOverlap();

    await page.setViewportSize({ width: 1120, height: 800 });
    await expect(page.locator('.save-btn-label')).toBeHidden();
    await expectHeaderNotToOverlap();
  });

  test('add and close icons share a size and align in the tab bar', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    const expectIconSize = async (label: string, scope = page.locator('body')) => {
      const icon = scope.getByRole('button', { name: label, exact: true }).locator('svg');
      await expect(icon).toHaveCSS('width', '14px');
      await expect(icon).toHaveCSS('height', '14px');
    };

    await page.getByLabel('New unsaved request').click();
    await expectIconSize('Close tab', page.locator('.saved-request-tab.active'));
    await expectIconSize('New unsaved request');
    const addIcon = page.getByRole('button', { name: 'New unsaved request' }).locator('svg');
    const closeIcon = page.locator('.saved-request-tab.active .tab-close svg');
    const addBounds = (await addIcon.boundingBox())!;
    const closeBounds = (await closeIcon.boundingBox())!;
    expect(Math.abs(addBounds.y - closeBounds.y)).toBeLessThanOrEqual(1);
    await page.getByLabel('Settings', { exact: true }).click();
    await expectIconSize('Close settings');
    await page.getByLabel('Close settings').click();
    await page.getByRole('button', { name: 'Cookies', exact: true }).click();
    await expectIconSize('Add domain');
  });
});

test.describe('Startup screen', () => {
  async function endLastSessionOnGit(page: Page, startupView = '') {
    await page.addInitScript((view) => {
      localStorage.setItem('kurlo.topView.v1', JSON.stringify({ topView: 'git', gitWorkspaceOpen: true }));
      if (view) localStorage.setItem('kurlo.startupView.v1', view);
    }, startupView);
  }

  test('opens on the request editor even when the last session ended on Git', async ({ page }) => {
    await installKurloBridge(page);
    await endLastSessionOnGit(page);
    await page.goto('/');

    await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
    await expect(page.locator('.git-workspace')).toHaveCount(0);
    await expect(page.locator('.workspace-overview')).toHaveCount(0);
  });

  for (const [startupView, agentOpen] of [['', false], ['restore', true]] as const) {
    test(`keeps the chat list with the Agent tab after a session that ended in the agent${startupView ? ' (where you left off)' : ''}`, async ({ page }) => {
      await installKurloBridge(page);
      await page.addInitScript((view) => {
        localStorage.setItem('kurlo.topView.v1', JSON.stringify({ topView: 'agent', sidebarView: 'agent' }));
        if (view) localStorage.setItem('kurlo.startupView.v1', view);
      }, startupView);
      await page.goto('/');

      if (agentOpen) {
        await expect(page.locator('.agent-workspace')).toBeVisible();
        await expect(page.getByRole('tab', { name: 'Agent', exact: true })).toHaveAttribute('aria-selected', 'true');
        await expect(page.locator('.agent-sidebar')).toBeVisible();
      } else {
        await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
        await expect(page.locator('.collections-head').first()).toBeVisible();
        await expect(page.locator('.agent-sidebar')).toHaveCount(0);
        await page.getByRole('button', { name: 'Agent', exact: true }).click();
        await expect(page.locator('.agent-sidebar')).toBeVisible();
        await clickTabClose(page.getByRole('button', { name: 'Close agent', exact: true }));
        await expect(page.locator('.agent-sidebar')).toHaveCount(0);
      }
    });
  }

  test('reopens the last screen when set to where you left off', async ({ page }) => {
    await installKurloBridge(page);
    await endLastSessionOnGit(page, 'restore');
    await page.goto('/');

    await expect(page.locator('.git-workspace')).toBeVisible();
  });

  test('starts on the workspace overview when set to it', async ({ page }) => {
    await installKurloBridge(page);
    await endLastSessionOnGit(page, 'overview');
    await page.goto('/');

    await expect(page.locator('.workspace-overview')).toBeVisible();
  });

  test('chooses the startup screen in settings', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');

    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'General', exact: true }).click();
    const panel = page.locator('#settings-panel-general');
    const onLaunch = panel.getByRole('button', { name: /^On launch:/ });
    await expect(onLaunch).toContainText('Request editor');
    await expect(panel.getByText('Saving', { exact: true })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Export all data', exact: true })).toBeVisible();
    await onLaunch.click();
    await page.getByRole('option', { name: 'Where you left off' }).click();
    await expect(onLaunch).toContainText('Where you left off');
    await expect(panel).toContainText('Reopens the last screen');
    expect(await page.evaluate(() => localStorage.getItem('kurlo.startupView.v1'))).toBe('restore');
  });

  test('scrolls to the new key form below a long list of AI connections', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const connections = Array.from({ length: 9 }, (_, index) => ({ id: `c${index}`, kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '', hasKey: true, keyHint: '…sd', default: index === 0, provider: 'openai' }));
      ((window as E2EWindow).go.api.App as Record<string, unknown>).AiConnections = async () => ({ connections });
    });
    await page.goto('/');
    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    const panel = page.locator('#settings-panel-ai');
    await panel.getByRole('button', { name: 'Add key' }).click();
    const form = panel.getByRole('form', { name: 'Add an API key' });
    await expect(form.getByLabel('API key')).toBeFocused();
    await expect(form.getByRole('button', { name: 'Save' })).toBeInViewport();
  });

  test('stops offering new AI connections at the limit and wraps long model errors', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      const connections = Array.from({ length: 10 }, (_, index) => ({ id: `c${index}`, kind: 'openai', label: 'OpenAI', baseUrl: 'https://api.openai.com/v1', model: '', hasKey: true, keyHint: '…sd', default: index === 0, provider: 'openai' }));
      const app = (window as E2EWindow).go.api.App as Record<string, unknown>;
      app.AiConnections = async () => ({ connections });
      app.TestAiConnection = async () => ({ ok: false, models: [], error: 'The API key was not accepted: invalid_request_error: Incorrect API key provided: [your key]. You can find your API key at https://platform.openai.com/account/api-keys.' });
    });
    await page.goto('/');
    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    const panel = page.locator('#settings-panel-ai');
    await expect(panel.getByRole('status').filter({ hasText: 'You have 10 connections' })).toBeVisible();
    await expect(panel.getByRole('button', { name: 'Add key' })).toHaveCount(0);
    await expect(panel.getByRole('button', { name: 'Make default' })).toHaveCount(9);

    await panel.getByRole('button', { name: /Model for/ }).nth(3).click();
    const error = page.locator('.ai-combo-error');
    await expect(error).toContainText('[your key]');
    const contained = await page.evaluate(() => {
      const menu = document.querySelector('.ai-combo-menu')!.getBoundingClientRect();
      const message = document.querySelector('.ai-combo-error')!;
      return message.scrollWidth <= message.clientWidth && message.getBoundingClientRect().right <= menu.right;
    });
    expect(contained).toBe(true);
  });

  test('connects AI models with a key, OpenRouter and removal', async ({ page }) => {
    await installKurloBridge(page);
    await page.addInitScript(() => {
      type Connection = { id: string; kind: string; label: string; baseUrl: string; model: string; hasKey: boolean; keyHint: string; default: boolean; provider: string };
      const store: { connections: Connection[]; saved: unknown[] } = { connections: [], saved: [] };
      const labels: Record<string, string> = { anthropic: 'Anthropic', openrouter: 'OpenRouter', openai: 'OpenAI', compatible: 'OpenAI-compatible', local: 'Local model' };
      const view = () => ({ connections: store.connections.map(connection => ({ ...connection, default: connection.id === store.connections[0]?.id })) });
      const app = (window as E2EWindow).go.api.App as Record<string, unknown>;
      app.CodexStatus = async () => ({ installed: false, connected: false, authenticated: false, path: '', version: '', account: '', authType: '', model: '', models: [], authUrl: '', waiting: false });
      app.ClaudeCodeStatus = async () => ({ installed: true, connected: false, authenticated: true, path: '/usr/local/bin/claude', version: '2.1.0 (Claude Code)', account: 'you@example.com · max', authMethod: 'subscription', model: 'claude-opus-5-5', models: [], defaultModel: 'claude-opus-5-5' });
      app.AiConnections = async () => view();
      app.SaveAiConnection = async (input: { id: string; kind: string; key: string; model: string; baseUrl: string }) => {
        store.saved.push({ ...input, key: input.key ? 'set' : '' });
        const existing = store.connections.find(connection => connection.id === input.id);
        if (existing) {
          existing.model = input.model;
          return view();
        }
        store.connections.push({ id: `c${store.connections.length + 1}`, kind: input.kind, label: labels[input.kind], baseUrl: input.baseUrl || 'https://api.anthropic.com/v1', model: input.model, hasKey: Boolean(input.key), keyHint: 'sk-ant-…XYZ', default: false, provider: 'anthropic' });
        return view();
      };
      app.RemoveAiConnection = async (id: string) => {
        store.connections = store.connections.filter(connection => connection.id !== id);
        return view();
      };
      app.SetDefaultAiConnection = async () => view();
      app.TestAiConnection = async (input: { key: string }) => input.key === 'sk-ant-good'
        ? { ok: true, models: [{ id: 'claude-sonnet-4-5', name: 'Claude Sonnet 4.5', recommended: true, weakTools: false }, { id: 'claude-3-haiku', name: 'Claude 3 Haiku', recommended: false, weakTools: false }] }
        : { ok: false, models: [], error: 'The API key was not accepted' };
      app.DiscoverLocalAiServers = async () => ({ servers: [] });
      app.OpenRouterConnectStatus = async () => ({ status: 'idle', authUrl: '' });
      app.StartOpenRouterConnect = async () => ({ status: 'waiting', authUrl: 'https://openrouter.ai/auth?callback_url=x' });
      app.CancelOpenRouterConnect = async () => ({ status: 'cancelled', authUrl: '' });
      app.ReopenOpenRouterConnect = async () => ({ status: 'waiting', authUrl: 'https://openrouter.ai/auth?callback_url=x' });
      (window as unknown as { __aiStore: typeof store }).__aiStore = store;
    });
    await page.goto('/');

    await page.getByLabel('Settings', { exact: true }).click();
    await page.getByRole('tab', { name: 'AI', exact: true }).click();
    const panel = page.locator('#settings-panel-ai');
    await expect(panel.getByText('Connect a model')).toBeVisible();

    await panel.getByRole('button', { name: 'Add key' }).click();
    const form = panel.getByRole('form', { name: 'Add an API key' });
    await expect(form.getByLabel('API key')).toBeFocused();
    await expect(form).toBeInViewport();
    await form.getByLabel('API key').fill('sk-ant-bad');
    await form.getByRole('button', { name: 'Test' }).click();
    await expect(form.getByRole('alert')).toHaveText('The API key was not accepted');
    await form.getByLabel('API key').fill('sk-ant-good');
    await form.getByRole('button', { name: 'Test' }).click();
    await expect(form.getByText('The key works. 2 models available.')).toBeVisible();
    await form.getByRole('button', { name: 'Model' }).click();
    await page.getByRole('textbox', { name: 'Search models' }).fill('haiku');
    await expect(page.getByRole('option')).toHaveCount(1);
    await page.getByRole('option', { name: /Claude 3 Haiku/ }).click();
    await expect(form.getByRole('button', { name: 'Model' })).toContainText('Claude 3 Haiku');
    await form.getByRole('button', { name: 'Model' }).click();
    await page.getByRole('textbox', { name: 'Search models' }).fill('sonnet');
    await page.keyboard.press('Enter');
    await expect(form.getByRole('button', { name: 'Model' })).toContainText('Claude Sonnet 4.5');
    await form.getByRole('button', { name: 'Save' }).click();
    await expect(form).toBeHidden();

    const list = panel.getByRole('list', { name: 'AI connections' });
    const anthropic = list.getByRole('listitem').filter({ hasText: 'Anthropic' });
    await expect(anthropic).toContainText('Default');
    await expect(anthropic).toContainText('claude-sonnet-4-5');
    await expect(anthropic).toContainText('sk-ant-…XYZ');
    expect(await page.evaluate(() => (window as unknown as { __aiStore: { saved: Array<{ kind: string; key: string; model: string }> } }).__aiStore.saved))
      .toEqual([expect.objectContaining({ kind: 'anthropic', key: 'set', model: 'claude-sonnet-4-5' })]);
    await expect(panel.getByText('Add another connection')).toBeVisible();
    await expect(panel.getByText('Kurlo agent', { exact: true })).toBeVisible();
    await expect(panel.getByText('Your agents', { exact: true })).toBeVisible();
    const order = await panel.evaluate(element => {
      const agents = element.querySelector('[aria-label="Your agents"] .disclosure-heading')!.getBoundingClientRect();
      const list = element.querySelector('.ai-connection-list')!.getBoundingClientRect();
      const options = element.querySelector('.ai-options')!.getBoundingClientRect();
      return { agentsFirst: agents.bottom < list.top, optionsLast: list.bottom + 20 <= options.top };
    });
    expect(order).toEqual({ agentsFirst: true, optionsLast: true });
    await expect(panel).not.toContainText('only available in the desktop app');
    await panel.getByRole('region', { name: 'Claude Code connection' }).evaluate(node => node.scrollIntoView({ block: 'start' }));
    await captureDocsScreenshot(page, 'settings-ai');
    await anthropic.getByRole('button', { name: /Model for/ }).click();
    await expect(page.getByRole('textbox', { name: 'Search models' })).toBeFocused();
    const placement = await page.evaluate(() => {
      const menu = document.querySelector('.ai-combo-menu')!.getBoundingClientRect();
      const body = document.querySelector('#settings-panel-ai')!;
      const box = body.getBoundingClientRect();
      return { scrollLeft: body.scrollLeft, fits: menu.left >= box.left && menu.right <= box.left + body.clientWidth };
    });
    expect(placement).toEqual({ scrollLeft: 0, fits: true });
    await page.keyboard.press('Escape');

    await panel.getByRole('button', { name: 'Connect OpenRouter' }).click();
    await expect(panel.getByText('Finish signing in in your browser')).toBeVisible();
    await page.evaluate(() => {
      const store = (window as unknown as { __aiStore: { connections: Array<Record<string, unknown>> } }).__aiStore;
      store.connections.push({ id: 'or', kind: 'openrouter', label: 'OpenRouter', baseUrl: 'https://openrouter.ai/api/v1', model: '', hasKey: true, keyHint: 'sk-or-v1-…789', default: false, provider: 'openai' });
      window.__kurloE2E.emit('ai:openrouter-connect', { status: 'connected', authUrl: '' });
    });
    await expect(list.getByRole('listitem').filter({ hasText: 'OpenRouter' })).toContainText('sk-or-v1-…789');
    await expect(panel.locator('.ai-options').getByRole('button', { name: 'Reconnect' })).toBeVisible();
    const fieldLefts = await panel.getByRole('button', { name: /Model for/ }).evaluateAll(nodes => nodes.map(node => Math.round(node.getBoundingClientRect().left)));
    expect(new Set(fieldLefts).size).toBe(1);

    const remove = anthropic.getByRole('button', { name: 'Remove' });
    await remove.click();
    await anthropic.getByRole('button', { name: 'Remove?' }).click();
    await expect(list.getByRole('listitem')).toHaveCount(1);
    await expect(list.getByRole('listitem').first()).toContainText('OpenRouter');
    await expect(list.getByRole('listitem').first()).toContainText('Default');
  });
});

test.describe('Empty states', () => {
  test('spaces the history filter empty state and keeps the status filter full width', async ({ page }) => {
    await installKurloBridge(page);
    await page.goto('/');
    await page.getByPlaceholder('Enter request URL or paste cURL…').fill('https://api.kurlo.test/orders');
    await page.getByRole('button', { name: /^Send( |$)/ }).first().click();
    await expect(page.getByText(/200 OK/).first()).toBeVisible();
    await page.getByRole('button', { name: 'History' }).click();
    const filter = page.locator('.history-status-filter');
    await filter.getByRole('radio', { name: '5xx', exact: true }).click();
    const empty = page.locator('.history-empty');
    await expect(empty.getByText('Nothing matches this filter.')).toBeVisible();
    const gap = await empty.evaluate(el => el.querySelector('.btn')!.getBoundingClientRect().top - el.querySelector('.empty-state-title')!.getBoundingClientRect().bottom);
    expect(gap).toBeGreaterThanOrEqual(8);
    const widths = await filter.evaluate(el => ({ filter: el.getBoundingClientRect().width, search: el.parentElement!.querySelector('.sidebar-search')!.getBoundingClientRect().width }));
    expect(Math.abs(widths.filter - widths.search)).toBeLessThan(1);
  });
});

test.describe('Window title bar', () => {
  for (const [runtime, ownControls] of [['linux/e2e', true], ['windows/e2e', true], ['darwin/e2e', false]] as const) {
    test(`${ownControls ? 'draws' : 'leaves'} the window buttons on ${runtime.split('/')[0]}`, async ({ page }, testInfo) => {
      await installKurloBridge(page, '', runtime);
      await page.goto('/');
      await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.platform)).toBe(runtime.split('/')[0]);
      const minimise = page.getByRole('button', { name: 'Minimize' });
      if (ownControls) {
        await expect(minimise).toBeVisible();
        await expect(page.getByRole('button', { name: 'Maximize' })).toBeVisible();
        expect(await page.locator('.titlebar-drag-region').first().evaluate(el => getComputedStyle(el).getPropertyValue('--wails-draggable').trim())).toBe('drag');
        await reviewShot(page, { path: join(tmpdir(), `kurlo-titlebar-${runtime.split('/')[0]}-${testInfo.project.name}.png`), animations: 'disabled' });
      } else {
        await expect(minimise).toBeHidden();
      }
    });
  }

  test('keeps an empty spot to drag the window by however many tabs are open', async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 1100, height: 760 });
    await installKurloBridge(page, '', 'windows/e2e');
    await page.goto('/');
    await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.platform)).toBe('windows');
    const newTab = page.getByRole('button', { name: 'New unsaved request' });
    for (let i = 0; i < 15; i += 1) await newTab.click();
    await expect(page.locator('.saved-request-tab')).toHaveCount(17);
    const grab = page.locator('.workspace-searchbar .titlebar-grab');
    const spot = await grab.evaluate(el => {
      const box = el.getBoundingClientRect();
      const hit = document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2);
      return { width: box.width, hit: hit === el, drag: getComputedStyle(el).getPropertyValue('--wails-draggable').trim() };
    });
    expect(spot.width).toBeGreaterThanOrEqual(48);
    expect(spot).toMatchObject({ hit: true, drag: 'drag' });
    await reviewShot(page, { path: join(tmpdir(), `kurlo-titlebar-grab-${testInfo.project.name}.png`), clip: { x: 0, y: 0, width: 1100, height: 60 }, animations: 'disabled' });
  });

  test('keeps one title band with a line across the rail and sidebar on macOS', async ({ page }, testInfo) => {
    await installKurloBridge(page, '', 'darwin/e2e');
    await page.goto('/');
    await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.dataset.platform)).toBe('darwin');
    const measure = () => page.evaluate(() => {
      const rail = document.querySelector('.activity-rail') as HTMLElement;
      const bar = document.querySelector('.workspace-searchbar') as HTMLElement;
      const sidebarBand = document.querySelector('.sidebar-titlebar') as HTMLElement;
      const filter = document.querySelector('.sidebar-search') as HTMLElement;
      const button = document.querySelector('.activity-rail-btn') as HTMLElement;
      const line = getComputedStyle(rail, '::before');
      const railBox = rail.getBoundingClientRect();
      const barBox = bar.getBoundingClientRect();
      const bandBox = sidebarBand.getBoundingClientRect();
      return {
        railLineTop: railBox.top + parseFloat(line.top),
        railLineWidth: parseFloat(line.width),
        railLineColor: line.backgroundColor,
        railWidth: railBox.width,
        barLineTop: barBox.bottom - parseFloat(getComputedStyle(bar).borderBottomWidth),
        barLineColor: getComputedStyle(bar).borderBottomColor,
        sidebarLineTop: bandBox.bottom - parseFloat(getComputedStyle(sidebarBand).borderBottomWidth),
        sidebarLineColor: getComputedStyle(sidebarBand).borderBottomColor,
        buttonTop: button.getBoundingClientRect().top,
        filterTop: filter.getBoundingClientRect().top,
      };
    });
    const open = await measure();
    expect(open.railLineTop).toBeCloseTo(open.barLineTop, 1);
    expect(open.sidebarLineTop).toBeCloseTo(open.barLineTop, 1);
    expect(open.sidebarLineColor).toBe(open.barLineColor);
    expect(open.railLineColor).toBe(open.barLineColor);
    expect(open.railLineWidth).toBeCloseTo(open.railWidth, 1);
    expect(open.buttonTop).toBeGreaterThan(open.barLineTop + 1);
    expect(open.filterTop).toBeCloseTo(open.buttonTop, 0);
    const switcher = page.getByRole('button', { name: 'Workspace switcher' });
    await expect(page.locator('.workspace-searchbar .workspace-switcher')).toHaveCount(0);
    const switcherBox = (await switcher.boundingBox())!;
    const sidebarBox = (await page.locator('.sidebar').boundingBox())!;
    expect(switcherBox.x).toBeGreaterThanOrEqual(80);
    expect(sidebarBox.x + sidebarBox.width - (switcherBox.x + switcherBox.width)).toBeCloseTo(8, 0);
    const stripStart = await page.locator('.workspace-searchbar').evaluate(bar => (bar.querySelector('.request-tab-strip') as HTMLElement).getBoundingClientRect().left - bar.getBoundingClientRect().left);
    expect(stripStart).toBeLessThanOrEqual(12.5);
    expect(switcherBox.y + switcherBox.height / 2).toBeCloseTo((open.barLineTop + 1) / 2, 0);
    await reviewShot(page, { path: join(tmpdir(), `kurlo-title-band-darwin-open-${testInfo.project.name}.png`), clip: { x: 0, y: 0, width: 480, height: 140 }, animations: 'disabled' });
    await switcher.click();
    const menu = page.locator('.workspace-menu');
    await expect(menu).toBeVisible();
    const menuBox = (await menu.boundingBox())!;
    expect(menuBox.y).toBeGreaterThan(open.barLineTop);
    expect(await page.evaluate(([x, y]) => Boolean(document.elementFromPoint(x, y)?.closest('.workspace-menu')), [menuBox.x + menuBox.width - 8, menuBox.y + 20])).toBe(true);
    await reviewShot(page, { path: join(tmpdir(), `kurlo-title-band-darwin-menu-${testInfo.project.name}.png`), clip: { x: 0, y: 0, width: 560, height: 320 }, animations: 'disabled' });
    await switcher.click();
    await expect(menu).toHaveCount(0);
    await page.getByRole('button', { name: 'Toggle sidebar' }).click();
    await expect(page.locator('.shell')).toHaveClass(/sidebar-hidden/);
    const hidden = await measure();
    await expect(page.locator('.workspace-searchbar .workspace-switcher')).toHaveCount(1);
    await expect(page.locator('.workspace-switcher.docked')).toHaveCount(0);
    expect(hidden.railLineTop).toBeCloseTo(hidden.barLineTop, 1);
    expect(hidden.buttonTop).toBe(open.buttonTop);
    await page.getByRole('button', { name: 'Collections' }).hover();
    await reviewShot(page, { path: join(tmpdir(), `kurlo-title-band-darwin-hidden-${testInfo.project.name}.png`), clip: { x: 0, y: 0, width: 480, height: 140 }, animations: 'disabled' });
  });

  test('quits with Ctrl+Q on Linux only', async ({ page }) => {
    for (const runtime of ['linux/e2e', 'windows/e2e']) {
      await installKurloBridge(page, '', runtime);
      await page.goto('/');
      await expect(page.getByPlaceholder('Enter request URL or paste cURL…')).toBeVisible();
      await expect.poll(() => page.evaluate(() => document.documentElement.dataset.platform)).toBe(runtime.split('/')[0]);
      await page.keyboard.press('Control+q');
      const calls = await page.evaluate(() => window.__kurloE2E.calls as string[]);
      expect(calls.includes('runtime:Quit')).toBe(runtime === 'linux/e2e');
    }
  });
});

test.describe('README screenshot', () => {
  test.use({ colorScheme: 'dark' });
  test('captures the README screenshot', async ({ page }) => {
    test.skip(!readmeScreenshotPath, 'Set KURLO_README_SCREENSHOT to capture the README screenshot');
    await page.setViewportSize({ width: 1440, height: 900 });
    await installKurloBridge(page, '', 'darwin/e2e', false);
    await page.addInitScript(() => {
      const app = (window as any).go.api.App;
      app.AppInfo = async () => ({ name: 'Kurlo', version: '2.0.0', runtime: 'darwin/e2e', goVersion: 'e2e' });
      for (const workspace of (window as any).__kurloE2E.store.workspaces ?? []) workspace.name = 'Acme';
      const send = app.SendRequest;
      app.SendRequest = async (req: any) => {
        if (!String(req.url).includes('/orders')) return send(req);
        const body = JSON.stringify({
          id: 'ord_8f3k2m',
          status: 'confirmed',
          customer: { id: 'cus_1042', name: 'Ada Lovelace', email: 'ada@example.com' },
          items: [
            { sku: 'KB-75', name: 'Mechanical keyboard', quantity: 1, price: 149.0 },
            { sku: 'MS-02', name: 'Wireless mouse', quantity: 2, price: 39.5 },
          ],
          total: 228.0,
          currency: 'EUR',
          createdAt: '2026-09-30T18:42:07Z',
        }, null, 2);
        return { statusCode: 201, status: '201 Created', headers: [{ key: 'content-type', value: 'application/json' }, { key: 'location', value: '/orders/ord_8f3k2m' }], body, duration: 86, size: body.length, error: '', warnings: [], timeline: [], sentRequests: [], testResult: { tests: [{ name: 'status is 201', passed: true }, { name: 'returns an order id', passed: true }], logs: [] }, preRequestResult: { tests: [], logs: [] } };
      };
    });
    await page.goto('/');
    await page.getByLabel('New collection').click();
    await fillPrompt(page, 'New collection', 'Orders API');
    for (const [name, method, url] of [
      ['List orders', 'GET', '{{baseUrl}}/orders?status=open'],
      ['Get order', 'GET', '{{baseUrl}}/orders/{{orderId}}'],
      ['Cancel order', 'DELETE', '{{baseUrl}}/orders/{{orderId}}'],
      ['Create order', 'POST', '{{baseUrl}}/orders'],
    ] as const) {
      await collectionRow(page, 'Orders API').getByLabel('Collection menu').click();
      await collectionRow(page, 'Orders API').locator('.collection-menu').getByRole('button', { name: 'Add request' }).click();
      await chooseRequestType(page, 'HTTP Request');
      await page.getByLabel('Request name').fill(name);
      await page.getByLabel('Request name').press('Enter');
      if (method !== 'GET') {
        await page.getByLabel('Method and protocol').click();
        await page.getByRole('option', { name: method }).click();
      }
      await page.getByLabel('Request URL').fill(url);
    }
    await chooseRequestSection(page, 'Body');
    await page.locator('label.body-mode-label').filter({ hasText: 'raw' }).click();
    await fillCodeEditor(page, 'request-body-editor', JSON.stringify({ customerId: 'cus_1042', items: [{ sku: 'KB-75', quantity: 1 }, { sku: 'MS-02', quantity: 2 }], currency: 'EUR' }, null, 2));
    await page.getByRole('button', { name: /^Send( |$)/ }).first().click();
    await expect(page.getByText('201 Created')).toBeVisible();
    await page.locator('.response-mini-tabs').getByRole('tab', { name: 'Body' }).click();
    await page.mouse.move(1439, 899);
    await page.waitForTimeout(400);
    await page.screenshot({ path: readmeScreenshotPath });
  });
});
