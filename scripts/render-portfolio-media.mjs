// Render portfolio-media SVGs to PNG at the right pixel sizes via sharp.
//
// Usage: node scripts/render-portfolio-media.mjs

import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import sharp from 'sharp';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');

const SHOTS = [
  { src: 'hero.svg',            out: 'hero-1920x1080.png',     w: 1920, h: 1080, density: 200 },
  { src: 'square.svg',          out: 'square-1080x1080.png',   w: 1080, h: 1080, density: 200 },
  { src: 'linkedin-banner.svg', out: 'linkedin-1584x396.png',  w: 1584, h: 396,  density: 220 },
  { src: 'twitter-header.svg',  out: 'twitter-1500x500.png',   w: 1500, h: 500,  density: 220 },
  { src: 'stats-card.svg',      out: 'stats-1200x630.png',     w: 1200, h: 630,  density: 200 },
  { src: resolve(ROOT, 'docs/architecture.svg'), out: 'architecture-2400x1350.png', w: 2400, h: 1350, density: 240, abs: true },
];

const SRC_DIR = resolve(ROOT, 'portfolio-media/_src');
const OUT_DIR = resolve(ROOT, 'portfolio-media');

for (const shot of SHOTS) {
  const src = shot.abs ? shot.src : resolve(SRC_DIR, shot.src);
  const out = resolve(OUT_DIR, shot.out);
  const info = await sharp(src, { density: shot.density })
    .resize(shot.w, shot.h)
    .png({ compressionLevel: 9 })
    .toFile(out);
  console.log(`[ok] ${shot.out} — ${info.size.toLocaleString()} bytes`);
}
