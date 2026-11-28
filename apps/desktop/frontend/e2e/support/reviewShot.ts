import type { Locator, LocatorScreenshotOptions, Page, PageScreenshotOptions } from '@playwright/test';

export const reviewShots = process.env.KURLO_E2E_SHOTS === '1';

export async function reviewShot(target: Page, options: PageScreenshotOptions): Promise<void>;
export async function reviewShot(target: Locator, options: LocatorScreenshotOptions): Promise<void>;
export async function reviewShot(target: Page | Locator, options: PageScreenshotOptions | LocatorScreenshotOptions) {
  if (!reviewShots) return;
  await (target as Page).screenshot(options as PageScreenshotOptions);
}
