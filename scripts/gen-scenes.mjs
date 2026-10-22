import sharp from 'sharp';
import { mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const output = join(root, 'apps', 'web', 'src', 'assets', 'scenes');
const { BIRD_BODY } = await import(join(root, 'apps', 'web', 'src', 'lib', 'bird.ts'));

const W = 1600;
const H = 1000;

const random = seed => () => {
  seed = (seed * 16807) % 2147483647;
  return (seed - 1) / 2147483646;
};

const toRgb = hex => [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16));
const toHex = rgb => `#${rgb.map(v => Math.max(0, Math.min(255, Math.round(v))).toString(16).padStart(2, '0')).join('')}`;
const mix = (a, b, t) => toHex(toRgb(a).map((v, i) => v + (toRgb(b)[i] - v) * t));
const shade = (hex, amount) => toHex(toRgb(hex).map(v => (amount >= 0 ? v + (255 - v) * amount : v * (1 + amount))));
const f = n => n.toFixed(1);

const gradientAt = (stops, t) => {
  if (t <= stops[0][0]) return stops[0][1];
  for (let i = 1; i < stops.length; i++) {
    if (t <= stops[i][0]) {
      const [t0, c0] = stops[i - 1];
      const [t1, c1] = stops[i];
      return mix(c0, c1, (t - t0) / (t1 - t0));
    }
  }
  return stops[stops.length - 1][1];
};

const palettes = {
  dusk: {
    seed: 11,
    sky: [[0, '#272a69'], [0.28, '#4a52bf'], [0.5, '#9590dc'], [0.66, '#e2aeb8'], [0.8, '#f7c6a0']],
    sun: { x: 1220, y: 640, r: 86, core: '#ffc98c', glow: '#ffc98f' },
    clouds: { top: '#bdb7f0', bottom: '#f6bfae' },
    layers: ['#8a82cf', '#544f9e', '#211f4c'],
    rim: '#ffc79c',
    lit: 0.09,
    stars: 0,
  },
  dawn: {
    seed: 503,
    sky: [[0, '#2c2466'], [0.3, '#6656c4'], [0.52, '#c993c6'], [0.7, '#f6b9a6'], [0.82, '#ffd8a8']],
    sun: { x: 1240, y: 700, r: 108, core: '#ffd79c', glow: '#ffd29c' },
    clouds: { top: '#d3b6ec', bottom: '#ffd0b0' },
    layers: ['#a184cb', '#604a99', '#241b4a'],
    rim: '#ffd0a0',
    lit: 0.04,
    stars: 0,
  },
  night: {
    seed: 907,
    sky: [[0, '#06071a'], [0.35, '#121547'], [0.62, '#2a2e7a'], [0.82, '#4a4f9e']],
    sun: { x: 1220, y: 250, r: 54, core: '#f3f2ff', glow: '#dfe3ff' },
    clouds: { top: '#2c3076', bottom: '#454a98' },
    layers: ['#34367c', '#1f2058', '#0c0c29'],
    rim: '#9aa3ff',
    lit: 0.22,
    texture: 0.16,
    moon: true,
    stars: 90,
  },
};

const skyline = (r, minH, maxH, minW, maxW, litChance) => {
  const windows = [];
  const roofs = [];
  let d = `M -40 ${H}`;
  let x = -40;
  while (x < W + 40) {
    const w = minW + r() * (maxW - minW);
    const top = H - (minH + r() * (maxH - minH));
    const roof = r();
    d += ` L ${f(x)} ${f(top)}`;
    if (roof < 0.22) {
      d += ` L ${f(x + w / 2)} ${f(top - w * 0.32)}`;
    } else if (roof < 0.5) {
      const cx = x + w * (0.2 + r() * 0.5);
      const ch = 14 + r() * 22;
      d += ` L ${f(cx)} ${f(top)} L ${f(cx)} ${f(top - ch)} L ${f(cx + 12)} ${f(top - ch)} L ${f(cx + 12)} ${f(top)}`;
    } else if (roof < 0.62) {
      const ax = x + w * 0.7;
      d += ` L ${f(ax)} ${f(top)} L ${f(ax)} ${f(top - 60)} L ${f(ax + 2.5)} ${f(top - 60)} L ${f(ax + 2.5)} ${f(top)}`;
    }
    d += ` L ${f(x + w)} ${f(top)}`;
    roofs.push({ x, w, top });
    if (litChance > 0) {
      for (let wy = top + 18; wy < H - 20; wy += 30) {
        for (let wx = x + 10; wx < x + w - 18; wx += 22) {
          if (r() < litChance) windows.push({ x: wx, y: wy });
        }
      }
    }
    x += w + (r() < 0.3 ? 4 + r() * 14 : 0);
    d += ` L ${f(x)} ${H}`;
  }
  d += ` L ${W + 40} ${H} Z`;
  return { d, windows, roofs };
};

