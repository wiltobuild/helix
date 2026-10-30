// Renders a timeline through stage/stage.html into an H.264 MP4 (1920x1080, 30fps).
// Usage: node tools/render.cjs <out/timeline-*.json> <out.mp4> [--clean] [--watermark "text"]
//        [--stills t1,t2,...]   (writes PNG stills instead of a video)
//        [--audio file.wav]
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { chromium } = require('playwright');

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const [timelinePath, outPath] = args;
const timeline = JSON.parse(fs.readFileSync(timelinePath, 'utf8'));
const clean = args.includes('--clean');
const stills = flag('--stills');
const audio = flag('--audio');

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
  await page.goto('file://' + path.resolve(__dirname, '../stage/stage.html'));
  await page.evaluate(
    ([tl, opt]) => window.load(tl, opt),
    [timeline, { clean, watermark: flag('--watermark') }],
  );

  if (stills) {
    for (const t of stills.split(',').map(Number)) {
      await page.evaluate((s) => window.renderAt(s), t);
      await page.screenshot({ path: `${outPath}-${t.toFixed(2)}.png` });
    }
    await browser.close();
    return;
  }

  const fps = timeline.fps;
  const total = Math.round(timeline.total * fps);
  const ff = spawn(
    'ffmpeg',
    [
      '-y',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      String(fps),
      '-c:v',
      'png',
      '-i',
      '-',
      ...(audio ? ['-i', audio] : []),
      '-c:v',
      'libx264',
      '-preset',
      'slow',
      '-crf',
      '16',
      '-pix_fmt',
      'yuv420p',
      '-profile:v',
      'high',
      '-r',
      String(fps),
      '-movflags',
      '+faststart',
      ...(audio ? ['-c:a', 'aac', '-b:a', '256k', '-shortest'] : []),
      outPath,
    ],
    { stdio: ['pipe', 'inherit', 'inherit'] },
  );
  for (let f = 0; f < total; f++) {
    await page.evaluate((s) => window.renderAt(s), f / fps);
    const buf = await page.screenshot({ type: 'png' });
    if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once('drain', r));
    if (f % 150 === 0) process.stdout.write(`frame ${f}/${total}\n`);
  }
  ff.stdin.end();
  await new Promise((r) => ff.on('close', r));
  await browser.close();
  console.log('wrote', outPath);
})();
