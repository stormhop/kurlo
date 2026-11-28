import { describe, expect, it, vi } from 'vitest';
import { dialogFeature } from '../lib/stores/features/dialogs';
import type { AppDialogState } from '../lib/types/dialog';

function host() {
  return {
    appDialog: null as AppDialogState | null,
    dialogInputValue: '',
    dialogSelectOpen: false,
    closeFloatingMenus: vi.fn(),
    dismissDialog: vi.fn(),
    submitDialog: vi.fn(),
    moveDialogSelection: vi.fn(),
  };
}

describe('confirm dialog', () => {
  it('marks the button dangerous only when the caller says so', () => {
    const h = host();
    void dialogFeature.openConfirmDialog.call(h, 'Clear history', 'Clear it?', 'Clear history', true);
    expect(h.appDialog).toMatchObject({ mode: 'confirm', confirmLabel: 'Clear history', danger: true });

    void dialogFeature.openConfirmDialog.call(h, 'Delete-free title', 'Export it?', 'Export deleted items');
    expect(h.appDialog).toMatchObject({ confirmLabel: 'Export deleted items', danger: false });
  });

  it('never labels an unnamed confirmation as a deletion', () => {
    const h = host();
    void dialogFeature.openConfirmDialog.call(h, 'Abort merge', 'Abort it?');
    expect(h.appDialog).toMatchObject({ confirmLabel: 'Continue', danger: false });
  });

  it('resolves with the answer', async () => {
    const h = host();
    const answer = dialogFeature.openConfirmDialog.call(h, 'Discard changes', 'Discard?', 'Discard', true);
    h.appDialog!.resolve(true);
    await expect(answer).resolves.toBe(true);
  });
});
