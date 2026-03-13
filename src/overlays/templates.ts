import type { OverlayCue } from './types.js';

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

function lowerThird(text: string): TemplateResult {
  return {
    contentHtml: `<span>${escapeHtml(text)}</span>`,
    styles: {
      background: 'rgba(0, 0, 0, 0.85)',
      color: '#fff',
      padding: '16px 32px',
      borderRadius: '12px',
      fontSize: '28px',
      fontWeight: '500',
      textAlign: 'center',
      maxWidth: '80vw',
      letterSpacing: '0.01em',
      lineHeight: '1.4',
      boxShadow: '0 4px 24px rgba(0, 0, 0, 0.3)',
    },
  };
}

function headlineCard(title: string, kicker?: string, body?: string): TemplateResult {
  const parts: string[] = [];
  if (kicker) {
    parts.push(
      `<div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:rgba(255,255,255,0.7);margin-bottom:8px">${escapeHtml(kicker)}</div>`,
    );
  }
  parts.push(
    `<div style="font-size:26px;font-weight:700;line-height:1.25;color:#fff">${escapeHtml(title)}</div>`,
  );
  if (body) {
    parts.push(
      `<div style="font-size:16px;line-height:1.5;color:rgba(255,255,255,0.85);margin-top:8px">${escapeHtml(body)}</div>`,
    );
  }
  return {
    contentHtml: parts.join(''),
    styles: {
      background: 'rgba(0, 0, 0, 0.7)',
      backdropFilter: 'blur(16px)',
      WebkitBackdropFilter: 'blur(16px)',
      padding: '24px 28px',
      borderRadius: '16px',
      maxWidth: '420px',
      boxShadow: '0 8px 32px rgba(0, 0, 0, 0.4)',
    },
  };
}

function callout(text: string): TemplateResult {
  return {
    contentHtml: `<span>${escapeHtml(text)}</span>`,
    styles: {
      background: 'rgba(0, 0, 0, 0.8)',
      color: '#fff',
      padding: '10px 18px',
      borderRadius: '20px',
      fontSize: '16px',
      fontWeight: '500',
      lineHeight: '1.3',
      maxWidth: '300px',
      boxShadow: '0 2px 12px rgba(0, 0, 0, 0.3)',
    },
  };
}

function imageCard(src: string, title?: string, body?: string): TemplateResult {
  const parts: string[] = [];
  parts.push(
    `<img src="${escapeHtml(src)}" style="max-width:100%;border-radius:8px;display:block" />`,
  );
  if (title) {
    parts.push(
      `<div style="font-size:18px;font-weight:600;color:#fff;margin-top:12px">${escapeHtml(title)}</div>`,
    );
  }
  if (body) {
    parts.push(
      `<div style="font-size:14px;color:rgba(255,255,255,0.8);margin-top:4px;line-height:1.4">${escapeHtml(body)}</div>`,
    );
  }
  return {
    contentHtml: parts.join(''),
    styles: {
      background: 'rgba(0, 0, 0, 0.75)',
      backdropFilter: 'blur(12px)',
      WebkitBackdropFilter: 'blur(12px)',
      padding: '16px',
      borderRadius: '14px',
      maxWidth: '360px',
      boxShadow: '0 6px 24px rgba(0, 0, 0, 0.4)',
    },
  };
}

export function renderTemplate(cue: OverlayCue): TemplateResult {
  switch (cue.type) {
    case 'lower-third':
      return lowerThird(cue.text);
    case 'headline-card':
      return headlineCard(cue.title, cue.kicker, cue.body);
    case 'callout':
      return callout(cue.text);
    case 'image-card':
      return imageCard(cue.src, cue.title, cue.body);
  }
}
