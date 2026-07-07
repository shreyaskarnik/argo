import { describe, it, expect } from 'vitest';
import { defineConfig } from '../../src/config.js';

describe('blocksDir / registry config', () => {
  it('defaults blocksDir to "blocks"', () => {
    expect(defineConfig({}).blocksDir).toBe('blocks');
  });

  it('honors a custom blocksDir', () => {
    expect(defineConfig({ blocksDir: 'assets/hf' }).blocksDir).toBe('assets/hf');
  });

  it('passes registry.url through and defaults registry to undefined', () => {
    expect(defineConfig({}).registry).toBeUndefined();
    expect(defineConfig({ registry: { url: 'https://x.test/reg' } }).registry?.url).toBe(
      'https://x.test/reg',
    );
  });
});
