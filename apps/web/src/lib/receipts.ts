export const RECEIPTS_CHECKED_ON = '23 October 2026';

export type Platform = 'macos' | 'windows' | 'linux';
export type Download = { file: string; bytes: number };
export type App = { name: string; version: string; source: string; downloads: Record<Platform, Download> };

export const platforms: { id: Platform; label: string }[] = [
  { id: 'macos', label: 'macOS' },
  { id: 'windows', label: 'Windows' },
  { id: 'linux', label: 'Linux' },
];

export const apps: App[] = [
  {
    name: 'Kurlo',
    version: '2.5.1',
    source: 'https://github.com/stormhop/kurlo/releases/tag/v2.5.1',
    downloads: {
      macos: { file: 'Universal DMG', bytes: 24022229 },
      windows: { file: 'x64 installer', bytes: 14613884 },
      linux: { file: 'x64 AppImage', bytes: 12694720 },
    },
  },
  {
    name: 'Bruno',
    version: '4.3.0',
    source: 'https://github.com/usebruno/bruno/releases/tag/v4.3.0',
    downloads: {
      macos: { file: 'Apple Silicon DMG', bytes: 167922780 },
      windows: { file: 'x64 installer', bytes: 123071368 },
      linux: { file: 'x64 AppImage', bytes: 174598148 },
    },
  },
  {
    name: 'Postman',
    version: 'latest',
    source: 'https://www.postman.com/downloads/',
    downloads: {
      macos: { file: 'Apple Silicon ZIP', bytes: 206941463 },
      windows: { file: 'x64 installer', bytes: 214087136 },
      linux: { file: 'x64 tar.gz', bytes: 208168431 },
    },
  },
  {
    name: 'Insomnia',
    version: '13.3.1',
    source: 'https://github.com/Kong/insomnia/releases/tag/core%4013.3.1',
    downloads: {
      macos: { file: 'DMG', bytes: 380798951 },
      windows: { file: 'x64 NSIS installer', bytes: 524800080 },
      linux: { file: 'x64 AppImage', bytes: 620026081 },
    },
  },
];

export const mb = (bytes: number) => bytes / 1024 / 1024;

export const formatMb = (bytes: number) => `${mb(bytes) < 100 ? mb(bytes).toFixed(1) : Math.round(mb(bytes))} MB`;

export function smallestRival(platform: Platform) {
  return apps
    .filter(app => app.name !== 'Kurlo')
    .reduce((best, app) => (app.downloads[platform].bytes < best.downloads[platform].bytes ? app : best));
}

export function timesSmaller(platform: Platform, rival = smallestRival(platform)) {
  const kurlo = apps[0].downloads[platform].bytes;
  return Math.floor((rival.downloads[platform].bytes / kurlo) * 10) / 10;
}
