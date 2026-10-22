// Renders film.html to an MP4: steps window.__render(t) frame by frame in headless Chromium,
// then muxes the frames with the synthesized score.
//   node render.mjs out.mp4 [--fps 30] [--workers 4] [--stills 3,17,30]
import { chromium } from 'playwright';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(k); return i >= 0 ? args[i + 1] : d; };
const out = resolve(args[0] || 'helix-promo.mp4');
const fps = +opt('--fps', 30), workers = +opt('--workers', 4), DUR = 64;
const stills = opt('--stills', null);
const work = mkdtempSync(join(process.env.TMPDIR || tmpdir(), 'helix-render-'));

// The artifact host wraps film.html in a document skeleton; do the same locally so it renders in standards mode.
const page = join(work, 'film.html');
writeFileSync(page, '<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head><body>'
  + readFileSync(join(here, 'film.html'), 'utf8') + '</body></html>');
const url = 'file://' + page + '?capture';

async function open(browser) {
  const p = await browser.newPage({ viewport: { width: 1920, height: 1080 }, deviceScaleFactor: 1 });
  p.on('pageerror', e => console.error('page error:', e.message));
  await p.goto(url);
  await p.evaluate(() => window.__ready);
  await p.waitForTimeout(300);
  return p;
}

const browser = await chromium.launch();
if (stills) {
  const p = await open(browser);
  for (const t of stills.split(',').map(Number)) {
    await p.evaluate(t => window.__render(t), t);
    await p.screenshot({ path: join(dirname(out), `still-${String(t).padStart(5, '0')}.png`) });
  }
  await browser.close();
  process.exit(0);
}

const frames = Math.round(DUR * fps), dir = join(work, 'frames');
mkdirSync(dir);
let done = 0;
await Promise.all(Array.from({ length: workers }, async (_, w) => {
  const p = await open(browser);
  const a = Math.floor(frames * w / workers), b = Math.floor(frames * (w + 1) / workers);
  // warm up from slightly earlier so per-frame DOM caches match a sequential render
  for (let f = Math.max(0, a - 3); f < b; f++) {
    await p.evaluate(t => window.__render(t), f / fps);
    if (f < a) continue;
    await p.screenshot({ path: join(dir, `f${String(f).padStart(5, '0')}.jpg`), type: 'jpeg', quality: 95 });
    if (++done % 150 === 0) console.log(`${done}/${frames} frames`);
  }
}));
await browser.close();

const wav = join(work, 'score.wav');
execFileSync('python3', [join(here, 'score.py'), wav], { stdio: 'inherit' });
execFileSync('ffmpeg', ['-y', '-loglevel', 'error', '-framerate', String(fps), '-i', join(dir, 'f%05d.jpg'), '-i', wav,
  '-c:v', 'libx264', '-preset', 'slow', '-crf', '26', '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
  '-c:a', 'aac', '-b:a', '192k', '-shortest', out], { stdio: 'inherit' });
rmSync(work, { recursive: true, force: true });
console.log('wrote', out);
