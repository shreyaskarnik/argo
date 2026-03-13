import { describe, it, expect } from 'vitest';
import { getMotionCSS, getMotionStyles } from '../../src/overlays/motion.js';

describe('getMotionCSS', () => {
  it('returns empty string for none', () => {
    expect(getMotionCSS('none', 'argo-overlay-top-left')).toBe('');
  });
  it('returns fade-in keyframes', () => {
    const css = getMotionCSS('fade-in', 'argo-overlay-top-left');
    expect(css).toContain('@keyframes');
    expect(css).toContain('opacity');
    expect(css).toContain('argo-overlay-top-left');
  });
  it('returns slide-in keyframes', () => {
    const css = getMotionCSS('slide-in', 'argo-overlay-top-left');
    expect(css).toContain('@keyframes');
    expect(css).toContain('translateX');
    expect(css).toContain('argo-overlay-top-left');
  });
});

describe('getMotionStyles', () => {
  it('returns empty object for none', () => {
    expect(getMotionStyles('none', 'test-id')).toEqual({});
  });
  it('returns animation property for fade-in', () => {
    const styles = getMotionStyles('fade-in', 'test-id');
    expect(styles.animation).toContain('300ms');
  });
  it('returns animation property for slide-in', () => {
    const styles = getMotionStyles('slide-in', 'test-id');
    expect(styles.animation).toContain('400ms');
  });
});
