/**
 * Post-export camera moves — ffmpeg zoompan filters for zoom/pan effects.
 *
 * Instead of manipulating the DOM during recording (fragile, interferes with
 * overlays), camera moves are captured as timing marks during recording and
 * applied as ffmpeg filters during export. This produces frame-exact,
 * overlay-safe zoom and pan effects using zoompan with time expressions.
 */

export interface CameraMove {
  /** Scene name this move belongs to (for debugging/reporting). */
  scene?: string;
  /** Start time on the export timeline (ms). */
  startMs: number;
  /** Duration of the camera move (ms). */
  durationMs: number;
  /** Target region center X in video pixels. */
  x: number;
  /** Target region center Y in video pixels. */
  y: number;
  /** Target region width in video pixels. */
  w: number;
  /** Target region height in video pixels. */
  h: number;
  /** Zoom scale (e.g. 1.5 = 150% magnification). Default: 1.5. */
  scale?: number;
  /** Hold the zoomed view for this many ms before zooming back out. Default: 0 (zoom in then immediately zoom out). */
  holdMs?: number;
}

/**
 * Build an ffmpeg filter expression for a single camera move.
 *
 * The approach: animate zoom and crop-center with ffmpeg's zoompan filter.
 * Unlike crop, zoompan supports per-frame zoom changes directly.
 *
 * Uses ffmpeg's `if(between(t,...),expr,default)` for time-based animation.
 * Linear interpolation for v1 — cubic easing can be added later via
 * precomputed keyframes.
 */
export function buildCameraMoveFilter(
  moves: CameraMove[],
  inputWidth: number,
  inputHeight: number,
  inputLabel: string,
  fps = 30,
): { filter: string; outputLabel: string } | null {
  if (moves.length === 0) return null;

  // Validate dimensions
  if (inputWidth <= 0 || inputHeight <= 0) return null;

  const parts: string[] = [];
  let currentLabel = inputLabel;

  for (let i = 0; i < moves.length; i++) {
    const move = moves[i];
    const scale = move.scale ?? 1.5;
    if (scale <= 1.0) continue; // No zoom needed

    const holdMs = move.holdMs ?? 0;
    const fadeInSec = move.durationMs / 1000;
    const holdSec = holdMs / 1000;
    const fadeOutSec = fadeInSec; // Symmetric zoom out

    const startSec = move.startMs / 1000;
    const zoomInEnd = startSec + fadeInSec;
    const holdEnd = zoomInEnd + holdSec;
    const zoomOutEnd = holdEnd + fadeOutSec;

    // Build the animated zoom expression.
    // progress goes 0→1 during zoom-in, stays 1 during hold, goes 1→0 during zoom-out.
    const f = (n: number) => n.toFixed(4);

    // Progress expressions for each phase
    const zoomInProgress = `(in_time-${f(startSec)})/${f(fadeInSec)}`;
    const zoomOutProgress = `1-(in_time-${f(holdEnd)})/${f(fadeOutSec)}`;

    // Combined progress: 0 before start, ramp 0→1 during zoom-in, 1 during hold, ramp 1→0 during zoom-out, 0 after
    const progress = [
      `if(between(in_time\\,${f(startSec)}\\,${f(zoomInEnd)})\\,${zoomInProgress}`,
      `\\,if(between(in_time\\,${f(zoomInEnd)}\\,${f(holdEnd)})\\,1`,
      `\\,if(between(in_time\\,${f(holdEnd)}\\,${f(zoomOutEnd)})\\,${zoomOutProgress}`,
      `\\,0)))`,
    ].join('');

    // Animated zoom factor: 1.0 -> scale -> 1.0
    const zoom = `1+${progress}*${f(scale - 1)}`;

    // Center the zoom window on the target element.
    // zoompan crops a source window of size iw/zoom x ih/zoom.
    const centerX = f(move.x);
    const centerY = f(move.y);
    const panX = `max(0\\,min(${centerX}-iw/(${zoom})/2\\,iw-iw/(${zoom})))`;
    const panY = `max(0\\,min(${centerY}-ih/(${zoom})/2\\,ih-ih/(${zoom})))`;

    const outLabel = `cam${i}`;
    parts.push(
      `${currentLabel}zoompan=z='${zoom}':x='${panX}':y='${panY}':d=1:s=${inputWidth}x${inputHeight}:fps=${Math.max(1, Math.round(fps))}[${outLabel}]`,
    );
    currentLabel = `[${outLabel}]`;
  }

  if (parts.length === 0) return null;

  const finalLabel = `camfinal`;
  // Rename the last output label — find the actual label used in the last part,
  // not moves.length-1 (which may refer to a skipped move with scale <= 1)
  const lastPart = parts[parts.length - 1];
  const lastLabelMatch = lastPart.match(/\[cam(\d+)\]$/);
  if (lastLabelMatch) {
    parts[parts.length - 1] = lastPart.replace(`[cam${lastLabelMatch[1]}]`, `[${finalLabel}]`);
  }

  return {
    filter: parts.join(';\n'),
    outputLabel: finalLabel,
  };
}

/**
 * Shift camera moves by a time offset (for head trim alignment).
 */
export function shiftCameraMoves(moves: CameraMove[], offsetMs: number): CameraMove[] {
  if (offsetMs <= 0) return moves;
  return moves.map((m) => ({
    ...m,
    startMs: Math.max(0, m.startMs - offsetMs),
  }));
}

/**
 * Scale camera move coordinates by deviceScaleFactor.
 * During recording, bounding boxes are in CSS pixels but the video is
 * captured at scaled resolution. Coordinates need to match the video frame.
 */
export function scaleCameraMoves(moves: CameraMove[], deviceScaleFactor: number): CameraMove[] {
  if (deviceScaleFactor <= 1) return moves;
  return moves.map((m) => ({
    ...m,
    x: Math.round(m.x * deviceScaleFactor),
    y: Math.round(m.y * deviceScaleFactor),
    w: Math.round(m.w * deviceScaleFactor),
    h: Math.round(m.h * deviceScaleFactor),
  }));
}
