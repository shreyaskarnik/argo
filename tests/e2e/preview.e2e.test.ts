import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { chromium, type Browser, type Page } from 'playwright';
import { expect as pwExpect } from '@playwright/test';
import { mkdtemp, rm, writeFile, mkdir, readFile } from 'node:fs/promises';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { startPreviewServer } from '../../src/preview.js';

async function canBindLocalhost(): Promise<boolean> {
  const server = createServer();
  return await new Promise<boolean>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'EPERM' || error.code === 'EACCES') {
        resolve(false);
      } else {
        reject(error);
      }
    });
    server.listen(0, '127.0.0.1', () => {
      server.close(() => resolve(true));
    });
  });
}

async function canLaunchChromium(): Promise<boolean> {
  try {
    const browser = await chromium.launch({ headless: true });
    await browser.close();
    return true;
  } catch {
    return false;
  }
}

const describePreviewE2E = (await canBindLocalhost()) && (await canLaunchChromium()) ? describe : describe.skip;

async function scaffoldPreviewDemo(dir: string, demoName: string) {
  const argoDir = join(dir, '.argo', demoName);
  const demosDir = join(dir, 'demos');
  await mkdir(argoDir, { recursive: true });
  await mkdir(join(argoDir, 'clips'), { recursive: true });
  await mkdir(demosDir, { recursive: true });

  writeFileSync(join(argoDir, 'video.webm'), Buffer.from('fake-webm'));
  writeFileSync(join(argoDir, '.timing.json'), JSON.stringify({
    intro: 0,
    'scene-2': 2500,
  }));
  writeFileSync(join(argoDir, '.scene-durations.json'), JSON.stringify({
    intro: 1800,
    'scene-2': 2200,
  }));
  writeFileSync(join(argoDir, 'narration-aligned.wav'), Buffer.from('fake-wav'));
  writeFileSync(join(argoDir, 'scene-report.json'), JSON.stringify({
    demo: demoName,
    totalDurationMs: 9000,
    overflowMs: 0,
    scenes: [
      { scene: 'intro', startMs: 0, endMs: 1800, durationMs: 1800 },
      { scene: 'scene-2', startMs: 2500, endMs: 4700, durationMs: 2200 },
    ],
    output: 'videos/demo.mp4',
  }));
  writeFileSync(join(demosDir, `${demoName}.scenes.json`), JSON.stringify([
    { scene: 'intro', text: 'Intro scene.' },
    { scene: 'scene-2', text: 'Second scene.' },
  ], null, 2));

  return { argoDir: join(dir, '.argo'), demosDir };
}

async function stubPreviewMedia(page: Page, durationSec = 9): Promise<void> {
  await page.addInitScript((initialDurationSec: number) => {
    const state = new WeakMap<HTMLMediaElement, { currentTime: number; paused: boolean; duration: number }>();
    const ensure = (el: HTMLMediaElement) => {
      let value = state.get(el);
      if (!value) {
        value = { currentTime: 0, paused: true, duration: initialDurationSec };
        state.set(el, value);
      }
      return value;
    };

    Object.defineProperty(HTMLMediaElement.prototype, 'readyState', {
      configurable: true,
      get() { return 4; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'seeking', {
      configurable: true,
      get() { return false; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
      configurable: true,
      get() { return ensure(this as HTMLMediaElement).duration; },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'currentTime', {
      configurable: true,
      get() { return ensure(this as HTMLMediaElement).currentTime; },
      set(value: number) {
        const media = this as HTMLMediaElement;
        ensure(media).currentTime = Number.isFinite(value) ? value : 0;
        media.dispatchEvent(new Event('seeking'));
        setTimeout(() => {
          media.dispatchEvent(new Event('seeked'));
          media.dispatchEvent(new Event('timeupdate'));
        }, 0);
      },
    });
    Object.defineProperty(HTMLMediaElement.prototype, 'paused', {
      configurable: true,
      get() { return ensure(this as HTMLMediaElement).paused; },
    });

    HTMLMediaElement.prototype.pause = function pause() {
      ensure(this).paused = true;
      this.dispatchEvent(new Event('pause'));
    };
    HTMLMediaElement.prototype.play = function play() {
      ensure(this).paused = false;
      this.dispatchEvent(new Event('play'));
      return Promise.resolve();
    };

    class FakeAudioContext {
      destination = {};
      async decodeAudioData() {
        return { duration: 1 };
      }
      createBufferSource() {
        return { buffer: null, connect() {}, start() {}, stop() {} };
      }
    }

    (window as any).AudioContext = FakeAudioContext;
    document.addEventListener('DOMContentLoaded', () => {
      setTimeout(() => {
        const video = document.getElementById('video');
        if (video) {
          video.dispatchEvent(new Event('loadedmetadata'));
          video.dispatchEvent(new Event('timeupdate'));
        }
      }, 0);
    });
  }, durationSec);
}

describePreviewE2E('E2E: argo preview', () => {
  let workDir: string;
  let browser: Browser;
  let closeServer: (() => void) | undefined;

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'argo-preview-e2e-'));
    browser = await chromium.launch({ headless: true });
  });

  afterEach(async () => {
    closeServer?.();
    closeServer = undefined;
    await browser.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('seeks scenes and saves timeline edits from the browser UI', async () => {
    const { argoDir, demosDir } = await scaffoldPreviewDemo(workDir, 'preview-demo');
    const server = await startPreviewServer({
      demoName: 'preview-demo',
      argoDir,
      demosDir,
    });
    closeServer = server.close;

    const page = await browser.newPage();
    await stubPreviewMedia(page, 9);
    await page.goto(server.url);

    await page.waitForSelector('.scene-card[data-scene="scene-2"]');
    await pwExpect(page.locator('#time-total')).toHaveText('0:09');

    await page.locator('.scene-card[data-scene="scene-2"] .scene-name').click();
    await pwExpect(page.locator('#time-current')).toHaveText('0:02');

    await page.locator('[data-field="scene-scrub"][data-scene="scene-2"]').evaluate((el: HTMLInputElement) => {
      el.value = '1200';
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    });
    await pwExpect(page.locator('#time-current')).toHaveText('0:03');

    await page.locator('#add-scene-btn').click();
    await page.locator('#btn-save').click();
    await pwExpect(page.locator('#status')).toHaveText('All changes saved');

    const timing = JSON.parse(await readFile(join(argoDir, 'preview-demo', '.timing.json'), 'utf-8'));
    expect(timing['scene-3']).toBe(3700);
  });
});
