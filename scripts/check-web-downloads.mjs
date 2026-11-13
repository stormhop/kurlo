#!/usr/bin/env node
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const webRoot = join(root, 'apps/web');
const distRoot = join(webRoot, 'dist');
const repo = 'https://github.com/stormhop/kurlo';

const receipts = readFileSync(join(webRoot, 'src/lib/receipts.ts'), 'utf8');
const version = receipts.match(/name: 'Kurlo',\s*version: '([^']+)'/)?.[1];
if (!version) {
  console.error('receipts.ts: no Kurlo version');
  process.exit(1);
}

const url = suffix => `${repo}/releases/download/v${version}/kurlo-${version}${suffix}`;
const primary = {
  mac: url('-darwin-universal.dmg'),
  windows: url('-windows-amd64-installer.exe'),
  linux: url('-linux-amd64.AppImage'),
};
const atLeast = (value, minimum) => {
  const parts = text => text.split('-')[0].split('.').map(part => Number.parseInt(part, 10) || 0);
  const [left, right] = [parts(value), parts(minimum)];
  for (let index = 0; index < Math.max(left.length, right.length); index++) {
    const difference = (left[index] ?? 0) - (right[index] ?? 0);
    if (difference) return difference > 0;
  }
  return true;
};
const portableSince = readFileSync(join(webRoot, 'src/lib/downloads.ts'), 'utf8').match(/PORTABLE_SINCE = '([^']+)'/)?.[1] ?? '';
const allFiles = [
  ...Object.values(primary),
  url('-windows-amd64.msix'),
  url('-windows-arm64-installer.exe'),
  url('-windows-arm64.msix'),
  ...(portableSince && atLeast(version, portableSince)
    ? [url('-windows-amd64-portable.exe'), url('-windows-arm64-portable.exe')]
    : ['amd64', 'arm64'].map(arch => `${repo}/releases/download/v${version}/kurlo-windows-${arch}.exe`)),
];

const errors = [];

function page(path) {
  const file = join(distRoot, path);
  if (!existsSync(file)) {
    errors.push(`${path} is missing; run npm run web:build first`);
    return '';
  }
  return readFileSync(file, 'utf8');
}

function attributes(tag) {
  return Object.fromEntries([...tag.matchAll(/([\w-]+)(?:="([^"]*)")?/g)].map(match => [match[1], (match[2] ?? '').replaceAll('&amp;', '&')]));
}

for (const path of ['index.html', 'agent/index.html', 'mcp/index.html', 'pricing/index.html', 'vs/postman/index.html']) {
  const html = page(path);
  if (!html) continue;
  const buttons = [...html.matchAll(/<a\b[^>]*\bdata-os-download\b[^>]*>/g)].map(match => attributes(match[0]));
  if (!buttons.length) errors.push(`${path}: no download button`);
  buttons.forEach((button, index) => {
    for (const [os, expected] of Object.entries(primary)) {
      if (button[`data-url-${os}`] !== expected) {
        errors.push(`${path}: download button ${index + 1} links ${os} to ${button[`data-url-${os}`] || 'nothing'}, expected ${expected}`);
      }
      if (!/ · \d+ MB$/.test(button[`data-tag-${os}`] ?? '')) {
        errors.push(`${path}: download button ${index + 1} has no ${os} size`);
      }
    }
  });
}

const download = page('download/index.html');
if (download) {
  const hrefs = new Set([...download.matchAll(/href="([^"]+)"/g)].map(match => match[1].replaceAll('&amp;', '&')));
  for (const file of allFiles) {
    if (!hrefs.has(file)) errors.push(`download/index.html: no direct link to ${file}`);
  }
  const ctas = [...download.matchAll(/<a\b[^>]*\bdata-cta\b[^>]*>/g)].map(match => attributes(match[0]).href);
  for (const expected of Object.values(primary)) {
    if (!ctas.includes(expected)) errors.push(`download/index.html: no platform button for ${expected}`);
  }
}

if (errors.length) {
  for (const error of errors) console.error(`✗ ${error}`);
  process.exit(1);
}
console.log(`Download links point at Kurlo ${version} release files.`);
