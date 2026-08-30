import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, existsSync, statSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);
import { SHADERS, isValidShaderName, SHADER_NAMES } from '../../src/transitions/shaders/index.js';
import type { TransitionConfig } from '../../src/config.js';

// ffmpeg probe — tests that invoke ffmpeg skip when it's not available on the
// host (e.g., minimal dev environments, some CI runners). CI workflows that
// should actually exercise these tests install ffmpeg explicitly.
let hasFfmpeg = false;
try {
  await execFileP('ffmpeg', ['-version']);
  hasFfmpeg = true;
} catch {
  hasFfmpeg = false;
}

describe('shader registry', () => {
  it('ships the v1 five plus the hyperframes ports', () => {
    expect(SHADER_NAMES).toEqual([
      'crosswarp', 'swirl', 'ripple', 'luma-mask', 'light-leak',
      'domain-warp', 'ridged-burn', 'thermal-distortion', 'swirl-vortex',
      'whip-pan', 'gravitational-lens', 'cinematic-zoom', 'chromatic-split', 'flash-through-white',
      'sdf-iris', 'ripple-waves',
    ]);
  });

  it('each shader has non-empty GLSL source', () => {
    for (const name of SHADER_NAMES) {
      expect(SHADERS[name].length).toBeGreaterThan(50);
      expect(SHADERS[name]).toContain('uniform');
      expect(SHADERS[name]).toContain('progress');
    }
  });

  it('isValidShaderName checks membership', () => {
    expect(isValidShaderName('crosswarp')).toBe(true);
    expect(isValidShaderName('bogus')).toBe(false);
  });
});

describe('TransitionConfig shader variant', () => {
  it('accepts { type: "shader", shader: ... } at compile time', () => {
    const cfg: TransitionConfig = {
      type: 'shader',
      shader: 'crosswarp',
      durationMs: 800,
    };
    expect(cfg.type).toBe('shader');
  });
});

describe('computeShaderHash', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'argo-shader-hash-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('produces stable hash for identical inputs', async () => {
    const { computeShaderHash } = await import('../../src/transitions/shader-render.js');
    const a = join(tmp, 'a.png');
    const b = join(tmp, 'b.png');
    writeFileSync(a, Buffer.from('aaa'));
    writeFileSync(b, Buffer.from('bbb'));
    const h1 = computeShaderHash('crosswarp', 800, 30, 1920, 1080, a, b);
    const h2 = computeShaderHash('crosswarp', 800, 30, 1920, 1080, a, b);
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{16}$/);
  });

  it('differs when shader name changes', async () => {
    const { computeShaderHash } = await import('../../src/transitions/shader-render.js');
    const a = join(tmp, 'a.png');
    const b = join(tmp, 'b.png');
    writeFileSync(a, Buffer.from('aaa'));
    writeFileSync(b, Buffer.from('bbb'));
    expect(
      computeShaderHash('crosswarp', 800, 30, 1920, 1080, a, b)
    ).not.toBe(
      computeShaderHash('swirl', 800, 30, 1920, 1080, a, b)
    );
  });

  it('differs when boundary frame content changes', async () => {
    const { computeShaderHash } = await import('../../src/transitions/shader-render.js');
    const a = join(tmp, 'a.png');
    const b = join(tmp, 'b.png');
    writeFileSync(a, Buffer.from('aaa'));
    writeFileSync(b, Buffer.from('bbb'));
    const h1 = computeShaderHash('crosswarp', 800, 30, 1920, 1080, a, b);
    writeFileSync(a, Buffer.from('different'));
    const h2 = computeShaderHash('crosswarp', 800, 30, 1920, 1080, a, b);
    expect(h1).not.toBe(h2);
  });
});

describe('extractBoundaryFrame', () => {
  const sampleVideo = join(process.cwd(), 'tests/fixtures/sample-2s.mp4');
  const hasSample = existsSync(sampleVideo);

  it.runIf(hasSample && hasFfmpeg)('extracts a PNG at the given timestamp', async () => {
    const { extractBoundaryFrame } = await import('../../src/transitions/shader-render.js');
    const tmp = mkdtempSync(join(tmpdir(), 'argo-frame-'));
    const out = join(tmp, 'frame.png');
    await extractBoundaryFrame(sampleVideo, 1.0, out);
    expect(existsSync(out)).toBe(true);
    expect(statSync(out).size).toBeGreaterThan(100);
    rmSync(tmp, { recursive: true, force: true });
  });

  it.runIf(hasSample && hasFfmpeg)('throws a clear error when ffmpeg fails', async () => {
    const { extractBoundaryFrame } = await import('../../src/transitions/shader-render.js');
    const tmp = mkdtempSync(join(tmpdir(), 'argo-frame-err-'));
    const out = join(tmp, 'frame.png');
    await expect(
      extractBoundaryFrame('/nonexistent/video.mp4', 1.0, out)
    ).rejects.toThrow(/Failed to extract/);
    rmSync(tmp, { recursive: true, force: true });
  });
});

