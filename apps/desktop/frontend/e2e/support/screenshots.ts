import { DOCS_CROP_PADDING, DOCS_DARK_VARIANTS, DOCS_VIEWPORT, docsScreenshotDir, responseScreenshotPath, stepPauseMs } from './config';
import { type Locator, type Page } from '@playwright/test';
import { join } from 'node:path';

export async function docsDialogClip(page: Page) {
  const dialog = page.locator('[role="dialog"][aria-modal="true"]').first();
  if (!(await dialog.isVisible().catch(() => false))) return undefined;
  const box = await dialog.boundingBox();
  if (!box) return undefined;
  const viewport = page.viewportSize() ?? DOCS_VIEWPORT;
  const x = Math.max(0, Math.round(box.x) - DOCS_CROP_PADDING);
  const y = Math.max(0, Math.round(box.y) - DOCS_CROP_PADDING);
  return {
    x,
    y,
    width: Math.min(viewport.width - x, Math.round(box.width) + DOCS_CROP_PADDING * 2),
    height: Math.min(viewport.height - y, Math.round(box.height) + DOCS_CROP_PADDING * 2),
  };
}

export async function docsElementClip(page: Page, target: Locator) {
  const box = await target.boundingBox();
  if (!box) return undefined;
  const viewport = page.viewportSize() ?? DOCS_VIEWPORT;
  const x = Math.max(0, Math.round(box.x) - DOCS_CROP_PADDING);
  const y = Math.max(0, Math.round(box.y) - DOCS_CROP_PADDING);
  return {
    x,
    y,
    width: Math.min(viewport.width - x, Math.round(box.width) + DOCS_CROP_PADDING * 2),
    height: Math.min(viewport.height - y, Math.round(box.height) + DOCS_CROP_PADDING * 2),
  };
}

export async function captureDocsScreenshot(page: Page, name: string, cropTo?: Locator) {
  if (!docsScreenshotDir) return;
  await waitForTransientToasts(page);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const frame = [
      document.documentElement,
      document.body,
      document.getElementById('app'),
      document.querySelector('main.shell'),
    ];
    for (const element of frame) {
      if (!(element instanceof HTMLElement)) continue;
      element.scrollTop = 0;
      element.scrollLeft = 0;
    }
  });
  const clip = (await docsDialogClip(page)) ?? (cropTo ? await docsElementClip(page, cropTo) : undefined);
  await page.screenshot({
    path: join(docsScreenshotDir, `${name}.png`),
    animations: 'disabled',
    ...(clip ? { clip } : {}),
  });
  if (!DOCS_DARK_VARIANTS.has(name)) return;
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.screenshot({
    path: join(docsScreenshotDir, `${name}-dark.png`),
    animations: 'disabled',
    ...(clip ? { clip } : {}),
  });
  await page.emulateMedia({ colorScheme: 'light' });
}

export async function tourPause(page: Page, label: string) {
  if (!Number.isFinite(stepPauseMs) || stepPauseMs <= 0) return;
  await page.evaluate((text) => {
    let node = document.getElementById('kurlo-e2e-tour-label');
    if (!node) {
      node = document.createElement('div');
      node.id = 'kurlo-e2e-tour-label';
      Object.assign(node.style, {
        position: 'fixed',
        zIndex: '2147483647',
        top: '16px',
        left: '50%',
        transform: 'translateX(-50%)',
        padding: '10px 14px',
        borderRadius: '8px',
        background: 'rgba(16, 20, 28, 0.94)',
        color: '#fff',
        font: '600 13px system-ui, -apple-system, BlinkMacSystemFont, sans-serif',
        boxShadow: '0 10px 28px rgba(0, 0, 0, 0.28)',
        pointerEvents: 'none',
      });
      document.body.appendChild(node);
    }
    node.textContent = text;
  }, label);
  await page.waitForTimeout(stepPauseMs);
}

export async function maybeCaptureResponseScreenshot(page: Page) {
  if (!responseScreenshotPath) return;
  await page.screenshot({ path: responseScreenshotPath });
}

export async function waitForTransientToasts(page: Page) {
  await page.locator('.curl-toast').waitFor({ state: 'hidden', timeout: 2500 }).catch(() => { });
}
