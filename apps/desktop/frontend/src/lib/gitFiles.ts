import type { GitWorkspaceStatus } from './backend';

type GitFile = GitWorkspaceStatus['files'][number];

export function kurloChangedFiles(status: Pick<GitWorkspaceStatus, 'files'> | null | undefined): GitFile[] {
  return (status?.files ?? []).filter(file => file.managed !== false);
}

export function otherChangedFileCount(status: Pick<GitWorkspaceStatus, 'files'> | null | undefined): number {
  return (status?.files ?? []).filter(file => file.managed === false).length;
}
