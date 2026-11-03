<script lang="ts">
  import AddCloseIcon from './AddCloseIcon.svelte';
  import { MAX_FOLDER_DEPTH, MAX_FOLDER_REQUESTS } from '../constants';
  import SidebarFolderNode from './SidebarFolderNode.svelte';
  import SidebarRequestRow from './SidebarRequestRow.svelte';
  import MenuIcon from './MenuIcon.svelte';
  import type { FolderGroup, SavedRequest, WorkspaceDiagnostic } from '../types/models';
  import type { TopView } from '../stores/ui';

  let {
    folder,
    collectionId,
    depth,
    sidebarSearch,
    activeRequestId,
    topView,
    openFolderMenuKey,
    openRequestMenuId,
    requestTabLabel,
    toggleFolderCollapsed,
    toggleFolderMenu,
    createRequestInFolder,
    createSubfolder,
    renameFolder,
    deleteFolder,
    runFolder,
    switchRequest,
    toggleRequestMenu,
    renameRequest,
    duplicateRequest,
    copyRequestCurl,
    toggleRequestPinned,
    deleteRequest,
    openWorkspaceDiagnostic,
  }: {
    folder: FolderGroup;
    collectionId: string;
    depth: number;
    sidebarSearch: string;
    activeRequestId: string;
    topView: TopView;
    openFolderMenuKey: string;
    openRequestMenuId: string;
    requestTabLabel: (request: SavedRequest) => string;
    toggleFolderCollapsed: (collectionId: string, path: string[]) => void;
    toggleFolderMenu: (key: string, event: MouseEvent) => void;
    createRequestInFolder: (collectionId: string, folderPath: string[]) => void;
    createSubfolder: (collectionId: string, parentPath: string[]) => void;
    renameFolder: (collectionId: string, folderPath: string[]) => void;
    deleteFolder: (collectionId: string, folderPath: string[]) => void;
    runFolder: (collectionId: string, folderPath: string[]) => void;
    switchRequest: (id: string) => void;
    toggleRequestMenu: (id: string, event: MouseEvent) => void;
    renameRequest: (id: string, name?: string) => void | Promise<void>;
    duplicateRequest: (id: string) => void;
    copyRequestCurl: (id: string) => void;
    toggleRequestPinned: (id: string) => void;
    deleteRequest: (id: string) => void;
    openWorkspaceDiagnostic: (diagnostics: WorkspaceDiagnostic[]) => void;
  } = $props();

  function folderCanAcceptRequest(value: FolderGroup) {
    return (value.requests?.length ?? 0) < MAX_FOLDER_REQUESTS;
  }

  function folderCanAcceptSubfolder(value: FolderGroup) {
    return (value.path?.length ?? 0) < MAX_FOLDER_DEPTH;
  }
</script>

<div class="collection-tree-node" style={`--tree-depth: ${depth}`}>
  <div class="collection-subfolder" role="presentation" oncontextmenu={(event) => { event.preventDefault(); toggleFolderMenu(folder.key, event); }}>
    <button class="subfolder-collapse" type="button" onclick={() => toggleFolderCollapsed(collectionId, folder.path)} aria-label={folder.collapsed ? 'Expand folder' : 'Collapse folder'}>
      <svg class:collapsed={folder.collapsed} width="0.625rem" height="0.625rem" viewBox="0 0 10 10" fill="none" aria-hidden="true">
        <path d="M2 3.5L5 6.5L8 3.5" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"/>
      </svg>
    </button>
    <svg class="folder-icon" width="0.8125rem" height="0.8125rem" viewBox="0 0 13 13" fill="none" aria-hidden="true"><path d="M1.5 3.2h3l1.1 1.1h5.9v5.5a1.2 1.2 0 01-1.2 1.2H2.7a1.2 1.2 0 01-1.2-1.2V3.2z" stroke="currentColor" stroke-width="1.2" stroke-linejoin="round"/></svg>
    <span class="folder-title">{folder.name}</span>
    <span class="collection-count">{folder.requestCount}</span>
    <button class="btn btn-ghost btn-icon btn-sm folder-menu-btn" type="button" onclick={(event) => toggleFolderMenu(folder.key, event)} aria-label="Folder menu">•••</button>
    {#if openFolderMenuKey === folder.key}
      <div class="menu request-menu folder-menu">
        <button class="menu-item"
          type="button"
          disabled={!folderCanAcceptRequest(folder)}
          onclick={() => createRequestInFolder(collectionId, folder.path)}
        ><MenuIcon name="request" />Add request</button>
        <button class="menu-item"
          type="button"
          disabled={!folderCanAcceptSubfolder(folder)}
          onclick={() => createSubfolder(collectionId, folder.path)}
        ><MenuIcon name="folder" />Add subfolder</button>
        <div class="menu-separator" role="separator"></div>
        <button class="menu-item" type="button" onclick={() => runFolder(collectionId, folder.path)}><MenuIcon name="play" />Run folder</button>
        <button class="menu-item" type="button" onclick={() => renameFolder(collectionId, folder.path)}><MenuIcon name="rename" />Rename</button>
        <div class="menu-separator" role="separator"></div>
        <button class="menu-item danger" type="button" onclick={() => deleteFolder(collectionId, folder.path)}><MenuIcon name="trash" />Delete folder</button>
      </div>
    {/if}
  </div>
  {#if !folder.collapsed || sidebarSearch.trim()}
    <div class="collection-tree-children">
      {#if !folder.children.length && !folder.requests.length && !sidebarSearch.trim()}
        <div class="collection-empty" role="status" style={`--tree-depth: ${depth + 1}`}>
          <button type="button" class="collection-empty-row" onclick={() => createRequestInFolder(collectionId, folder.path)} disabled={!folderCanAcceptRequest(folder)}>
            <span class="collection-empty-plus" aria-hidden="true"><AddCloseIcon add /></span>
            Add request
          </button>
          <button type="button" class="collection-empty-row" onclick={() => createSubfolder(collectionId, folder.path)} disabled={!folderCanAcceptSubfolder(folder)}>
            <span class="collection-empty-plus" aria-hidden="true"><AddCloseIcon add /></span>
            Add folder
          </button>
        </div>
      {/if}
      {#each folder.children as child (child.key)}
        <SidebarFolderNode
          folder={child}
          {collectionId}
          depth={depth + 1}
          {sidebarSearch}
          {activeRequestId}
          {topView}
          {openFolderMenuKey}
          {openRequestMenuId}
          {requestTabLabel}
          {toggleFolderCollapsed}
          {toggleFolderMenu}
          {createRequestInFolder}
          {createSubfolder}
          {renameFolder}
          {deleteFolder}
          {runFolder}
          {switchRequest}
          {toggleRequestMenu}
          {renameRequest}
          {duplicateRequest}
          {copyRequestCurl}
          {toggleRequestPinned}
          {deleteRequest}
          {openWorkspaceDiagnostic}
        />
      {/each}
      {#each folder.requests as req, eachIndex (eachIndex)}
        <SidebarRequestRow
          {req}
          depth={depth + 1}
          menuKey={`request:${req.id}`}
          {activeRequestId}
          {topView}
          {openRequestMenuId}
          {requestTabLabel}
          {switchRequest}
          {toggleRequestMenu}
          {renameRequest}
          {duplicateRequest}
          {copyRequestCurl}
          {toggleRequestPinned}
          {deleteRequest}
          {openWorkspaceDiagnostic}
        />
      {/each}
    </div>
  {/if}
</div>