const stroke = (x, y, length, width, angle, color, opacity, bend = 0) => {
  const a = (angle * Math.PI) / 180;
  const dx = (Math.cos(a) * length) / 2;
  const dy = (Math.sin(a) * length) / 2;
  return `<path d="M ${f(x - dx)} ${f(y - dy)} Q ${f(x)} ${f(y + bend)} ${f(x + dx)} ${f(y + dy)}" stroke="${color}" stroke-width="${f(width)}" stroke-opacity="${opacity.toFixed(2)}" stroke-linecap="round" fill="none"/>`;
};

const painting = name => {
  const p = palettes[name];
  const r = random(p.seed);
  const sky = t => gradientAt(p.sky, t);
  const parts = [];

  const skyStrokes = [];
  for (let i = 0; i < 1100; i++) {
    const y = r() * 880 - 40;
    const x = r() * (W + 200) - 100;
    const base = sky(y / H);
    const color = shade(base, (r() - 0.5) * (p.texture ?? 0.3));
    skyStrokes.push(stroke(x, y, 120 + r() * 460, 5 + r() * 26, (r() - 0.5) * 7, color, 0.16 + r() * 0.4, (r() - 0.5) * 18));
  }

  const cloudStrokes = [];
  const clusters = [[300, 300, 300], [990, 215, 380], [1370, 395, 250], [650, 470, 220]];
  for (const [cx, cy, spread] of clusters) {
    const rows = 7;
    for (let row = 0; row < rows; row++) {
      const t = row / (rows - 1);
      const y = cy + 34 - t * 78;
      const width = spread * (1.25 - t * 0.75) * (0.85 + r() * 0.3);
      const offset = (r() - 0.5) * spread * 0.35;
      const color = mix(p.clouds.bottom, p.clouds.top, t);
      const count = 9 + Math.round(r() * 6);
      for (let i = 0; i < count; i++) {
        const x = cx + offset + (r() - 0.5) * width;
        cloudStrokes.push(stroke(x, y + (r() - 0.5) * 12, 40 + r() * width * 0.5, 12 + r() * 16, (r() - 0.5) * 5, shade(color, (r() - 0.5) * 0.14), 0.3 + r() * 0.4, (r() - 0.5) * 8));
      }
      if (row > 1) {
        for (let i = 0; i < 3; i++) {
          const x = cx + offset + (r() - 0.5) * width * 0.8;
          cloudStrokes.push(stroke(x, y - 10 - r() * 16, 26 + r() * 40, 18 + r() * 16, (r() - 0.5) * 40, shade(color, 0.08 + r() * 0.1), 0.35 + r() * 0.3, -10));
        }
      }
    }
    for (let i = 0; i < 6; i++) {
      cloudStrokes.push(stroke(cx + (r() - 0.5) * spread * 2.2, cy + 30 + r() * 30, 80 + r() * 200, 3 + r() * 5, (r() - 0.5) * 3, shade(p.clouds.bottom, 0.1), 0.25 + r() * 0.3));
    }
  }

  const stars = [];
  for (let i = 0; i < p.stars; i++) {
    stars.push(`<circle cx="${f(r() * W)}" cy="${f(r() * 520)}" r="${(0.7 + r() * 1.8).toFixed(2)}" fill="#ffffff" opacity="${(0.4 + r() * 0.5).toFixed(2)}"/>`);
  }

  const sunStrokes = [];
  for (let i = 0; i < 40; i++) {
    const a = r() * Math.PI * 2;
    const d = r() * p.sun.r * 0.8;
    sunStrokes.push(stroke(p.sun.x + Math.cos(a) * d, p.sun.y + Math.sin(a) * d, 30 + r() * 70, 6 + r() * 12, (r() - 0.5) * 30, shade(p.sun.core, p.moon ? -r() * 0.05 : (r() - 0.4) * 0.25), 0.4 + r() * 0.4));
  }

  const layers = [
    skyline(random(p.seed + 7), 170, 300, 70, 150, 0),
    skyline(random(p.seed + 31), 110, 210, 60, 130, name === 'night' ? 0.05 : 0),
    skyline(random(p.seed + 101), 50, 130, 90, 190, p.lit),
  ];

  const layerParts = layers.map((layer, i) => {
    const color = p.layers[i];
    const daubs = [];
    for (let k = 0; k < 520; k++) {
      const y = H - r() * 330;
      daubs.push(stroke(r() * W, y, 20 + r() * 90, 4 + r() * 12, (r() - 0.5) * 30 + (r() < 0.5 ? 0 : 90), shade(color, (r() - 0.5) * 0.24), 0.25 + r() * 0.35));
    }
    const glow = i === 0 ? 0.55 : i === 1 ? 0.45 : 0.32;
    const roofLight = layer.roofs
      .filter(() => r() < 0.85)
      .map(roof => stroke(roof.x + roof.w / 2, roof.top + 3, roof.w * (0.5 + r() * 0.4), 3 + r() * 3, 0, p.rim, glow * (0.4 + r() * 0.6)));
    const windows = layer.windows.map(w => `<rect x="${f(w.x)}" y="${f(w.y)}" width="9" height="14" rx="1.5" fill="#ffd27e" opacity="${(0.65 + r() * 0.35).toFixed(2)}"/>`);
    return `
      <clipPath id="clip-${i}"><path d="${layer.d}"/></clipPath>
      <path d="${layer.d}" fill="${color}"/>
      <g clip-path="url(#clip-${i})" filter="url(#bristle)">${daubs.join('')}${roofLight.join('')}</g>
      ${windows.length ? `<g filter="url(#glow)">${windows.join('')}</g><g>${windows.join('')}</g>` : ''}`;
  });

  const wire = { x0: -40, y0: 520, cx: 800, cy: 660, x1: W + 40, y1: 470 };
  const onWire = t => ({
    x: (1 - t) ** 2 * wire.x0 + 2 * (1 - t) * t * wire.cx + t ** 2 * wire.x1,
    y: (1 - t) ** 2 * wire.y0 + 2 * (1 - t) * t * wire.cy + t ** 2 * wire.y1,
  });
  const ink = p.layers[2];
  const perched = [0.16, 0.2, 0.47, 0.71].map((t, i) => {
    const pt = onWire(t);
    const flip = i % 2 ? -1 : 1;
    return `<g transform="translate(${f(pt.x)} ${f(pt.y + 1)}) scale(${0.055 * flip} 0.055) translate(-509 -735)"><path d="${BIRD_BODY}" fill="${ink}"/><rect x="450" y="640" width="24" height="95" fill="${ink}"/><rect x="516" y="640" width="24" height="95" fill="${ink}"/></g>`;
  });

  parts.push(`<rect x="-80" y="-80" width="${W + 160}" height="${H + 160}" fill="url(#sky)"/>`);
  parts.push(stars.join(''));
  parts.push(`<g filter="url(#bristle)">${skyStrokes.join('')}</g>`);
  parts.push(`<circle cx="${p.sun.x}" cy="${p.sun.y}" r="300" fill="url(#sunglow)"/>`);
  parts.push(`<circle cx="${p.sun.x}" cy="${p.sun.y}" r="${p.sun.r}" fill="${p.sun.core}"/>`);
  parts.push(`<g clip-path="url(#sunclip)" filter="url(#bristle)">${sunStrokes.join('')}</g>`);
  parts.push(`<g filter="url(#soft)">${cloudStrokes.join('')}</g>`);
  parts.push(layerParts.join(''));
  parts.push(`<path d="M 1384 ${H} L 1384 452 L 1392 452 L 1392 ${H} Z" fill="${ink}"/><path d="M 1356 476 L 1420 476 M 1364 490 L 1412 490" stroke="${ink}" stroke-width="5"/>`);
  parts.push(`<path d="M ${wire.x0} ${wire.y0} Q ${wire.cx} ${wire.cy} ${wire.x1} ${wire.y1}" fill="none" stroke="${ink}" stroke-width="2.4"/>`);
  parts.push(perched.join(''));

  return `<svg xmlns="http://www.w3.org/2000/svg" width="2688" height="1680" viewBox="-40 -25 ${W + 80} ${H + 50}">
  <defs>
    <linearGradient id="sky" gradientUnits="userSpaceOnUse" x1="0" y1="0" x2="0" y2="${H}">${p.sky.map(([o, c]) => `<stop offset="${o}" stop-color="${c}"/>`).join('')}</linearGradient>
    <radialGradient id="sunglow"><stop offset="0" stop-color="${p.sun.glow}" stop-opacity="0.75"/><stop offset="0.45" stop-color="${p.sun.glow}" stop-opacity="0.25"/><stop offset="1" stop-color="${p.sun.glow}" stop-opacity="0"/></radialGradient>
    <clipPath id="sunclip"><circle cx="${p.sun.x}" cy="${p.sun.y}" r="${p.sun.r}"/></clipPath>
    <filter id="bristle" filterUnits="userSpaceOnUse" x="-50" y="-50" width="${W + 100}" height="${H + 100}">
      <feTurbulence type="fractalNoise" baseFrequency="0.006 0.22" numOctaves="2" seed="${p.seed}" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="12" xChannelSelector="R" yChannelSelector="G"/>
    </filter>
    <filter id="soft" filterUnits="userSpaceOnUse" x="-50" y="-50" width="${W + 100}" height="${H + 100}">
      <feTurbulence type="fractalNoise" baseFrequency="0.008 0.18" numOctaves="2" seed="${p.seed + 3}" result="n"/>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="16" xChannelSelector="R" yChannelSelector="G"/>
      <feGaussianBlur stdDeviation="0.7"/>
    </filter>
    <filter id="glow" filterUnits="userSpaceOnUse" x="0" y="0" width="${W}" height="${H}"><feGaussianBlur stdDeviation="6"/></filter>
    <filter id="canvas" filterUnits="userSpaceOnUse" x="-80" y="-80" width="${W + 160}" height="${H + 160}">
      <feTurbulence type="fractalNoise" baseFrequency="0.01 0.016" numOctaves="3" seed="${p.seed + 5}" result="wobble"/>
      <feDisplacementMap in="SourceGraphic" in2="wobble" scale="7" xChannelSelector="R" yChannelSelector="G" result="painted"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.004 0.07" numOctaves="4" seed="${p.seed + 9}" result="ridges"/>
      <feTurbulence type="fractalNoise" baseFrequency="0.5" numOctaves="2" seed="${p.seed + 13}" result="weave"/>
      <feComposite in="ridges" in2="weave" operator="arithmetic" k1="0" k2="0.8" k3="0.35" k4="0" result="bump"/>
      <feDiffuseLighting in="bump" surfaceScale="4.5" diffuseConstant="1" lighting-color="#ffffff" result="light">
        <feDistantLight azimuth="235" elevation="48"/>
      </feDiffuseLighting>
      <feComponentTransfer in="light" result="relief">
        <feFuncR type="linear" slope="0.5" intercept="0.56"/>
        <feFuncG type="linear" slope="0.5" intercept="0.56"/>
        <feFuncB type="linear" slope="0.5" intercept="0.56"/>
      </feComponentTransfer>
      <feBlend in="painted" in2="relief" mode="multiply"/>
    </filter>
  </defs>
  <g filter="url(#canvas)">${parts.join('\n')}</g>
</svg>`;
};

mkdirSync(output, { recursive: true });
const only = process.argv.slice(2);
for (const name of Object.keys(palettes).filter(name => !only.length || only.includes(name))) {
  const started = Date.now();
  const path = join(output, `${name}.webp`);
  await sharp(Buffer.from(painting(name)), { limitInputPixels: false }).extract({ left: 64, top: 40, width: 2560, height: 1600 }).webp({ quality: 86, effort: 6 }).toFile(path);
  console.log('wrote', path, `${Date.now() - started} ms`);
}
