import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { showOverlay, hideOverlay, withOverlay, resolveCue } from '../../src/overlays/index.js';
import { resetManifestCache } from '../../src/overlays/manifest-loader.js';
import type { Page } from '@playwright/test';
import { writeFileSync, mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

function createMockPage() {
  return {
    evaluate: vi.fn(),
    waitForTimeout: vi.fn(),
  } as unknown as Page;
}

describe('showOverlay', () => {
  let page: Page;
  beforeEach(() => { page = createMockPage(); });

  it('injects overlay and removes after duration', async () => {
    await showOverlay(page, 'intro', { type: 'lower-third', text: 'Hello' }, 2000);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
    expect(page.waitForTimeout).toHaveBeenCalledWith(2000);
  });

  it('defaults to bottom-center zone', async () => {
    await showOverlay(page, 'intro', { type: 'lower-third', text: 'Hi' }, 1000);
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args[0]).toContain('bottom-center');
  });

  it('uses specified zone', async () => {
    await showOverlay(page, 'intro', {
      type: 'headline-card', title: 'Title', placement: 'top-left',
    }, 1000);
    const [, args] = (page.evaluate as any).mock.calls[0];
    expect(args[0]).toContain('top-left');
  });
});

describe('hideOverlay', () => {
  it('removes overlay from specified zone', async () => {
    const page = createMockPage();
    await hideOverlay(page, 'top-left');
    expect(page.evaluate).toHaveBeenCalledTimes(1);
  });

  it('defaults to bottom-center', async () => {
    const page = createMockPage();
    await hideOverlay(page);
    const [, arg] = (page.evaluate as any).mock.calls[0];
    expect(arg).toContain('bottom-center');
  });
});

describe('withOverlay', () => {
  let page: Page;
  beforeEach(() => { page = createMockPage(); });

  it('shows overlay during action and removes after', async () => {
    let actionRan = false;
    await withOverlay(page, 'demo', { type: 'callout', text: 'Watch' }, async () => {
      actionRan = true;
    });
    expect(actionRan).toBe(true);
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });

  it('removes overlay even if action throws', async () => {
    await expect(
      withOverlay(page, 'demo', { type: 'lower-third', text: 'Hi' }, async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(page.evaluate).toHaveBeenCalledTimes(2);
  });
});

describe('manifest-based resolution', () => {
  let page: Page;
  let tmpDir: string;
  let manifestPath: string;
  const originalEnv = process.env.ARGO_OVERLAYS_PATH;

  beforeEach(() => {
    page = createMockPage();
    tmpDir = mkdtempSync(join(tmpdir(), 'argo-overlay-test-'));
    manifestPath = join(tmpDir, 'test.scenes.json');
    const manifest = [
      {
        scene: 'hero',
        text: 'Welcome to Argo',
        overlay: {
          type: 'headline-card',
          title: 'Welcome',
          kicker: 'Argo Demo',
          placement: 'center',
        },
      },
      {
        scene: 'features',
        text: 'Key features',
        overlay: {
          type: 'lower-third',
          text: 'Features Overview',
          motion: 'slide-in',
        },
      },
    ];
    writeFileSync(manifestPath, JSON.stringify(manifest));
    process.env.ARGO_OVERLAYS_PATH = manifestPath;
    resetManifestCache();
  });

  afterEach(() => {
    if (originalEnv === undefined) {
      delete process.env.ARGO_OVERLAYS_PATH;
    } else {
      process.env.ARGO_OVERLAYS_PATH = originalEnv;
    }
    resetManifestCache();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('resolveCue', () => {
    it('returns manifest cue when no inline cue provided', () => {
      const cue = resolveCue('hero');
      expect(cue).toEqual({
        type: 'headline-card',
        title: 'Welcome',
        kicker: 'Argo Demo',
        placement: 'center',
      });
    });

    it('merges overrides into manifest cue', () => {
      const cue = resolveCue('hero', { motion: 'fade-in' });
      expect(cue).toEqual({
        type: 'headline-card',
        title: 'Welcome',
        kicker: 'Argo Demo',
        placement: 'center',
        motion: 'fade-in',
      });
    });

    it('uses full inline cue when type is provided', () => {
      const cue = resolveCue('hero', { type: 'callout', text: 'Override' });
      // inline wins over manifest for provided fields, manifest fills the rest
      expect(cue.type).toBe('callout');
      expect((cue as any).text).toBe('Override');
    });

    it('throws when scene not in manifest and no inline cue', () => {
      expect(() => resolveCue('nonexistent')).toThrow(
        'No overlay found for scene "nonexistent"',
      );
    });

    it('uses inline cue when manifest has no entry for scene', () => {
      const cue = resolveCue('nonexistent', { type: 'lower-third', text: 'Inline' });
      expect(cue).toEqual({ type: 'lower-third', text: 'Inline' });
    });
  });

  describe('showOverlay manifest-only', () => {
    it('resolves cue from manifest with duration-only call', async () => {
      await showOverlay(page, 'hero', 2000);
      expect(page.evaluate).toHaveBeenCalledTimes(2);
      expect(page.waitForTimeout).toHaveBeenCalledWith(2000);
      // Should use center placement from manifest
      const [, args] = (page.evaluate as any).mock.calls[0];
      expect(args[0]).toContain('center');
    });

    it('resolves cue from manifest with overrides', async () => {
      await showOverlay(page, 'features', { placement: 'top-right' }, 1500);
      const [, args] = (page.evaluate as any).mock.calls[0];
      expect(args[0]).toContain('top-right');
    });

    it('throws for unknown scene with duration-only call', async () => {
      await expect(showOverlay(page, 'missing', 1000)).rejects.toThrow(
        'No overlay found for scene "missing"',
      );
    });
  });

  describe('withOverlay manifest-only', () => {
    it('resolves cue from manifest with action-only call', async () => {
      let ran = false;
      await withOverlay(page, 'hero', async () => { ran = true; });
      expect(ran).toBe(true);
      expect(page.evaluate).toHaveBeenCalledTimes(2);
      const [, args] = (page.evaluate as any).mock.calls[0];
      expect(args[0]).toContain('center');
    });

    it('resolves cue from manifest with overrides', async () => {
      let ran = false;
      await withOverlay(page, 'features', { placement: 'top-left' }, async () => { ran = true; });
      expect(ran).toBe(true);
      const [, args] = (page.evaluate as any).mock.calls[0];
      expect(args[0]).toContain('top-left');
    });

    it('throws for unknown scene with action-only call', async () => {
      await expect(
        withOverlay(page, 'missing', async () => {}),
      ).rejects.toThrow('No overlay found for scene "missing"');
    });
  });
});
