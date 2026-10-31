// Captures named stills of real Helix UI states for the promo (dark theme, 1920x1080 CSS px at 2x).
// Run with the web app serving on script/shots.json `base`.
// Usage: node tools/capture.cjs [source ...]   (Playwright must be resolvable, e.g. NODE_PATH=$(npm root -g))
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const root = path.resolve(__dirname, '..');
const plan = JSON.parse(fs.readFileSync(path.join(root, 'script/shots.json'), 'utf8'));
const only = process.argv.slice(2);

(async () => {
  const browser = await chromium.launch();
  for (const shot of plan.shots) {
    if (only.length && !only.includes(shot.source)) continue;
    const source = plan.sources[shot.source];
    const dir = path.join(root, 'footage/stills', shot.source);
    fs.rmSync(dir, { recursive: true, force: true });
    fs.mkdirSync(dir, { recursive: true });
    const context = await browser.newContext({
      viewport: source.viewport ?? { width: 1920, height: 1080 },
      deviceScaleFactor: 2,
      colorScheme: 'dark',
    });
    const page = await context.newPage();
    await page.goto(plan.base + source.url, { waitUntil: 'networkidle' });
    await page.waitForTimeout(1500);
    // Freeze the replay so only scripted steps move it.
    const pause = page.getByRole('button', { name: /^Pause/ });
    if (await pause.count()) await pause.first().click();
    const stills = [];
    for (const step of shot.steps) {
      if (step.click)
        await page
          .getByRole(step.role ?? 'button', { name: new RegExp(`^${step.click}`) })
          .first()
          .click();
      if (step.milestone)
        await page.selectOption('select[aria-label="Jump to milestone"]', step.milestone);
      if (step.text)
        await page
          .locator(step.within ?? 'body')
          .getByText(step.text, { exact: true })
          .first()
          .click();
      for (let i = 0; i < (step.next ?? 0); i++)
        await page
          .getByRole('button', { name: /^Next event/ })
          .first()
          .click();
      await page.waitForTimeout(1000);
      if (step.still) {
        await page.screenshot({
          path: path.join(dir, `${step.still}.jpg`),
          type: 'jpeg',
          quality: 92,
        });
        stills.push(step.still);
      }
    }
    fs.writeFileSync(
      path.join(dir, 'manifest.json'),
      JSON.stringify(
        { source: shot.source, url: source.url, simulated: source.simulated, stills },
        null,
        1,
      ) + '\n',
    );
    console.log(shot.source, stills.length, 'stills');
    await context.close();
  }
  await browser.close();
})();
