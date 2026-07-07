import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readdirSync, existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { chromium, type Browser } from 'playwright';
import { computeBlockHash, renderBlockFrames } from '../../src/hf/block-render.js';

// Fixture block: no GSAP, no network. Registers a fake timeline implementing
// the { duration, pause, seek } interface the renderer relies on, and mirrors
// seek progress into the DOM so frames are visually distinguishable.
const FIXTURE_BLOCK = `<!doctype html>
<html><head><style>
  html, body { margin: 0; width: 320px; height: 180px; background: transparent; }
  #bar { position: absolute; top: 80px; left: 0; height: 20px; background: rgb(255, 0, 0); width: 0; }
</style></head>
<body>
  <div id="root" data-composition-id="fixture"><div id="bar"></div></div>
  <script>
    window.__timelines = {
      fixture: {
        _t: 0,
        duration() { return 2; },
        pause() {},
        seek(t) { this._t = t; document.getElementById('bar').style.width = (t / 2) * 320 + 'px'; },
      },
    };
  </script>
</body></html>`;

describe('computeBlockHash', () => {
  it('is stable and sensitive to every component', () => {
    const base = computeBlockHash('<html>', { '--x': '1' }, 1000, 30, 320, 180);
    expect(base).toMatch(/^[0-9a-f]{16}$/);
    expect(computeBlockHash('<html>', { '--x': '1' }, 1000, 30, 320, 180)).toBe(base);
    expect(computeBlockHash('<html>!', { '--x': '1' }, 1000, 30, 320, 180)).not.toBe(base);
    expect(computeBlockHash('<html>', { '--x': '2' }, 1000, 30, 320, 180)).not.toBe(base);
    expect(computeBlockHash('<html>', { '--x': '1' }, 1500, 30, 320, 180)).not.toBe(base);
    expect(computeBlockHash('<html>', undefined, 1000, 30, 320, 180)).toBe(
      computeBlockHash('<html>', {}, 1000, 30, 320, 180),
    );
  });
});

describe('renderBlockFrames', () => {
  let browser: Browser;
  let tmp: string;

  beforeAll(async () => { browser = await chromium.launch(); }, 60_000);
  afterAll(async () => { await browser.close(); });
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'argo-blockrender-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('renders N frames by seeking the registered timeline', async () => {
    const blockPath = join(tmp, 'fixture.html');
    writeFileSync(blockPath, FIXTURE_BLOCK);
    const outDir = join(tmp, 'frames');
    const n = await renderBlockFrames({
      blockHtmlPath: blockPath, outputDir: outDir,
      durationMs: 1000, fps: 10, width: 320, height: 180, browser,
    });
    expect(n).toBe(10);
    const frames = readdirSync(outDir).filter((f) => f.endsWith('.png')).sort();
    expect(frames).toHaveLength(10);
    expect(frames[0]).toBe('frame_0000.png');
    expect(frames[9]).toBe('frame_0009.png');
    // first and last frame must differ (bar width animates with seek)
    expect(readFileSync(join(outDir, 'frame_0000.png')).equals(readFileSync(join(outDir, 'frame_0009.png')))).toBe(false);
  }, 60_000);

  it('applies params as CSS custom properties on the document root', async () => {
    const blockPath = join(tmp, 'fx.html');
    writeFileSync(blockPath, FIXTURE_BLOCK.replace('rgb(255, 0, 0)', 'var(--bar-color, rgb(255, 0, 0))'));
    const a = join(tmp, 'a');
    const b = join(tmp, 'b');
    await renderBlockFrames({ blockHtmlPath: blockPath, outputDir: a, durationMs: 200, fps: 5, width: 320, height: 180, browser });
    await renderBlockFrames({ blockHtmlPath: blockPath, outputDir: b, durationMs: 200, fps: 5, width: 320, height: 180, params: { '--bar-color': 'rgb(0, 0, 255)' }, browser });
    expect(readFileSync(join(a, 'frame_0000.png')).equals(readFileSync(join(b, 'frame_0000.png')))).toBe(false);
  }, 60_000);

  it('fails with an actionable error when no timeline is registered', async () => {
    const blockPath = join(tmp, 'no-tl.html');
    writeFileSync(blockPath, '<!doctype html><html><body><div>static</div></body></html>');
    await expect(
      renderBlockFrames({ blockHtmlPath: blockPath, outputDir: join(tmp, 'out'), durationMs: 200, fps: 5, width: 320, height: 180, browser }),
    ).rejects.toThrow(/__timelines/);
  }, 60_000);
});
