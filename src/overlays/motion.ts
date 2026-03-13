import type { MotionPreset } from './types.js';

export function getMotionCSS(motion: MotionPreset, elementId: string): string {
  const animName = `argo-${motion}-${elementId}`;
  switch (motion) {
    case 'fade-in':
      return `@keyframes ${animName} { from { opacity: 0; } to { opacity: 1; } }`;
    case 'slide-in':
      return `@keyframes ${animName} { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }`;
    case 'none':
    default:
      return '';
  }
}

export function getMotionStyles(motion: MotionPreset, elementId: string): Record<string, string> {
  const animName = `argo-${motion}-${elementId}`;
  switch (motion) {
    case 'fade-in':
      return { animation: `${animName} 300ms ease-out forwards` };
    case 'slide-in':
      return { animation: `${animName} 400ms ease-out forwards` };
    case 'none':
    default:
      return {};
  }
}
