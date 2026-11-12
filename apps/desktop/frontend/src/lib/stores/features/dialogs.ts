import { NAME_MAX_LENGTH, clampName } from '../../constants';
import type { AppDialogState, DialogOption, DialogToggle } from '../../types/dialog';

type DialogHost = {
  appDialog: AppDialogState | null;
  dialogInputValue: string;
  dialogSelectOpen: boolean;
  closeFloatingMenus: () => void;
  dismissDialog: () => void;
  submitDialog: () => void;
  moveDialogSelection: (delta: number) => void;
};

function firstEnabledOption(options: DialogOption[]) {
  return options.find(option => !option.disabled);
}

function selectedEnabledOption(options: DialogOption[] | undefined, value: string) {
  return options?.find(option => option.value === value && !option.disabled);
}

export const dialogFeature = {
  openPromptDialog(this: DialogHost, title: string, initialValue = '', message = '', placeholder = 'Name', confirmLabel = 'Save', maxLength?: number) {
    this.closeFloatingMenus();
    this.dialogSelectOpen = false;
    this.dialogInputValue = initialValue;
    return new Promise<string | null>((resolve) => {
      this.appDialog = { mode: 'prompt', title, message, confirmLabel, cancelLabel: 'Cancel', danger: false, placeholder, maxLength, resolve: (value) => resolve(typeof value === 'string' ? value : null) };
    });
  },
  openPromptWithToggleDialog(this: DialogHost, title: string, message: string, placeholder: string, confirmLabel: string, toggle: Omit<DialogToggle, 'checked'>) {
    this.closeFloatingMenus();
    this.dialogSelectOpen = false;
    this.dialogInputValue = '';
    return new Promise<{ value: string; checked: boolean } | null>((resolve) => {
      let live: AppDialogState | null = null;
      this.appDialog = {
        mode: 'prompt', title, message, confirmLabel, cancelLabel: 'Cancel', danger: false, placeholder, toggle: { ...toggle, checked: false },
        resolve: (value) => resolve(typeof value === 'string' ? { value, checked: live?.mode === 'prompt' && live.toggle?.checked === true } : null),
      };
      live = this.appDialog;
    });
  },
  async openNameDialog(this: DialogHost, title: string, initialValue = '', message = '') {
    const name = await dialogFeature.openPromptDialog.call(this, title, clampName(initialValue), message, 'Name', 'Save', NAME_MAX_LENGTH);
    return name === null ? null : clampName(name);
  },
  openConfirmDialog(this: DialogHost, title: string, message: string, confirmLabel = 'Delete') {
    this.closeFloatingMenus();
    this.dialogSelectOpen = false;
    this.dialogInputValue = '';
    return new Promise<boolean>((resolve) => {
      this.appDialog = { mode: 'confirm', title, message, confirmLabel, cancelLabel: 'Cancel', danger: confirmLabel.toLowerCase().includes('delete'), resolve: (value) => resolve(value === true) };
    });
  },
  openAlertDialog(this: DialogHost, title: string, message: string) {
    this.closeFloatingMenus();
    this.dialogSelectOpen = false;
    this.dialogInputValue = '';
    return new Promise<void>((resolve) => {
      this.appDialog = { mode: 'alert', title, message, confirmLabel: 'OK', cancelLabel: '', danger: false, resolve: () => resolve() };
    });
  },
  openSelectDialog(this: DialogHost, title: string, message: string, options: DialogOption[], confirmLabel = 'Save', cancelLabel = 'Cancel') {
    this.closeFloatingMenus();
    this.dialogSelectOpen = false;
    this.dialogInputValue = firstEnabledOption(options)?.value ?? '';
    return new Promise<string | false | null>((resolve) => {
      this.appDialog = { mode: 'select', title, message, confirmLabel, cancelLabel, danger: false, options, resolve: (value) => resolve(typeof value === 'string' ? value : value === false ? false : null) };
    });
  },
  openSaveChangesDialog(this: DialogHost, name: string) {
    this.closeFloatingMenus();
    this.dialogSelectOpen = false;
    this.dialogInputValue = '';
    return new Promise<'save' | 'discard' | 'cancel'>((resolve) => {
      this.appDialog = {
        mode: 'unsaved', title: 'Unsaved changes',
        message: `Save changes to "${name}"?`,
        confirmLabel: 'Save', cancelLabel: 'Cancel', altLabel: "Don't Save",
        danger: false,
        resolve: (value) => {
          if (value === true) resolve('save');
          else if (value === false) resolve('cancel');
          else resolve('discard');
        },
      };
    });
  },
  dismissDialog(this: DialogHost) {
    const dialog = this.appDialog;
    if (!dialog) return;
    this.appDialog = null;
    this.dialogSelectOpen = false;
    this.dialogInputValue = '';
    if (dialog.mode === 'unsaved') dialog.resolve(false);
    else dialog.resolve(dialog.mode === 'confirm' ? false : null);
  },
  cancelDialog(this: DialogHost) {
    const dialog = this.appDialog;
    if (!dialog) return;
    this.appDialog = null;
    this.dialogSelectOpen = false;
    this.dialogInputValue = '';
    if (dialog.mode === 'unsaved') dialog.resolve(false);
    else dialog.resolve(dialog.mode === 'confirm' ? false : dialog.mode === 'select' ? false : null);
  },
  altDialog(this: DialogHost) {
    const dialog = this.appDialog;
    if (!dialog) return;
    this.appDialog = null;
    this.dialogSelectOpen = false;
    this.dialogInputValue = '';
    if (dialog.mode === 'unsaved') dialog.resolve(null);
  },
  submitDialog(this: DialogHost) {
    const dialog = this.appDialog;
    if (!dialog) return;
    if (dialog.mode === 'unsaved') {
      this.appDialog = null;
      this.dialogSelectOpen = false;
      this.dialogInputValue = '';
      dialog.resolve(true);
      return;
    }
    if (dialog.mode === 'prompt') {
      const value = this.dialogInputValue.trim();
      if (!value) return;
      this.appDialog = null;
      this.dialogSelectOpen = false;
      this.dialogInputValue = '';
      dialog.resolve(value);
      return;
    }
    if (dialog.mode === 'select') {
      const value = this.dialogInputValue;
      if (!selectedEnabledOption(dialog.options, value)) return;
      this.appDialog = null;
      this.dialogSelectOpen = false;
      this.dialogInputValue = '';
      dialog.resolve(value || null);
      return;
    }
    this.appDialog = null;
    this.dialogSelectOpen = false;
    dialog.resolve(dialog.mode === 'confirm' ? true : undefined);
  },
  dialogSelectLabel(this: DialogHost) {
    return this.appDialog?.options?.find(option => option.value === this.dialogInputValue)?.label ?? 'Select collection';
  },
  chooseDialogOption(this: DialogHost, value: string) {
    if (!selectedEnabledOption(this.appDialog?.options, value)) return;
    this.dialogInputValue = value;
    this.dialogSelectOpen = false;
  },
  moveDialogSelection(this: DialogHost, delta: number) {
    const options = (this.appDialog?.options ?? []).filter(option => !option.disabled);
    if (!options.length) return;
    const current = Math.max(0, options.findIndex(option => option.value === this.dialogInputValue));
    this.dialogInputValue = options[(current + delta + options.length) % options.length].value;
  },
  onDialogSelectKeydown(this: DialogHost, event: KeyboardEvent) {
    if (!this.appDialog?.options?.length) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      if (this.dialogSelectOpen) this.dialogSelectOpen = false;
      else this.dismissDialog();
      return;
    }
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      this.dialogSelectOpen = true;
      this.moveDialogSelection(event.key === 'ArrowDown' ? 1 : -1);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const options = this.appDialog.options.filter(option => !option.disabled);
      if (!options.length) return;
      this.dialogInputValue = options[event.key === 'Home' ? 0 : options.length - 1].value;
      this.dialogSelectOpen = true;
      return;
    }
    if (event.key === 'Enter') {
      event.preventDefault();
      if (this.dialogSelectOpen) this.dialogSelectOpen = false;
      else this.submitDialog();
      return;
    }
    if (event.key === ' ') {
      event.preventDefault();
      this.dialogSelectOpen = !this.dialogSelectOpen;
    }
  },
  onDialogKeydown(this: DialogHost, event: KeyboardEvent) {
    if (event.key === 'Escape') {
      event.preventDefault();
      this.dismissDialog();
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.submitDialog();
    }
  },
};
