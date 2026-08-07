// Real post-production: ffmpeg-based subtitle burn, CTA overlay, and TikTok-spec
// normalization (H.264 / AAC / 9:16 / ≤60fps / yuv420p).
//
// Activated when `DEMO_MODE=false` AND ffmpeg is on PATH. Falls back to a clean
// passthrough otherwise. Inputs: a video URL or local path. Output: a local
// MP4 written to the configured asset cache, plus an SRT sidecar.

import { spawn } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { env } from '../env.js';

const here = dirname(fileURLToPath(import.meta.url));
const ASSET_DIR = resolve(here, '../../../../tmp/assets');

export interface PostProdInput {
  contentItemId: string;
  videoUrl: string;          // input video (URL or file://)
  script: string;            // for subtitle generation
  cta: string;               // bottom overlay text
  hookText?: string;         // top overlay text for first 3s
  brandColor?: string;       // hex, used for CTA pill background
  durationSeconds?: number;  // hint
}

export interface PostProdOutput {
  finalVideoPath: string;
  finalVideoUrl: string;
  srtPath: string;
  width: number;
  height: number;
  durationSeconds: number;
  sizeBytes: number;
  mode: 'real' | 'passthrough';
}

// --- ffmpeg detection ---

let ffmpegChecked = false;
let ffmpegAvailable = false;

async function hasFfmpeg(): Promise<boolean> {
  if (ffmpegChecked) return ffmpegAvailable;
  ffmpegChecked = true;
  ffmpegAvailable = await new Promise<boolean>((res) => {
    const p = spawn('ffmpeg', ['-version']);
    p.on('error', () => res(false));
    p.on('close', (code) => res(code === 0));
  });
  return ffmpegAvailable;
}

function run(cmd: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const p = spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    p.stdout.on('data', (b: Buffer) => (stdout += b.toString()));
    p.stderr.on('data', (b: Buffer) => (stderr += b.toString()));
    p.on('error', rej);
    p.on('close', (code) => {
      if (code === 0) res({ stdout, stderr });
      else rej(new Error(`${cmd} exit ${code}: ${stderr.slice(-400)}`));
    });
  });
}

// --- naive script-to-SRT ---
// We don't transcribe. We split the script into chunks of N words, distribute
// over the video duration, and emit timed cues. This is good enough for
// burned-in captions when paired with HeyGen's TTS-driven videos that follow
// the script line-for-line.

function chunkWords(text: string, wordsPerCue: number): string[] {
  const words = text.replace(/\s+/g, ' ').trim().split(' ');
  const out: string[] = [];
  for (let i = 0; i < words.length; i += wordsPerCue) {
    out.push(words.slice(i, i + wordsPerCue).join(' '));
  }
  return out;
}

function srtTime(s: number): string {
  const ms = Math.floor((s % 1) * 1000);
  const totalS = Math.floor(s);
  const ss = totalS % 60;
  const mm = Math.floor(totalS / 60) % 60;
  const hh = Math.floor(totalS / 3600);
  return `${pad(hh, 2)}:${pad(mm, 2)}:${pad(ss, 2)},${pad(ms, 3)}`;
}
function pad(n: number, w: number): string {
  return n.toString().padStart(w, '0');
}

function scriptToSrt(script: string, durationSeconds: number, wordsPerCue = 4): string {
  const cues = chunkWords(script, wordsPerCue);
  if (cues.length === 0) return '';
  const per = durationSeconds / cues.length;
  return cues
    .map((text, i) => {
      const start = i * per;
      const end = (i + 1) * per - 0.04;
      return `${i + 1}\n${srtTime(start)} --> ${srtTime(end)}\n${text}\n`;
    })
    .join('\n');
}

// --- main entry ---

