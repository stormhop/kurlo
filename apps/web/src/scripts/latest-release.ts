import { GITHUB_LATEST_API } from '../../site.constants.mjs';

export interface ReleaseAsset {
  name: string;
  browser_download_url: string;
  size: number;
}

export interface Release {
  tag_name?: string;
  html_url?: string;
  published_at?: string;
  assets?: ReleaseAsset[];
}

export function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '';
  const mb = bytes / 1024 / 1024;
  return mb >= 1024 ? `${(mb / 1024).toFixed(1)} GB` : `${Math.round(mb)} MB`;
}

export function findAsset(release: Release, suffix: string): ReleaseAsset | undefined {
  return (release.assets ?? []).find(asset => asset.name.endsWith(suffix));
}

export async function latestRelease(): Promise<Release | null> {
  try {
    const response = await fetch(GITHUB_LATEST_API, { headers: { Accept: 'application/vnd.github+json' } });
    if (!response.ok) return null;
    const release = (await response.json()) as Release;
    return release.assets?.length ? release : null;
  } catch {
    return null;
  }
}
