import { createWindowGrower, keptRowCount } from './sidebarVirtual';

export const GROW_STEP_ROWS = 40;

export class WindowGrowth {
  extra = $state(0);
  #canGrow: () => boolean;
  #renderedKeys: string[] = [];
  #grower = createWindowGrower(() => this.#grow());

  constructor(canGrow: () => boolean) {
    this.#canGrow = canGrow;
  }

  #grow() {
    if (!this.#canGrow()) return false;
    this.extra += GROW_STEP_ROWS;
    return true;
  }

  rowsChanged(keys: string[]) {
    const kept = keptRowCount(this.#renderedKeys, keys);
    if (kept < this.extra) this.extra = kept;
    this.#grower.start();
  }

  rendered(keys: string[]) {
    this.#renderedKeys = keys;
  }

  #lastTop: number | null = null;

  scrolled(top: number, viewportHeight: number, renderedTop: number, renderedBottom: number) {
    const last = this.#lastTop;
    this.#lastTop = top;
    const jumped = last !== null && Math.abs(top - last) > viewportHeight;
    const outside = top < renderedTop || top + viewportHeight > renderedBottom;
    if (jumped && outside && this.extra > 0) this.extra = 0;
    this.#grower.pause();
  }

  destroy() {
    this.#grower.stop();
  }
}