export async function processPostProduction(input: PostProdInput): Promise<PostProdOutput> {
  await mkdir(ASSET_DIR, { recursive: true });
  const baseName = `${input.contentItemId.slice(0, 8)}-${Date.now()}`;

  if (env.DEMO_MODE || !(await hasFfmpeg())) {
    // Passthrough: just record the video URL with no transformation. The dashboard
    // and publishers handle the URL directly. SRT still generated for completeness.
    const srt = scriptToSrt(input.script, input.durationSeconds ?? 30);
    const srtPath = resolve(ASSET_DIR, `${baseName}.srt`);
    await writeFile(srtPath, srt, 'utf8');
    return {
      finalVideoPath: input.videoUrl,
      finalVideoUrl: input.videoUrl,
      srtPath,
      width: 720,
      height: 1280,
      durationSeconds: input.durationSeconds ?? 30,
      sizeBytes: 0,
      mode: 'passthrough',
    };
  }

  // --- real ffmpeg pipeline ---

  // 1. probe duration if not provided
  let duration = input.durationSeconds ?? 0;
  if (!duration) {
    const probe = await run('ffprobe', [
      '-v', 'error',
      '-show_entries', 'format=duration',
      '-of', 'default=nw=1:nk=1',
      input.videoUrl,
    ]);
    duration = parseFloat(probe.stdout.trim()) || 30;
  }

  // 2. write SRT sidecar
  const srt = scriptToSrt(input.script, duration);
  const srtPath = resolve(ASSET_DIR, `${baseName}.srt`);
  await writeFile(srtPath, srt, 'utf8');

  // 3. compose ffmpeg filter graph
  //    - scale + pad to 720x1280 (9:16)
  //    - burn subtitles from SRT with style preset
  //    - overlay hook text top, CTA bottom
  //    - normalize to TikTok-safe specs
  const finalPath = resolve(ASSET_DIR, `${baseName}.mp4`);
  const brandColor = input.brandColor ?? '#0ea5e9';
  const escSrt = srtPath.replace(/'/g, "\\'").replace(/:/g, '\\:');
  const escCta = (input.cta || '').replace(/['"\\:]/g, ' ').slice(0, 100);
  const escHook = (input.hookText || '').replace(/['"\\:]/g, ' ').slice(0, 80);

  const vf = [
    // scale + pad to 9:16
    'scale=720:1280:force_original_aspect_ratio=decrease',
    'pad=720:1280:(ow-iw)/2:(oh-ih)/2:black',
    // burned-in captions
    `subtitles='${escSrt}':force_style='Fontname=Arial,Fontsize=42,PrimaryColour=&H00ffffff,OutlineColour=&H00000000,BorderStyle=3,Outline=1,Shadow=0,MarginV=180,Alignment=2'`,
    // hook text top (visible 0-3s)
    escHook
      ? `drawtext=text='${escHook}':fontsize=44:fontcolor=white:x=(w-text_w)/2:y=80:box=1:boxcolor=black@0.6:boxborderw=14:enable='lt(t,3)'`
      : '',
    // CTA pill bottom (visible last 5s)
    escCta
      ? `drawtext=text='${escCta}':fontsize=34:fontcolor=white:x=(w-text_w)/2:y=h-130:box=1:boxcolor=${brandColor}@0.85:boxborderw=18:enable='gte(t,${Math.max(0, duration - 5)})'`
      : '',
  ]
    .filter(Boolean)
    .join(',');

  await run('ffmpeg', [
    '-y',
    '-i', input.videoUrl,
    '-vf', vf,
    '-c:v', 'libx264',
    '-pix_fmt', 'yuv420p',
    '-profile:v', 'high',
    '-preset', 'medium',
    '-crf', '21',
    '-r', '30',
    '-c:a', 'aac',
    '-b:a', '128k',
    '-ar', '44100',
    '-movflags', '+faststart',
    '-t', String(Math.min(60, duration)),
    finalPath,
  ]);

  const stats = await stat(finalPath);
  const finalUrl = `file://${finalPath}`;

  return {
    finalVideoPath: finalPath,
    finalVideoUrl: finalUrl,
    srtPath,
    width: 720,
    height: 1280,
    durationSeconds: duration,
    sizeBytes: stats.size,
    mode: 'real',
  };
}
