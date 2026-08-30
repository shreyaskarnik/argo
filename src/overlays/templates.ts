import type { OverlayCue } from './types.js';
import type { BackgroundTheme } from './zones.js';
import { getBlock, isValidBlockName } from '../blocks/index.js';
import { escapeHtml } from '../html-escape.js';

export interface TemplateResult {
  contentHtml: string;
  styles: Record<string, string>;
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

function arrow(
  theme: BackgroundTheme,
  direction: string = 'down',
  label?: string,
  color: string = '#ef4444',
  size: number = 48,
): TemplateResult {
  const isDark = theme === 'dark';

  // SVG arrow paths for each direction
  const arrowPaths: Record<string, string> = {
    'up': 'M24 44 L24 8 M24 8 L12 20 M24 8 L36 20',
    'down': 'M24 4 L24 40 M24 40 L12 28 M24 40 L36 28',
    'left': 'M44 24 L8 24 M8 24 L20 12 M8 24 L20 36',
    'right': 'M4 24 L40 24 M40 24 L28 12 M40 24 L28 36',
    'up-left': 'M38 38 L10 10 M10 10 L10 24 M10 10 L24 10',
    'up-right': 'M10 38 L38 10 M38 10 L24 10 M38 10 L38 24',
    'down-left': 'M38 10 L10 38 M10 38 L24 38 M10 38 L10 24',
    'down-right': 'M10 10 L38 38 M38 38 L24 38 M38 38 L38 24',
  };

  const path = arrowPaths[direction] ?? arrowPaths['down'];
  const strokeWidth = Math.max(3, Math.round(size / 12));

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 48 48" width="${size}" height="${size}" style="display:block;filter:drop-shadow(0 2px 4px rgba(0,0,0,0.3))"><path d="${path}" stroke="${escapeHtml(color)}" stroke-width="${strokeWidth}" stroke-linecap="round" stroke-linejoin="round" fill="none"/></svg>`;

  const parts: string[] = [svg];
  if (label) {
    parts.push(
      `<div style="font-size:${Math.max(12, Math.round(size * 0.35))}px;font-weight:600;color:${isDark ? '#1a1a1a' : '#fff'};margin-top:6px;text-align:center;text-shadow:${isDark ? '0 1px 3px rgba(0,0,0,0.2)' : '0 1px 4px rgba(0,0,0,0.6)'}">${escapeHtml(label)}</div>`,
    );
  }

  return {
    contentHtml: parts.join(''),
    styles: {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      padding: '8px',
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
    case 'arrow':
      return arrow(theme, cue.direction, cue.label, cue.color, cue.size);
    case 'block': {
      if (!isValidBlockName(cue.block)) {
        throw new Error(
          `Overlay references unknown block "${cue.block}". ` +
          `Check the block name against src/blocks/ or run \`argo validate <demo>\`.`,
        );
      }
      const block = getBlock(cue.block);
      // Merge defaults under user-provided props so missing fields fill in.
      const merged = { ...block.defaultProps, ...cue.props };
      return block.render(merged as never, theme);
    }
    case 'hf-component':
      throw new Error(
        'hf-component cues are injected full-frame by showOverlay/applyComponent, not rendered as zone templates.',
      );
    case 'hf-block':
      throw new Error(
        'hf-block cues are composited at export time (pre-rendered PNG sequences), not rendered as zone templates.',
      );
  }
}
