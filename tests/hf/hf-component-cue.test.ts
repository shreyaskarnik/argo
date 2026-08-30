import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import type { OverlayCue } from '../../src/overlays/types.js';
import { showOverlay } from '../../src/overlays/index.js';
import { renderTemplate } from '../../src/overlays/templates.js';

describe('HfComponentCue', () => {
  it('is part of the OverlayCue union at compile time', () => {
    const cue: OverlayCue = { type: 'hf-component', name: 'vignette', params: { '--x': '1' } };
    expect(cue.type).toBe('hf-component');
  });

  it('renderTemplate rejects hf-component cues with a pointer to the right path', () => {
    expect(() => renderTemplate({ type: 'hf-component', name: 'vignette' })).toThrow(
      /full-frame/i,
    );
  });
});

describe('showOverlay dispatch for hf-component', () => {
  let tmp: string;
  let prevEnv: string | undefined;
  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'argo-cue-'));
    mkdirSync(join(tmp, 'vignette'), { recursive: true });
    writeFileSync(join(tmp, 'vignette', 'vignette.html'), '<div id="hf-vignette"></div>');
    prevEnv = process.env.ARGO_BLOCKS_DIR;
    process.env.ARGO_BLOCKS_DIR = tmp;
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
    if (prevEnv === undefined) delete process.env.ARGO_BLOCKS_DIR;
    else process.env.ARGO_BLOCKS_DIR = prevEnv;
  });

  it('applies, waits durationMs, and removes — never touching zone machinery', async () => {
    const calls: string[] = [];
    const fakePage = {
      evaluate: async () => { calls.push('evaluate'); },
      waitForTimeout: async (ms: number) => { calls.push(`wait:${ms}`); },
    };
    await showOverlay(
      fakePage as never,
      'intro',
      { type: 'hf-component', name: 'vignette' },
      1200,
    );
    // applyComponent issues 2 evaluates (fence + inject), removeComponent 1.
    expect(calls).toEqual(['evaluate', 'evaluate', 'wait:1200', 'evaluate']);
  });
});
