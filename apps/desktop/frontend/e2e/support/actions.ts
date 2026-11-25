import { expect, type Locator, type Page } from '@playwright/test';

export async function openCollectionImport(page: Page) {
  await page.getByRole('button', { name: 'Collection tree menu' }).click();
  await page.getByRole('menuitem', { name: 'Import collection…' }).click();
}

export async function clickTabClose(button: Locator) {
  await button.locator('xpath=..').hover();
  await button.click();
}

export async function fillPrompt(page: Page, title: string, value: string) {
  const dialog = page.getByRole('dialog', { name: title });
  await expect(dialog).toBeVisible();
  await dialog.locator('input').fill(value);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

export async function chooseAppSelect(page: Page, select: Locator, optionLabel: string) {
  await select.locator('.app-select-trigger').click();
  await select.locator('.app-select-option').filter({ hasText: optionLabel }).first().click();
}

export async function chooseRequestType(page: Page, label: string) {
  await expect(page.getByRole('dialog', { name: 'New request' })).toHaveCount(0);
  const protocol = label.replace(/\s+request$/i, '');
  if (/^http$/i.test(protocol)) return;
  await page.getByLabel('Method and protocol').click();
  await page.getByRole('option', { name: protocol, exact: true }).click();
}

export async function fillCodeEditor(page: Page, testId: string, value: string) {
  const editor = page.getByTestId(testId).locator('.cm-content');
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+A`);
  await page.keyboard.insertText(value);
}

export function collectionRow(page: Page, name: string) {
  return page.locator('.collection-group').filter({ hasText: name }).first();
}

export function folderRow(page: Page, name: string) {
  return page.locator('.collection-subfolder').filter({ hasText: name }).first();
}

export async function addRequestFromFolder(page: Page, folderName: string, requestTypeLabel: string) {
  await page.getByRole('button', { name: 'Collections' }).click();
  const folder = folderRow(page, folderName);
  await folder.getByLabel('Folder menu').click();
  await folder.locator('.folder-menu').getByRole('button', { name: 'Add request' }).click();
  await chooseRequestType(page, requestTypeLabel);
}

export async function chooseRequestSection(page: Page, section: string) {
  const compactTrigger = page.getByRole('button', { name: 'Request section', exact: true });
  if (await compactTrigger.isVisible()) {
    await compactTrigger.click();
    await page.getByRole('option', { name: section }).click();
    return;
  }
  await page.locator('.request-editor-tabs-shell').getByRole('tab', { name: section }).click();
}
