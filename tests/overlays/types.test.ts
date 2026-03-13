import { describe, it, expect } from 'vitest';
import { isValidZone, isValidTemplateType, isValidMotion } from '../../src/overlays/types.js';

describe('isValidZone', () => {
  it('accepts all defined zones', () => {
    for (const z of ['bottom-center', 'top-left', 'top-right', 'bottom-left', 'bottom-right', 'center']) {
      expect(isValidZone(z)).toBe(true);
    }
  });
  it('rejects unknown zones', () => {
    expect(isValidZone('middle')).toBe(false);
    expect(isValidZone('')).toBe(false);
  });
});

describe('isValidTemplateType', () => {
  it('accepts all defined types', () => {
    for (const t of ['lower-third', 'headline-card', 'callout', 'image-card']) {
      expect(isValidTemplateType(t)).toBe(true);
    }
  });
  it('rejects unknown types', () => {
    expect(isValidTemplateType('banner')).toBe(false);
  });
});

describe('isValidMotion', () => {
  it('accepts defined motions and none', () => {
    expect(isValidMotion('fade-in')).toBe(true);
    expect(isValidMotion('slide-in')).toBe(true);
    expect(isValidMotion('none')).toBe(true);
  });
  it('rejects unknown motions', () => {
    expect(isValidMotion('bounce')).toBe(false);
  });
});
