import { GITHUB_RELEASES } from '../../site.constants.mjs';
import { formatSize } from '../scripts/latest-release';
import { apps, type Platform } from './receipts';

export type Os = 'mac' | 'windows' | 'linux';

const kurlo = apps[0];

export const RELEASE_VERSION = kurlo.version;
export const RELEASE_PAGE = `${GITHUB_RELEASES}/tag/v${RELEASE_VERSION}`;

export const PORTABLE_SINCE = '3.0.5';

export function versionAtLeast(version: string, minimum: string): boolean {
  const parts = (value: string) => value.split('-')[0].split('.').map(part => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(version), parts(minimum)];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference > 0;
  }
  return true;
}

export const releaseHasPortable = versionAtLeast(RELEASE_VERSION, PORTABLE_SINCE);

export const assetName = (suffix: string) => `kurlo-${RELEASE_VERSION}${suffix}`;
export const assetUrl = (suffix: string) => `${GITHUB_RELEASES}/download/v${RELEASE_VERSION}/${assetName(suffix)}`;

const primary: Record<Os, { suffix: string; platform: Platform; kind: string }> = {
  mac: { suffix: '-darwin-universal.dmg', platform: 'macos', kind: 'Universal' },
  windows: { suffix: '-windows-amd64-installer.exe', platform: 'windows', kind: 'x64' },
  linux: { suffix: '-linux-amd64.AppImage', platform: 'linux', kind: 'AppImage' },
};

export const primaryDownloads = (Object.keys(primary) as Os[]).map(os => {
  const { suffix, platform, kind } = primary[os];
  const size = formatSize(kurlo.downloads[platform].bytes);
  return { os, suffix, size, url: assetUrl(suffix), tag: size ? `${kind} · ${size}` : kind };
});

export function portableDownload(arch: 'amd64' | 'arm64') {
  if (releaseHasPortable) {
    const suffix = `-windows-${arch}-portable.exe`;
    return { match: suffix, name: assetName(suffix), url: assetUrl(suffix) };
  }
  const name = `kurlo-windows-${arch}.exe`;
  return { match: name, name, url: `${GITHUB_RELEASES}/download/v${RELEASE_VERSION}/${name}` };
}
