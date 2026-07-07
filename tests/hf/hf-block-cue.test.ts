import { describe, it, expect } from 'vitest';
import type { OverlayCue } from '../../src/overlays/types.js';
import { showOverlay } from '../../src/overlays/index.js';
import { renderTemplate } from '../../src/overlays/templates.js';

describe('HfBlockCue', () => {
  it('is part of the OverlayCue union at compile time', () => {
    const cue: OverlayCue = {
      type: 'hf-block', name: 'logo-outro', fit: 'cover', holdLastFrame: true, durationMs: 2500,
    };
    expect(cue.type).toBe('hf-block');
  });

  it('renderTemplate rejects hf-block cues with a pointer to export-time compositing', () => {
    expect(() => renderTemplate({ type: 'hf-block', name: 'logo-outro' })).toThrow(/export/i);
  });

  it('showOverlay is a pacing no-op during recording (waits, no page mutation)', async () => {
    const calls: string[] = [];
    const fakePage = {
      evaluate: async () => { calls.push('evaluate'); },
      waitForTimeout: async (ms: number) => { calls.push(`wait:${ms}`); },
    };
    await showOverlay(fakePage as never, 'outro', { type: 'hf-block', name: 'logo-outro' }, 900);
    expect(calls).toEqual(['wait:900']);
  });
});
