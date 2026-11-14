import { expect, type Page } from '@playwright/test';

export async function setGitStatus(page: Page, status: Record<string, unknown>) {
  await page.evaluate((partial) => {
    const state = window.__kurloE2E as unknown as { gitStatusOverride: Record<string, unknown> | null };
    state.gitStatusOverride = { ...(state.gitStatusOverride ?? {}), ...partial };
  }, status);
}

export async function setGitBranches(page: Page, branches: Record<string, unknown>) {
  await page.evaluate((value) => {
    (window.__kurloE2E as unknown as { gitBranchesOverride: Record<string, unknown> | null }).gitBranchesOverride = value;
  }, branches);
}

export async function openGitPanel(page: Page) {
  await page.getByLabel('Open Git and storage status').click();
  await expect(page.locator('.git-workspace')).toBeVisible();
}
