#!/usr/bin/env node
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve } from 'node:path';
import { execFileSync } from 'node:child_process';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const receiptsPath = join(root, 'apps/web/src/lib/receipts.ts');
const readmePath = join(root, 'README.md');
const repo = 'stormhop/kurlo';

const args = process.argv.slice(2);
const check = args.includes('--check');
const tagArg = args.find(arg => !arg.startsWith('--'));

const ghArgs = ['release', 'view', ...(tagArg ? [tagArg.startsWith('v') ? tagArg : `v${tagArg}`] : []), '-R', repo, '--json', 'tagName,assets'];
const release = JSON.parse(execFileSync('gh', ghArgs, { encoding: 'utf8' }));
const version = release.tagName.replace(/^v/, '');

const wanted = {
  macos: `kurlo-${version}-darwin-universal.dmg`,
  windows: `kurlo-${version}-windows-amd64-installer.exe`,
  linux: `kurlo-${version}-linux-amd64.AppImage`,
};

const bytes = {};
for (const [platform, name] of Object.entries(wanted)) {
  const asset = release.assets.find(item => item.name === name);
  if (!asset) {
    console.error(`${release.tagName} has no ${name}`);
    process.exit(1);
  }
  bytes[platform] = asset.size;
}

const mb = value => value / 1024 / 1024;
const formatMb = value => `${mb(value) < 100 ? mb(value).toFixed(1) : Math.round(mb(value))} MB`;

const receipts = readFileSync(receiptsPath, 'utf8');
const kurloBlock = /(\{\s*name: 'Kurlo',\s*version: ')[^']*(',\s*source: ')[^']*(',\s*downloads: \{\s*macos: \{ file: '[^']*', bytes: )\d+(\s*\},\s*windows: \{ file: '[^']*', bytes: )\d+(\s*\},\s*linux: \{ file: '[^']*', bytes: )\d+/;
if (!kurloBlock.test(receipts)) {
  console.error('receipts.ts: the Kurlo entry has an unexpected shape');
  process.exit(1);
}
const nextReceipts = receipts.replace(
  kurloBlock,
  `$1${version}$2https://github.com/${repo}/releases/tag/${release.tagName}$3${bytes.macos}$4${bytes.windows}$5${bytes.linux}`,
);

const readme = readFileSync(readmePath, 'utf8');
const readmeLine = /the macOS download is [0-9.]+ MB and the Linux one is [0-9.]+ MB/;
if (!readmeLine.test(readme)) {
  console.error('README.md: the download size sentence was not found');
  process.exit(1);
}
const nextReadme = readme.replace(readmeLine, `the macOS download is ${formatMb(bytes.macos)} and the Linux one is ${formatMb(bytes.linux)}`);

const changed = [];
if (nextReceipts !== receipts) changed.push('apps/web/src/lib/receipts.ts');
if (nextReadme !== readme) changed.push('README.md');

console.log(`Kurlo ${version}: macOS ${formatMb(bytes.macos)}, Windows ${formatMb(bytes.windows)}, Linux ${formatMb(bytes.linux)}`);

if (check) {
  if (changed.length) {
    console.error(`Out of date: ${changed.join(', ')}. Run node scripts/update-receipts.mjs`);
    process.exit(1);
  }
  console.log('Download sizes are up to date.');
  process.exit(0);
}

if (nextReceipts !== receipts) writeFileSync(receiptsPath, nextReceipts);
if (nextReadme !== readme) writeFileSync(readmePath, nextReadme);
console.log(changed.length ? `Updated ${changed.join(', ')}` : 'Already up to date.');
