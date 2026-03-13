import { describe, it, expect } from 'vitest';
import { renderTemplate } from '../../src/overlays/templates.js';

describe('renderTemplate', () => {
  describe('lower-third', () => {
    it('renders text in a styled span', () => {
      const result = renderTemplate({ type: 'lower-third', text: 'Hello world' });
      expect(result.contentHtml).toContain('Hello world');
      expect(result.styles.background).toBeDefined();
      expect(result.styles.borderRadius).toBeDefined();
    });
    it('includes maxWidth for readability', () => {
      const result = renderTemplate({ type: 'lower-third', text: 'Test' });
      expect(result.styles.maxWidth).toBeDefined();
    });
    it('escapes HTML in text', () => {
      const result = renderTemplate({ type: 'lower-third', text: '<script>alert("xss")</script>' });
      expect(result.contentHtml).not.toContain('<script>');
      expect(result.contentHtml).toContain('&lt;script&gt;');
    });
  });

  describe('headline-card', () => {
    it('renders title', () => {
      const result = renderTemplate({ type: 'headline-card', title: 'Big Title' });
      expect(result.contentHtml).toContain('Big Title');
    });
    it('renders kicker when provided', () => {
      const result = renderTemplate({ type: 'headline-card', title: 'Title', kicker: 'LABEL' });
      expect(result.contentHtml).toContain('LABEL');
    });
    it('renders body when provided', () => {
      const result = renderTemplate({ type: 'headline-card', title: 'Title', body: 'Details here' });
      expect(result.contentHtml).toContain('Details here');
    });
    it('omits kicker element when not provided', () => {
      const result = renderTemplate({ type: 'headline-card', title: 'Title' });
      expect(result.contentHtml).not.toContain('uppercase');
    });
    it('has backdrop blur style', () => {
      const result = renderTemplate({ type: 'headline-card', title: 'T' });
      expect(result.styles.backdropFilter).toContain('blur');
    });
  });

  describe('callout', () => {
    it('renders text in a compact bubble', () => {
      const result = renderTemplate({ type: 'callout', text: 'Note this' });
      expect(result.contentHtml).toContain('Note this');
      expect(result.styles.borderRadius).toBeDefined();
    });
  });

  describe('image-card', () => {
    it('renders img tag with src', () => {
      const result = renderTemplate({ type: 'image-card', src: 'http://localhost:9999/diagram.png' });
      expect(result.contentHtml).toContain('<img');
      expect(result.contentHtml).toContain('http://localhost:9999/diagram.png');
    });
    it('renders title when provided', () => {
      const result = renderTemplate({ type: 'image-card', src: 'http://x/img.png', title: 'Architecture' });
      expect(result.contentHtml).toContain('Architecture');
    });
    it('renders body when provided', () => {
      const result = renderTemplate({ type: 'image-card', src: 'http://x/img.png', body: 'Description' });
      expect(result.contentHtml).toContain('Description');
    });
  });
});
