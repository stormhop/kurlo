import { expect, type Page } from '@playwright/test';

export async function expectResponseTabsToFit(page: Page) {
  await expect.poll(async () => page.locator('.response-status-bar').evaluate((bar) => {
    const statusLeft = bar.querySelector<HTMLElement>('.status-left');
    const statusRight = bar.querySelector<HTMLElement>('.status-right');
    const tabs = bar.querySelector<HTMLElement>('.response-mini-tabs');
    const actions = bar.querySelector<HTMLElement>('.resp-actions');
    const buttons = [...bar.querySelectorAll<HTMLElement>('.response-mini-tabs button')];
    if (!statusLeft || !statusRight || !tabs || !actions || !buttons.length) return false;
    const barRect = bar.getBoundingClientRect();
    const leftRect = statusLeft.getBoundingClientRect();
    const rightRect = statusRight.getBoundingClientRect();
    const tabsRect = tabs.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const labelsFit = buttons.every(button => button.scrollWidth <= button.clientWidth + 1);
    const active = bar.querySelector<HTMLElement>('.response-mini-tabs button.active');
    const activeRect = active?.getBoundingClientRect();
    const activeInsideBar = !activeRect || (activeRect.top >= barRect.top - 1 && activeRect.bottom <= barRect.bottom + 1);
    const groupsStayInsideBar = leftRect.left >= barRect.left - 1 && rightRect.right <= barRect.right + 1;
    const groupsDoNotOverlap = leftRect.right <= rightRect.left - 4;
    const tabsOnTheirOwnRow = tabsRect.top >= Math.max(leftRect.bottom, actionsRect.bottom) - 1
      && tabsRect.left >= barRect.left - 1 && tabsRect.right <= barRect.right + 1;
    return labelsFit && activeInsideBar && groupsStayInsideBar && groupsDoNotOverlap && tabsOnTheirOwnRow;
  })).toBe(true);
}

export async function expectScriptResultsPanelLayout(page: Page) {
  await expect.poll(async () => page.locator('.test-results-panel').evaluate((panel) => {
    const blocks = [...panel.querySelectorAll<HTMLElement>('.script-result-block')];
    if (!blocks.length) return false;
    const previousScrollTop = panel.scrollTop;
    const panelRect = panel.getBoundingClientRect();
    const blocksHaveOwnContent = blocks.every(block => block.scrollHeight <= block.clientHeight + 1);

    panel.scrollTop = 0;
    const firstBlockRect = blocks[0].getBoundingClientRect();
    const firstHeader = blocks[0].querySelector<HTMLElement>('.script-result-header');
    const firstHeaderRect = firstHeader?.getBoundingClientRect();
    const firstBlockStartsInsidePanel = firstBlockRect.top >= panelRect.top + 8 && firstBlockRect.top < panelRect.bottom;
    const firstHeaderVisible = !firstHeaderRect || (firstHeaderRect.top >= panelRect.top + 8 && firstHeaderRect.bottom <= panelRect.bottom);

    panel.scrollTop = panel.scrollHeight;
    const lastBlock = blocks[blocks.length - 1];
    const lastRow = lastBlock.querySelector<HTMLElement>(':scope > :last-child');
    if (!lastRow) {
      panel.scrollTop = previousScrollTop;
      return false;
    }
    panel.scrollTop = panel.scrollHeight;
    const rowRect = lastRow.getBoundingClientRect();
    const reachedEnd = Math.ceil(panel.scrollTop + panel.clientHeight) >= panel.scrollHeight - 1;
    const lastRowVisible = rowRect.bottom <= panelRect.bottom - 8 && rowRect.top >= panelRect.top;

    panel.scrollTop = 0;
    return blocksHaveOwnContent && firstBlockStartsInsidePanel && firstHeaderVisible && reachedEnd && lastRowVisible;
  })).toBe(true);
}

export async function samplePanelSlide(page: Page, selectors: { toggle: string; panel: string; content: string; main: string }) {
  return page.evaluate(selectors => new Promise<Array<{ width: number; contentWidth: number; mainWidth: number }>>(resolve => {
    const panel = document.querySelector<HTMLElement>(selectors.panel)!;
    const content = document.querySelector<HTMLElement>(selectors.content)!;
    const main = document.querySelector<HTMLElement>(selectors.main)!;
    const frames: Array<{ width: number; contentWidth: number; mainWidth: number }> = [];
    const sample = () => {
      frames.push({ width: panel.getBoundingClientRect().width, contentWidth: content.getBoundingClientRect().width, mainWidth: main.getBoundingClientRect().width });
      if (frames.length >= 22) resolve(frames);
      else requestAnimationFrame(sample);
    };
    sample();
    document.querySelector<HTMLButtonElement>(selectors.toggle)!.click();
  }), selectors);
}

export function expectPanelSlide(frames: Array<{ width: number; contentWidth: number; mainWidth: number }>, opening: boolean) {
  const start = frames[0];
  const end = frames.at(-1)!;
  expect(Math.abs(end.width - start.width)).toBeGreaterThan(100);
  const low = Math.min(start.width, end.width);
  const high = Math.max(start.width, end.width);
  expect(frames.filter(frame => frame.width > low + 1 && frame.width < high - 1).length).toBeGreaterThan(3);
  for (let index = 1; index < frames.length; index += 1) {
    const previous = frames[index - 1];
    const current = frames[index];
    expect(Math.abs(current.contentWidth - end.contentWidth)).toBeLessThanOrEqual(1);
    if (opening) {
      expect(current.width).toBeGreaterThanOrEqual(previous.width - 1);
      expect(current.mainWidth).toBeLessThanOrEqual(previous.mainWidth + 1);
    } else {
      expect(current.width).toBeLessThanOrEqual(previous.width + 1);
      expect(current.mainWidth).toBeGreaterThanOrEqual(previous.mainWidth - 1);
    }
  }
}
