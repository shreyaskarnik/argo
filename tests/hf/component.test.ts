import { describe, it, expect } from 'vitest';
import { parseComponentSnippet, isSafeCssValue, isSafeCssVarName } from '../../src/hf/component.js';

const VIGNETTE_LIKE = `<!--
  Vignette — usage notes here.
-->
<div id="hf-vignette" style="position: absolute; inset: 0; pointer-events: none;"></div>
<style>
  #hf-vignette { background: radial-gradient(ellipse at center, transparent 45%, rgba(0,0,0,0.7) 100%); }
</style>
<!-- Timeline integration example: tl.fromTo("#hf-vignette", ...) -->`;

const SHIMMER_LIKE = `<style>
  .shimmer-sweep-target { position: relative; }
</style>
<script>
  (function () { document.querySelectorAll(".shimmer-sweep-target").forEach(() => {}); })();
</script>`;

describe('parseComponentSnippet', () => {
  it('splits a root-element component into html + css, stripping comments', () => {
    const s = parseComponentSnippet(VIGNETTE_LIKE);
    expect(s.html).toContain('hf-vignette');
    expect(s.html).not.toContain('<style');
    expect(s.html).not.toContain('Timeline integration');
    expect(s.css).toContain('radial-gradient');
    expect(s.js).toBe('');
  });

  it('extracts scripts from style+script components (no root element)', () => {
    const s = parseComponentSnippet(SHIMMER_LIKE);
    expect(s.html).toBe('');
    expect(s.css).toContain('.shimmer-sweep-target');
    expect(s.js).toContain('querySelectorAll');
  });
});

describe('param safety', () => {
  it('accepts normal CSS values', () => {
    for (const ok of ['rgba(0, 0, 0, 0.7)', '45%', '120deg', '#ff8800', 'ellipse', '2.5s']) {
      expect(isSafeCssValue(ok), ok).toBe(true);
    }
  });

  it('rejects values that could escape a declaration or load resources', () => {
    for (const bad of [
      'red; background: blue',
      '} body { display: none',
      'url(https://evil.test/x)',
      'expression(alert(1))',
      '<script>',
      'javascript:alert(1)',
      '@import "x"',
    ]) {
      expect(isSafeCssValue(bad), bad).toBe(false);
    }
  });

  it('validates custom property names', () => {
    expect(isSafeCssVarName('--vignette-size')).toBe(true);
    expect(isSafeCssVarName('--x')).toBe(true);
    expect(isSafeCssVarName('color')).toBe(false);
    expect(isSafeCssVarName('--bad;inject')).toBe(false);
  });
});
