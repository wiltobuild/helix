// Captures real Helix UI frames for the promo. Run with the web app serving on script/shots.json `base`.
// Usage: node tools/capture.cjs [shotId ...]   (Playwright must be resolvable, e.g. NODE_PATH=$(npm root -g))
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const plan = JSON.parse(fs.readFileSync(path.join(root, 'script/shots.json'), 'utf8'));
const only = process.argv.slice(2);

async function shoot(page, dir, frames, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const file = `${String(frames.length + 1).padStart(4, '0')}.jpg`;
    const t = Date.now();
    await page.screenshot({ path: path.join(dir, file), type: 'jpeg', quality: 90 });
    frames.push({ file, t });
  }
}

(async () => {
  const browser = await chromium.launch();
  for (const shot of plan.shots) {
    if (only.length && !only.includes(shot.id)) continue;
    const dir = path.join(root, 'footage/frames', shot.id);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({
      viewport: { width: 1920, height: 1080 },
      colorScheme: 'dark',
      deviceScaleFactor: 2,
      reducedMotion: 'no-preference',
    });
    const page = await context.newPage();
    await page.goto(plan.base + shot.url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    // Freeze the replay so only scripted steps move it.
    const pause = page.getByRole('button', { name: /^Pause/ });
    if (await pause.count()) await pause.first().click();
    const frames = [];
    for (const step of shot.steps) {
      if (step.milestone) {
        await page.selectOption('select[aria-label="Jump to milestone"]', step.milestone);
      } else if (step.click) {
        await page
          .getByRole(step.role ?? 'button', { name: new RegExp(`^${step.click}`) })
          .first()
          .click();
      } else if (step.wait) {
        await page.waitForTimeout(step.wait);
      } else if (step.shoot) {
        await shoot(page, dir, frames, step.shoot);
      } else if (step.next) {
        for (let i = 0; i < step.next; i++) {
          await page
            .getByRole('button', { name: /^Next event/ })
            .first()
            .click();
          await shoot(page, dir, frames, step.shootEach ?? 600);
        }
      }
    }
    const t0 = frames[0]?.t ?? 0;
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify(
        {
          id: shot.id,
          simulated: !!shot.simulated,
          frames: frames.map((f) => ({ file: f.file, ms: f.t - t0 })),
        },
        null,
        1,
      ),
    );
    console.log(shot.id, frames.length, 'frames');
    await context.close();
  }
  await browser.close();
})();
