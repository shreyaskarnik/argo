import type { OverlayCue } from './types.js';
import type { BackgroundTheme } from './zones.js';

export interface TemplateResult {
  contentHtml: string;
  styles: Record<string, string>;
}

function escapeHtml(str: string): string {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function lowerThird(text: string, theme: BackgroundTheme): TemplateResult {
  const isDark = theme === 'dark';
  return {
    contentHtml: `<span>${escapeHtml(text)}</span>`,
    styles: {
      background: isDark ? 'rgba(0, 0, 0, 0.85)' : 'rgba(255, 255, 255, 0.9)',
      color: isDark ? '#fff' : '#1a1a1a',
      padding: '16px 32px',
      borderRadius: '12px',
      fontSize: '28px',
      fontWeight: '500',
      textAlign: 'center',
      maxWidth: '80vw',
      letterSpacing: '0.01em',
      lineHeight: '1.4',
      boxShadow: isDark ? '0 4px 24px rgba(0, 0, 0, 0.3)' : '0 4px 24px rgba(0, 0, 0, 0.12)',
    },
  };
}

function headlineCard(title: string, theme: BackgroundTheme, kicker?: string, body?: string): TemplateResult {
  const isDark = theme === 'dark';
  const parts: string[] = [];
  if (kicker) {
    parts.push(
      `<div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:${isDark ? 'rgba(255,255,255,0.7)' : 'rgba(0,0,0,0.5)'};margin-bottom:8px">${escapeHtml(kicker)}</div>`,
    );
  }
  parts.push(
    `<div style="font-size:26px;font-weight:700;line-height:1.25;color:${isDark ? '#fff' : '#1a1a1a'}">${escapeHtml(title)}</div>`,
  );
  if (body) {
    parts.push(
      `<div style="font-size:16px;line-height:1.5;color:${isDark ? 'rgba(255,255,255,0.85)' : 'rgba(0,0,0,0.7)'};margin-top:8px">${escapeHtml(body)}</div>`,
    );
  }
  return {
    contentHtml: parts.join(''),
    styles: {
      background: isDark ? 'rgba(0, 0, 0, 0.7)' : 'rgba(255, 255, 255, 0.85)',
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      padding: '24px 28px',
      borderRadius: '16px',
      maxWidth: '420px',
      boxShadow: isDark ? '0 8px 32px rgba(0, 0, 0, 0.4)' : '0 8px 32px rgba(0, 0, 0, 0.1)',
    },
  };
}

function callout(text: string, theme: BackgroundTheme): TemplateResult {
  const isDark = theme === 'dark';
  return {
    contentHtml: `<span>${escapeHtml(text)}</span>`,
    styles: {
      background: isDark ? 'rgba(0, 0, 0, 0.8)' : 'rgba(255, 255, 255, 0.9)',
      color: isDark ? '#fff' : '#1a1a1a',
      padding: '10px 18px',
      borderRadius: '20px',
      fontSize: '16px',
      fontWeight: '500',
      lineHeight: '1.3',
      maxWidth: '300px',
      boxShadow: isDark ? '0 2px 12px rgba(0, 0, 0, 0.3)' : '0 2px 12px rgba(0, 0, 0, 0.1)',
    },
  };
}

function imageCard(src: string, theme: BackgroundTheme, title?: string, body?: string): TemplateResult {
  const isDark = theme === 'dark';
  const parts: string[] = [];
  parts.push(
    `<img src="${escapeHtml(src)}" style="max-width:100%;border-radius:8px;display:block" />`,
  );
  if (title) {
    parts.push(
      `<div style="font-size:18px;font-weight:600;color:${isDark ? '#fff' : '#1a1a1a'};margin-top:12px">${escapeHtml(title)}</div>`,
    );
  }
  if (body) {
    parts.push(
      `<div style="font-size:14px;color:${isDark ? 'rgba(255,255,255,0.8)' : 'rgba(0,0,0,0.7)'};margin-top:4px;line-height:1.4">${escapeHtml(body)}</div>`,
    );
  }
  return {
    contentHtml: parts.join(''),
    styles: {
      background: isDark ? 'rgba(0, 0, 0, 0.75)' : 'rgba(255, 255, 255, 0.85)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      padding: '16px',
      borderRadius: '14px',
      maxWidth: '360px',
      boxShadow: isDark ? '0 6px 24px rgba(0, 0, 0, 0.4)' : '0 6px 24px rgba(0, 0, 0, 0.1)',
    },
  };
}

export function renderTemplate(cue: OverlayCue, theme: BackgroundTheme = 'dark'): TemplateResult {
  switch (cue.type) {
    case 'lower-third':
      return lowerThird(cue.text, theme);
    case 'headline-card':
      return headlineCard(cue.title, theme, cue.kicker, cue.body);
    case 'callout':
      return callout(cue.text, theme);
    case 'image-card':
      return imageCard(cue.src, theme, cue.title, cue.body);
  }
}
