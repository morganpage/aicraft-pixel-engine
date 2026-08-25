#!/usr/bin/env node
/**
 * headless-shot.mjs — trustworthy screenshots of an engine game in a
 * headless browser. Copy into your game repo (`scripts/` is a good home)
 * and `npm i -D playwright-core pngjs` there; this repo stays
 * dependency-free.
 *
 * ## The failures it prevents (all paid for in debugging hours during a
 * real god-game build)
 *
 * 1. **GPU-readback screenshots of canvas are unreliable in headless
 *    Chrome.** `page.screenshot()` and `canvas.toDataURL()` both go through
 *    the GPU compositing path and intermittently return a black canvas (or
 *    a black band across the page) while the canvas bitmap is pixel-
 *    perfect — verified by counting cells through `getImageData` in the
 *    page. `--disable-gpu`, `--disable-gpu-compositing` and
 *    `--disable-features=CanvasOopRasterization` did NOT fix it;
 *    `--disable-accelerated-2d-canvas` plus the CPU readback below did.
 *
 * 2. **Never trust the GPU path when you can trust the CPU path.** The
 *    canvas is read in-page via `getImageData` (which never failed), sent
 *    to Node as base64, rebuilt into a PNG with pngjs, and composited over
 *    the page screenshot at the canvas's on-screen position. The page
 *    screenshot supplies the surrounding UI; the canvas pixels are ground
 *    truth.
 *
 * 3. **Garbage sessions happen.** A near-black probe of where the planet
 *    should be exits with code 42 so a wrapper loop can retry:
 *    `until node scripts/headless-shot.mjs …; do :; done` style, or check
 *    `$? -eq 42`.
 *
 * 4. **Vision models misdescribe screenshots** (flipped left/right,
 *    hallucinated features on pristine boots). Verify with pixel probes
 *    instead: `--probe cx,cy,w,h,r,g,b,tol` prints how many pixels in the
 *    region match the colour within tolerance, and fails the run when a
 *    `--probe-min N` floor is given. Count pixels; don't ask a model.
 *
 * Usage:
 *   node scripts/headless-shot.mjs http://localhost:5173 \
 *     --out shot.png [--selector "#game"] [--ready "__ready"] \
 *     [--wait-ms 2000] [--chrome "/path/to/Chrome"] \
 *     [--probe 284,300,72,72,80,80,80,24] [--probe-min 1000]
 *
 * `--ready` waits for a truthy `window[<ready>]` flag your game sets when
 * the first frame has rendered, so you never screenshot a boot race.
 */

import { chromium } from 'playwright-core';
import { PNG } from 'pngjs';
import fs from 'node:fs';

const args = process.argv.slice(2);
const url = args.shift();
if (!url || url.startsWith('--')) {
  console.error('usage: headless-shot.mjs <url> --out <file> [options]');
  process.exit(64);
}

const opt = (name, fallback) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};
const OUT = opt('out', 'shot.png');
const SELECTOR = opt('selector', 'canvas');
const READY = opt('ready', null);
const WAIT_MS = Number(opt('wait-ms', '1500'));
const CHROME =
  opt('chrome', null) ?? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
// Probe syntax: x,y,w,h,r,g,b,tol (grid-space colour at 1× zoom; the canvas
// may be CSS-scaled — probes run on the ground-truth bitmap, not the page).
const PROBES = args.filter((_, i, a) => a[i - 1] === '--probe');
const PROBE_MIN = Number(opt('probe-min', '0'));

const browser = await chromium.launch({
  executablePath: CHROME,
  args: ['--disable-accelerated-2d-canvas'],
});
const VIEWPORT = 900;
try {
  const page = await browser.newPage({ viewport: { width: VIEWPORT, height: VIEWPORT } });
  await page.goto(url, { waitUntil: 'networkidle' });
  if (READY) {
    await page.waitForFunction((p) => !!window[p], READY, { timeout: 20000 });
  }
  await page.waitForTimeout(WAIT_MS);

  // Ground truth: the canvas bitmap via the CPU readback path.
  const truth = await page.evaluate((sel) => {
    const c = document.querySelector(sel);
    if (!c) throw new Error(`no element matches ${sel}`);
    const d = c.getContext('2d').getImageData(0, 0, c.width, c.height);
    let bin = '';
    for (let i = 0; i < d.data.length; i += 0x8000) {
      bin += String.fromCharCode.apply(null, d.data.subarray(i, i + 0x8000));
    }
    return { w: c.width, h: c.height, b64: btoa(bin) };
  }, SELECTOR);

  // Page chrome around it: regular screenshot (may be partially black —
  // that's fine, the canvas region is overwritten below).
  const pageBuf = await page.screenshot();
  const box = await page.locator(SELECTOR).boundingBox();
  if (!box) throw new Error(`no box for ${SELECTOR} — element not visible`);
  const pagePng = PNG.sync.read(pageBuf);
  const scale = pagePng.width / VIEWPORT; // device pixel ratio of the shot
  const canvasW2 = Math.round(box.width * scale);
  const canvasH2 = Math.round(box.height * scale);
  const canvasX = Math.round(box.x * scale);
  const canvasY = Math.round(box.y * scale);

  // Composite: nearest-neighbour blit of the truth bitmap over the page shot.
  const truthBytes = Buffer.from(truth.b64, 'base64');
  for (let y = 0; y < canvasH2; y++) {
    const sy = Math.floor((y / canvasH2) * truth.h);
    for (let x = 0; x < canvasW2; x++) {
      const sx = Math.floor((x / canvasW2) * truth.w);
      const s = (sy * truth.w + sx) * 4;
      const d = (pagePng.width * (canvasY + y) + canvasX + x) << 2;
      pagePng.data[d] = truthBytes[s];
      pagePng.data[d + 1] = truthBytes[s + 1];
      pagePng.data[d + 2] = truthBytes[s + 2];
      pagePng.data[d + 3] = 255;
    }
  }
  fs.writeFileSync(OUT, PNG.sync.write(pagePng));

  // Garbage detector: the canvas centre must not be near-black (a black
  // canvas here means a failed readback, not a dark game).
  const cx = canvasX + (canvasW2 >> 1), cy = canvasY + (canvasH2 >> 1);
  const centre = (pagePng.width * cy + cx) << 2;
  const lum = (pagePng.data[centre] + pagePng.data[centre + 1] + pagePng.data[centre + 2]) / 3;
  if (lum < 8) {
    console.error(`garbage session: canvas centre luma ${lum.toFixed(1)} — retry`);
    process.exit(42);
  }

  // Pixel probes on the ground-truth bitmap (grid space).
  let ok = true;
  for (const p of PROBES) {
    const [x, y, w, h, r, g, b, tol] = p.split(',').map(Number);
    let count = 0;
    for (let yy = y; yy < y + h && yy < truth.h; yy++) {
      for (let xx = x; xx < x + w && xx < truth.w; xx++) {
        const o = (yy * truth.w + xx) * 4;
        if (Math.abs(truthBytes[o] - r) <= tol &&
            Math.abs(truthBytes[o + 1] - g) <= tol &&
            Math.abs(truthBytes[o + 2] - b) <= tol) count++;
      }
    }
    console.log(`probe ${p} → ${count} px`);
    if (count < PROBE_MIN) ok = false;
  }
  console.log(`wrote ${OUT} (${truth.w}×${truth.h} canvas over ${pagePng.width}×${pagePng.height} page)`);
  process.exit(ok ? 0 : 1);
} finally {
  await browser.close();
}
