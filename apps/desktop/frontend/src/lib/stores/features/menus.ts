type MenuHost = {
  openRequestMenuId: string;
  openCollectionMenuId: string;
  openFolderMenuKey: string;
  openLoadTestMenuId: string;
  historyHeaderMenuOpen: boolean;
  openHistoryMenuId: string;
  snippetMenuOpen: boolean;
  openFormTypeMenuId: number | null;
  rawTypeMenuOpen: boolean;
  authMenuOpen: boolean;
  workspaceMenuOpen: boolean;
  environmentMenuOpen: boolean;
  closeFloatingMenus: () => void;
};

function closeMenus(host: MenuHost) {
  host.openRequestMenuId = '';
  host.openCollectionMenuId = '';
  host.openFolderMenuKey = '';
  host.openLoadTestMenuId = '';
  host.historyHeaderMenuOpen = false;
  host.openHistoryMenuId = '';
  host.snippetMenuOpen = false;
  host.openFormTypeMenuId = null;
  host.rawTypeMenuOpen = false;
  host.authMenuOpen = false;
  host.workspaceMenuOpen = false;
  host.environmentMenuOpen = false;
}

function toggleMenu(host: MenuHost, event: MouseEvent, next: () => void) {
  event.stopPropagation();
  closeMenus(host);
  next();
}

export const menuFeature = {
  closeFloatingMenus(this: MenuHost) {
    closeMenus(this);
  },
  toggleRequestMenu(this: MenuHost, id: string, event: MouseEvent) {
    const open = this.openRequestMenuId === id ? '' : id;
    toggleMenu(this, event, () => (this.openRequestMenuId = open));
  },
  toggleCollectionMenu(this: MenuHost, id: string, event: MouseEvent) {
    const open = this.openCollectionMenuId === id ? '' : id;
    toggleMenu(this, event, () => (this.openCollectionMenuId = open));
  },
  toggleFolderMenu(this: MenuHost, key: string, event: MouseEvent) {
    const open = this.openFolderMenuKey === key ? '' : key;
    toggleMenu(this, event, () => (this.openFolderMenuKey = open));
  },
  toggleLoadTestMenu(this: MenuHost, id: string, event: MouseEvent) {
    const open = this.openLoadTestMenuId === id ? '' : id;
    toggleMenu(this, event, () => (this.openLoadTestMenuId = open));
  },
  toggleHistoryHeaderMenu(this: MenuHost, event: MouseEvent) {
    const open = !this.historyHeaderMenuOpen;
    toggleMenu(this, event, () => (this.historyHeaderMenuOpen = open));
  },
  toggleHistoryEntryMenu(this: MenuHost, id: string, event: MouseEvent) {
    const open = this.openHistoryMenuId === id ? '' : id;
    toggleMenu(this, event, () => (this.openHistoryMenuId = open));
  },
  toggleWorkspaceMenu(this: MenuHost, event: MouseEvent) {
    const open = !this.workspaceMenuOpen;
    toggleMenu(this, event, () => (this.workspaceMenuOpen = open));
  },
  toggleEnvironmentMenu(this: MenuHost, event: MouseEvent) {
    const open = !this.environmentMenuOpen;
    toggleMenu(this, event, () => (this.environmentMenuOpen = open));
  },
  toggleAuthMenu(this: MenuHost, event: MouseEvent) {
    const open = !this.authMenuOpen;
    toggleMenu(this, event, () => (this.authMenuOpen = open));
  },
  toggleFormTypeMenu(this: MenuHost, id: number, event: MouseEvent) {
    const open = this.openFormTypeMenuId === id ? null : id;
    toggleMenu(this, event, () => (this.openFormTypeMenuId = open));
  },
  onWindowMouseDown(this: MenuHost, event: MouseEvent) {
    const target = event.target as HTMLElement | null;
    if (!target) return;
    if (target.closest('.request-menu, .request-menu-btn, .collection-menu-btn, .folder-menu-btn, .history-menu-btn, .history-entry-menu-btn, .snippet-select, .raw-type-menu, .form-type-menu, .form-type-options, .auth-select, .workspace-switcher, .environment-switcher, .app-dialog, .variable-input-wrap')) return;
    this.closeFloatingMenus();
  },
};
