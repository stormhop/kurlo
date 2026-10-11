import sharp from 'sharp';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const master = join(root, 'apps', 'desktop', 'build', 'appicon.png');

const ogPath = join(root, 'apps', 'web', 'public', 'og.png');
const avatarPath = join(root, '.github', 'assets', 'org-avatar.png');

const tile = await sharp(master).trim({ threshold: 1 }).png().toBuffer();

const derived = [
  { path: join(root, 'apps', 'desktop', 'frontend', 'src', 'lib', 'assets', 'kurlo-mark.png'), size: 144 },
  { path: join(root, 'apps', 'web', 'src', 'assets', 'logo.png'), size: 128 },
  { path: join(root, 'apps', 'web', 'public', 'favicon-32.png'), size: 32 },
  { path: join(root, 'apps', 'web', 'public', 'apple-touch-icon.png'), size: 180 },
  { path: join(root, 'apps', 'desktop', 'extension', 'icons', 'icon-16.png'), size: 16 },
  { path: join(root, 'apps', 'desktop', 'extension', 'icons', 'icon-32.png'), size: 32 },
  { path: join(root, 'apps', 'desktop', 'extension', 'icons', 'icon-48.png'), size: 48 },
  { path: join(root, 'apps', 'desktop', 'extension', 'icons', 'icon-128.png'), size: 128 },
];

for (const { path, size } of derived) {
  mkdirSync(dirname(path), { recursive: true });
  await sharp(tile).resize(size, size, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } }).png().toFile(path);
  console.log('wrote', path);
}

const windowsDir = join(root, 'apps', 'desktop', 'build', 'windows');
const windowsTileScale = 0.96;
const windowsIcon = async (size) => {
  const inner = Math.round(size * windowsTileScale);
  const pad = Math.floor((size - inner) / 2);
  return sharp(tile)
    .resize(inner, inner, { fit: 'contain', background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .extend({ top: pad, left: pad, bottom: size - inner - pad, right: size - inner - pad, background: { r: 0, g: 0, b: 0, alpha: 0 } })
    .png()
    .toBuffer();
};

mkdirSync(windowsDir, { recursive: true });
const windowsPng = join(windowsDir, 'appicon.png');
await sharp(await windowsIcon(1024)).toFile(windowsPng);
console.log('wrote', windowsPng);

const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
const icoImages = await Promise.all(icoSizes.map(windowsIcon));
const icoHeader = Buffer.alloc(6 + 16 * icoSizes.length);
icoHeader.writeUInt16LE(0, 0);
icoHeader.writeUInt16LE(1, 2);
icoHeader.writeUInt16LE(icoSizes.length, 4);
let icoOffset = icoHeader.length;
icoSizes.forEach((size, index) => {
  const entry = 6 + 16 * index;
  icoHeader.writeUInt8(size >= 256 ? 0 : size, entry);
  icoHeader.writeUInt8(size >= 256 ? 0 : size, entry + 1);
  icoHeader.writeUInt8(0, entry + 2);
  icoHeader.writeUInt8(0, entry + 3);
  icoHeader.writeUInt16LE(1, entry + 4);
  icoHeader.writeUInt16LE(32, entry + 6);
  icoHeader.writeUInt32LE(icoImages[index].length, entry + 8);
  icoHeader.writeUInt32LE(icoOffset, entry + 12);
  icoOffset += icoImages[index].length;
});
const windowsIco = join(windowsDir, 'icon.ico');
writeFileSync(windowsIco, Buffer.concat([icoHeader, ...icoImages]));
console.log('wrote', windowsIco);

const ogSvg = `<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="630" viewBox="0 0 1200 630">
  <defs>
    <linearGradient id="ogBg" x1="0" y1="0" x2="1200" y2="630" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#0c0c0e"/>
      <stop offset="0.5" stop-color="#111113"/>
      <stop offset="1" stop-color="#17171b"/>
    </linearGradient>
    <radialGradient id="ogGlow" cx="430" cy="350" r="520" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#5865f2" stop-opacity="0.22"/>
      <stop offset="0.52" stop-color="#5865f2" stop-opacity="0.07"/>
      <stop offset="1" stop-color="#5865f2" stop-opacity="0"/>
    </radialGradient>
  </defs>
  <rect width="1200" height="630" fill="url(#ogBg)"/>
  <rect width="1200" height="630" fill="url(#ogGlow)"/>
  <text x="500" y="187" fill="#aab2ff" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="22" letter-spacing="4">KURLO</text>
  <text x="500" y="292" fill="#ececef" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="94" font-weight="500">API client.</text>
  <text x="500" y="356" fill="#c9c9d1" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="34" font-weight="500">Local-first.</text>
  <text x="500" y="409" fill="#a6a6ae" font-family="Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, Segoe UI, sans-serif" font-size="25">No accounts. No cloud sync. No telemetry.</text>
  <text x="500" y="479" fill="#85858e" font-family="ui-monospace, SFMono-Regular, Menlo, Consolas, monospace" font-size="19" letter-spacing="3">macOS   ·   Windows   ·   Linux</text>
</svg>`;

await sharp(Buffer.from(ogSvg))
  .composite([{ input: await sharp(tile).resize(320, 320).png().toBuffer(), left: 110, top: 155 }])
  .png()
  .toFile(ogPath);

console.log('wrote', ogPath);

const { data: masterPixels, info: masterInfo } = await sharp(master).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
const marks = Buffer.from(masterPixels);
for (let i = 0; i < marks.length; i += 4) {
  const blueness = marks[i + 2] - (marks[i] + marks[i + 1]) / 2;
  const coverage = Math.max(0, Math.min(1, (blueness - 14) / 36));
  marks[i + 3] = Math.round(marks[i + 3] * coverage);
}
const avatarSize = 1024;
const markScale = 1.12;
const scaledSize = Math.round(avatarSize * markScale);
const inset = Math.round((scaledSize - avatarSize) / 2);
const avatarMarks = await sharp(marks, { raw: masterInfo })
  .resize(scaledSize, scaledSize)
  .extract({ left: inset, top: inset, width: avatarSize, height: avatarSize })
  .png()
  .toBuffer();
const avatarBackground = `<svg xmlns="http://www.w3.org/2000/svg" width="${avatarSize}" height="${avatarSize}" viewBox="0 0 ${avatarSize} ${avatarSize}">
  <defs>
    <linearGradient id="tileBg" x1="0" y1="0" x2="0" y2="${avatarSize}" gradientUnits="userSpaceOnUse">
      <stop offset="0" stop-color="#fcfcfe"/>
      <stop offset="1" stop-color="#e3e5ef"/>
    </linearGradient>
  </defs>
  <rect width="${avatarSize}" height="${avatarSize}" fill="url(#tileBg)"/>
</svg>`;

mkdirSync(dirname(avatarPath), { recursive: true });
await sharp(Buffer.from(avatarBackground))
  .composite([{ input: avatarMarks }])
  .png()
  .toFile(avatarPath);

console.log('wrote', avatarPath);


const profileLogos = [
  { path: join(root, '.github', 'assets', 'profile-logo-light.png'), background: '#ffffff' },
  { path: join(root, '.github', 'assets', 'profile-logo-dark.png'), background: '#0d1117' },
];

for (const { path, background } of profileLogos) {
  await sharp(tile).resize(240, 240, { fit: 'contain', background }).flatten({ background }).png().toFile(path);
  console.log('wrote', path);
}
