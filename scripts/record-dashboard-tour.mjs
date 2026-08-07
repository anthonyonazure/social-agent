// Records a video tour of the dashboard pages, then transcodes to a clean MP4.
//
// Usage: node scripts/record-dashboard-tour.mjs

import { chromium } from 'playwright';
import { mkdir, rm, readdir } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '..');
const VIDEOS_DIR = resolve(ROOT, 'tmp/dashboard-tour');
const OUT = resolve(ROOT, 'portfolio-media/dashboard-tour-1280x800.mp4');
const BASE = process.env.DASHBOARD_URL ?? 'http://localhost:3100';

async function main() {
  await rm(VIDEOS_DIR, { recursive: true, force: true });
  await mkdir(VIDEOS_DIR, { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const ctx = await browser.newContext({
    viewport: { width: 1280, height: 800 },
    deviceScaleFactor: 2,
    colorScheme: 'light',
    recordVideo: { dir: VIDEOS_DIR, size: { width: 1280, height: 800 } },
  });
  const page = await ctx.newPage();

  // Page 1
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3500);

  // Campaigns list
  await page.goto(BASE + '/campaigns', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2500);

  // Campaign detail — click the first card
  const detailLink = page.locator('a[href^="/campaigns/"]').first();
  if (await detailLink.count()) {
    await detailLink.click();
    await page.waitForLoadState('networkidle');
    await page.waitForTimeout(4000);
  }

  // Queue
  await page.goto(BASE + '/queue', { waitUntil: 'networkidle' });
  await page.waitForTimeout(4000);

  // Approvals
  await page.goto(BASE + '/approvals', { waitUntil: 'networkidle' });
  await page.waitForTimeout(5000);

  // Runs
  await page.goto(BASE + '/runs', { waitUntil: 'networkidle' });
  await page.waitForTimeout(3000);

  // Back to overview
  await page.goto(BASE + '/', { waitUntil: 'networkidle' });
  await page.waitForTimeout(2000);

  await ctx.close();
  await browser.close();

  // Find the recorded webm
  const files = await readdir(VIDEOS_DIR);
  const webm = files.find((f) => f.endsWith('.webm'));
  if (!webm) throw new Error('no webm produced');
  const webmPath = join(VIDEOS_DIR, webm);
  console.log(`[recorded] ${webmPath}`);

  // Transcode to mp4 with proper pixel format + faststart
  await new Promise((res, rej) => {
    const p = spawn('ffmpeg', [
      '-y',
      '-i', webmPath,
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-crf', '22',
      '-preset', 'slow',
      '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
      '-movflags', '+faststart',
      '-an',
      OUT,
    ], { stdio: 'inherit' });
    p.on('close', (code) => (code === 0 ? res() : rej(new Error(`ffmpeg exit ${code}`))));
  });

  console.log(`[done] ${OUT}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
