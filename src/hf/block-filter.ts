import { join } from 'node:path';

/**
 * Build ffmpeg inputs + filter_complex parts that composite pre-rendered
 * hyperframes block PNG sequences onto the video. Mirrors
 * buildOverlayPngFilters (src/overlays/render-to-png.ts) but for image2
 * sequences: the sequence starts at t=0, so setpts shifts it to the cue's
 * window before the enable-gated overlay. eof_action=pass keeps cutaway
 * semantics — output duration never changes.
 */

export interface RenderedHfBlock {
  name: string;
  pngDir: string;
  frameCount: number;
  fps: number;
  startMs: number;
  endMs: number;
  /** Native block canvas size (the PNG dimensions). */
  width: number;
  height: number;
  fit: 'cover' | { x: number; y: number; scale: number };
}

export function buildHfBlockFilters(
  blocks: RenderedHfBlock[],
  baseInputCount: number,
  videoSourceLabel: string,
  videoW: number,
  videoH: number,
): { inputArgs: string[]; filterParts: string[]; videoSource: string; nextInput: number } {
  if (blocks.length === 0) {
    return { inputArgs: [], filterParts: [], videoSource: videoSourceLabel, nextInput: baseInputCount };
  }

  const inputArgs: string[] = [];
  const filterParts: string[] = [];
  let currentVideo = videoSourceLabel;
  let nextInput = baseInputCount;

  for (let i = 0; i < blocks.length; i++) {
    const b = blocks[i];
    const inputIdx = nextInput++;
    inputArgs.push('-framerate', String(b.fps), '-start_number', '0', '-i', join(b.pngDir, 'frame_%04d.png'));

    const startSec = (b.startMs / 1000).toFixed(3);
    const endSec = (b.endMs / 1000).toFixed(3);

    let scaleExpr: string;
    let x: number;
    let y: number;
    if (b.fit === 'cover') {
      // Fill the frame keeping the block's aspect ratio, then centre-crop the
      // overflow. A bare scale=W:H stretches: a 16:9 block in a 9:16 variant
      // would be squashed to a third of its width. When the aspects already
      // match, the crop is a no-op.
      scaleExpr = `scale=${videoW}:${videoH}:force_original_aspect_ratio=increase,crop=${videoW}:${videoH}`;
      x = 0;
      y = 0;
    } else {
      scaleExpr = `scale=${Math.round(b.width * b.fit.scale)}:${Math.round(b.height * b.fit.scale)}`;
      x = b.fit.x;
      y = b.fit.y;
    }

    const prepLabel = `hfblk${i}`;
    const outLabel = `hfb${i}`;
    filterParts.push(`[${inputIdx}:v]format=rgba,${scaleExpr},setpts=PTS+${startSec}/TB[${prepLabel}]`);
    filterParts.push(
      `[${currentVideo}][${prepLabel}]overlay=${x}:${y}:enable='between(t\\,${startSec}\\,${endSec})':format=auto:eof_action=pass[${outLabel}]`,
    );
    currentVideo = outLabel;
  }

  return { inputArgs, filterParts, videoSource: currentVideo, nextInput };
}
