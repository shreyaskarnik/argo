/**
 * Post-export camera moves — ffmpeg crop+scale filters for zoom/pan effects.
 *
 * Instead of manipulating the DOM during recording (fragile, interferes with
 * overlays), camera moves are captured as timing marks during recording and
 * applied as ffmpeg filters during export. This produces frame-exact,
 * overlay-safe zoom and pan effects using crop+scale with time expressions.
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
 * The approach: animate the crop window from full-frame down to the target
 * region (zoom in), optionally hold, then animate back out. The cropped
 * frame is scaled back to the original resolution with lanczos.
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

    // Target crop dimensions at max zoom
    const cropW = Math.round(inputWidth / scale);
    const cropH = Math.round(inputHeight / scale);

    // Target crop position (centered on target, clamped to frame)
    const targetX = Math.max(0, Math.min(move.x - cropW / 2, inputWidth - cropW));
    const targetY = Math.max(0, Math.min(move.y - cropH / 2, inputHeight - cropH));

    // Build the animated crop expression.
    // progress goes 0→1 during zoom-in, stays 1 during hold, goes 1→0 during zoom-out.
    // crop_w = iw - progress * (iw - cropW)  (interpolates from full width to crop width)
    const f = (n: number) => n.toFixed(4);

    // Progress expressions for each phase
    const zoomInProgress = `(t-${f(startSec)})/${f(fadeInSec)}`;
    const zoomOutProgress = `1-(t-${f(holdEnd)})/${f(fadeOutSec)}`;

    // Combined progress: 0 before start, ramp 0→1 during zoom-in, 1 during hold, ramp 1→0 during zoom-out, 0 after
    const progress = [
      `if(between(t\\,${f(startSec)}\\,${f(zoomInEnd)})\\,${zoomInProgress}`,
      `\\,if(between(t\\,${f(zoomInEnd)}\\,${f(holdEnd)})\\,1`,
      `\\,if(between(t\\,${f(holdEnd)}\\,${f(zoomOutEnd)})\\,${zoomOutProgress}`,
      `\\,0)))`,
    ].join('');

    // Animated crop dimensions
    const animW = `iw-${progress}*(iw-${cropW})`;
    const animH = `ih-${progress}*(ih-${cropH})`;

    // Animated crop position (interpolates from 0 to targetX/Y)
    const animX = `${progress}*${f(targetX)}`;
    const animY = `${progress}*${f(targetY)}`;

    const outLabel = `cam${i}`;
    parts.push(
      `${currentLabel}crop=w='${animW}':h='${animH}':x='${animX}':y='${animY}':exact=1,scale=${inputWidth}:${inputHeight}:flags=lanczos[${outLabel}]`,
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