describe('renderShaderFrames', () => {
  const hasSample = existsSync(join(process.cwd(), 'tests/fixtures/sample-2s.mp4'));

  it.runIf(hasSample && hasFfmpeg)('renders N = duration_ms * fps / 1000 frames', async () => {
    const { renderShaderFrames } = await import('../../src/transitions/shader-render.js');
    const tmp = mkdtempSync(join(tmpdir(), 'argo-render-'));
    const aPng = join(tmp, 'a.png');
    const bPng = join(tmp, 'b.png');
    await execFileP('ffmpeg', ['-f', 'lavfi', '-i', 'color=red:s=320x180', '-frames:v', '1', '-y', aPng]);
    await execFileP('ffmpeg', ['-f', 'lavfi', '-i', 'color=blue:s=320x180', '-frames:v', '1', '-y', bPng]);

    const outDir = join(tmp, 'frames');
    await renderShaderFrames({
      shader: 'crosswarp',
      aPng, bPng,
      width: 320, height: 180,
      fps: 30,
      durationMs: 500,  // 15 frames
      outputDir: outDir,
    });

    const files = readdirSync(outDir).filter(f => f.endsWith('.png')).sort();
    expect(files).toHaveLength(15);
    expect(files[0]).toBe('frame_0000.png');
    expect(files[14]).toBe('frame_0014.png');
    // Each frame must be a real PNG > 100 bytes
    for (const f of files) {
      expect(statSync(join(outDir, f)).size).toBeGreaterThan(100);
    }
    rmSync(tmp, { recursive: true, force: true });
  }, 60000);
});

describe('renderShaderTransitions', () => {
  const hasSample = existsSync(join(process.cwd(), 'tests/fixtures/sample-2s.mp4'));

  it.runIf(hasSample && hasFfmpeg)('renders each boundary and caches by content hash', async () => {
    const { renderShaderTransitions } = await import('../../src/transitions/shader-render.js');
    const tmp = mkdtempSync(join(tmpdir(), 'argo-orch-'));
    const cacheDir = join(tmp, 'shaders');
    const sample = join(process.cwd(), 'tests/fixtures/sample-2s.mp4');

    const boundaries = [
      { boundarySec: 0.5, durationMs: 400 },
      { boundarySec: 1.5, durationMs: 400 },
    ];

    const result = await renderShaderTransitions({
      videoPath: sample,
      boundaries,
      shader: 'crosswarp',
      width: 320, height: 180, fps: 30,
      cacheDir,
    });

    expect(result).toHaveLength(2);
    expect(result[0].frameCount).toBe(12);  // 400ms * 30fps / 1000
    expect(result[0].pngDir).toBeTruthy();
    expect(result[0].hash).toMatch(/^[0-9a-f]{16}$/);

    // Second run hits cache
    const mtimeBefore = statSync(join(result[0].pngDir, 'frame_0000.png')).mtimeMs;
    await new Promise(r => setTimeout(r, 50));
    const result2 = await renderShaderTransitions({
      videoPath: sample, boundaries, shader: 'crosswarp',
      width: 320, height: 180, fps: 30, cacheDir,
    });
    const mtimeAfter = statSync(join(result2[0].pngDir, 'frame_0000.png')).mtimeMs;
    expect(mtimeAfter).toBe(mtimeBefore);  // file untouched → cache hit

    rmSync(tmp, { recursive: true, force: true });
  }, 120000);
});

describe('computeShaderHash accent', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'argo-shader-accent-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it('different accent produces a different hash', async () => {
    const { computeShaderHash } = await import('../../src/transitions/shader-render.js');
    const a = join(tmp, 'a.png');
    const b = join(tmp, 'b.png');
    writeFileSync(a, Buffer.from([1, 2, 3]));
    writeFileSync(b, Buffer.from([4, 5, 6]));
    const h1 = computeShaderHash('crosswarp', 800, 30, 640, 360, a, b, '#0ea5e9');
    const h2 = computeShaderHash('crosswarp', 800, 30, 640, 360, a, b, '#ff0000');
    expect(h1).not.toBe(h2);
  });

  it('omitted accent equals DEFAULT_ACCENT hash', async () => {
    const { computeShaderHash } = await import('../../src/transitions/shader-render.js');
    const { DEFAULT_ACCENT } = await import('../../src/transitions/accent.js');
    const a = join(tmp, 'a.png');
    const b = join(tmp, 'b.png');
    writeFileSync(a, Buffer.from([1, 2, 3]));
    writeFileSync(b, Buffer.from([4, 5, 6]));
    expect(computeShaderHash('crosswarp', 800, 30, 640, 360, a, b))
      .toBe(computeShaderHash('crosswarp', 800, 30, 640, 360, a, b, DEFAULT_ACCENT));
  });

  it('accent hex case does not change the hash', async () => {
    const { computeShaderHash } = await import('../../src/transitions/shader-render.js');
    const a = join(tmp, 'a.png');
    const b = join(tmp, 'b.png');
    writeFileSync(a, Buffer.from([1, 2, 3]));
    writeFileSync(b, Buffer.from([4, 5, 6]));
    expect(computeShaderHash('crosswarp', 800, 30, 640, 360, a, b, '#0EA5E9'))
      .toBe(computeShaderHash('crosswarp', 800, 30, 640, 360, a, b, '#0ea5e9'));
  });
});

describe('buildShaderPageHtml uniforms', () => {
  it('embeds accent values and resolution setup', async () => {
    const { buildShaderPageHtml } = await import('../../src/transitions/shader-page.html.js');
    const { deriveAccentColors } = await import('../../src/transitions/accent.js');
    const html = buildShaderPageHtml(640, 360, 'void main(){}', deriveAccentColors('#ff8000'));
    expect(html).toContain('accentDark');
    expect(html).toContain('resolution');
    expect(html).toContain('gl.uniform2f');
  });

  it('accepts a shader-variant config with accent at compile time', () => {
    const cfg: TransitionConfig = {
      type: 'shader',
      shader: 'crosswarp',
      durationMs: 800,
      accent: '#ff8000',
    };
    expect(cfg.type).toBe('shader');
  });
});

describe('every registered shader compiles and renders', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'argo-shader-smoke-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it.skipIf(!hasFfmpeg)('renders one frame per shader without GL errors', async () => {
    const { renderShaderFrames } = await import('../../src/transitions/shader-render.js');
    const { chromium } = await import('playwright');
    // two tiny solid-color PNG fixtures via ffmpeg
    const a = join(tmp, 'a.png');
    const b = join(tmp, 'b.png');
    await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=red:s=64x36', '-frames:v', '1', a]);
    await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=blue:s=64x36', '-frames:v', '1', b]);
    const browser = await chromium.launch({
      args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-webgl', '--ignore-gpu-blacklist'],
    });
    try {
      for (const shader of SHADER_NAMES) {
        const outDir = join(tmp, shader);
        const n = await renderShaderFrames({
          shader, aPng: a, bPng: b, width: 64, height: 36,
          fps: 30, durationMs: 66, outputDir: outDir, browser,
        });
        expect(n, shader).toBeGreaterThanOrEqual(1);
        expect(existsSync(join(outDir, 'frame_0000.png')), shader).toBe(true);
      }
    } finally {
      await browser.close();
    }
  }, 120_000);
});

describe('renderShaderTransitions boundary clamping', () => {
  let tmp: string;
  beforeEach(() => { tmp = mkdtempSync(join(tmpdir(), 'argo-shader-clamp-')); });
  afterEach(() => { rmSync(tmp, { recursive: true, force: true }); });

  it.skipIf(!hasFfmpeg)('clamps a boundary past the video end instead of failing', async () => {
    const { renderShaderTransitions } = await import('../../src/transitions/shader-render.js');
    // 2-second test video
    const video = join(tmp, 'v.mp4');
    await execFileP('ffmpeg', ['-y', '-f', 'lavfi', '-i', 'color=red:s=64x36:d=2', '-r', '30', video]);
    // boundary at 5s — well past the 2s video (mark-drift scenario)
    const results = await renderShaderTransitions({
      videoPath: video,
      boundaries: [{ boundarySec: 5, durationMs: 200 }],
      shader: 'crosswarp',
      width: 64, height: 36, fps: 30,
      cacheDir: join(tmp, 'cache'),
    });
    expect(results).toHaveLength(1);
    expect(results[0].frameCount).toBeGreaterThanOrEqual(1);
    expect(existsSync(join(results[0].pngDir, 'frame_0000.png'))).toBe(true);
  }, 120_000);
});
