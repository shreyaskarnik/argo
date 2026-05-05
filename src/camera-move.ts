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

function formatSeconds(value: number): string {
  return value.toFixed(4);
}

/** Max gap (ms) between two moves to chain them with a smooth pan instead of bouncing to 1×. */
const CHAIN_GAP_MS = 1500;
/** Duration (ms) of the smooth pan transition between chained moves. */
const CHAIN_PAN_MS = 1000;

/**
 * Cubic bezier approximation for easing: cubicBezier(0.1, 0.0, 0.2, 1.0, t).
 * This is an aggressive ease-out (fast deceleration) used for connected pans.
 * Approximated as a polynomial: roughly t^0.5 with slight adjustment.
 * In ffmpeg expressions: 1-pow(1-t,3) gives a good ease-out approximation.
 */
function easeOutExpr(tExpr: string): string {
  return `(1-pow(1-(${tExpr})\\,3))`;
}

/**
 * Compute the end time (in ms) of a camera move including zoom-out.
 */
function moveEndMs(move: CameraMove): number {
  const fadeMs = move.durationMs;
  const holdMs = move.holdMs ?? 0;
  return move.startMs + fadeMs + holdMs + fadeMs; // in + hold + out
}

/**
 * Detect which adjacent move pairs should be chained (smooth pan instead of bounce).
 * Returns a Set of indices where move[i] should chain into move[i+1].
 */
export function detectChainedPairs(moves: CameraMove[]): Set<number> {
  const chained = new Set<number>();
  for (let i = 0; i < moves.length - 1; i++) {
    const scaleA = moves[i].scale ?? 1.5;
    const scaleB = moves[i + 1].scale ?? 1.5;
    if (scaleA <= 1.0 || scaleB <= 1.0) continue;
    const gap = moves[i + 1].startMs - moveEndMs(moves[i]);
    if (gap >= 0 && gap <= CHAIN_GAP_MS) {
      chained.add(i);
    }
  }
  return chained;
}

/**
 * Build an ffmpeg filter expression for camera moves with connected handoffs.
 *
 * Adjacent moves within CHAIN_GAP_MS get smooth pans between them instead of
 * bouncing back to 1× zoom. The pan interpolates focus + scale with an ease-out
 * curve, creating cinematic connected camera motion.
 *
 * Uses ffmpeg's `if(between(t,...),expr,default)` for time-based animation.
 */
export function buildCameraMoveFilter(
  moves: CameraMove[],
  inputWidth: number,
  inputHeight: number,
  inputLabel: string,
  fps = 30,
): { filter: string; outputLabel: string } | null {
  if (moves.length === 0) return null;
  if (inputWidth <= 0 || inputHeight <= 0) return null;

  // Filter to valid moves and sort by start time
  const validMoves = moves
    .map((m, i) => ({ move: m, origIdx: i }))
    .filter(({ move }) => (move.scale ?? 1.5) > 1.0);
  if (validMoves.length === 0) return null;

  const sortedMoves = validMoves.map(v => v.move);
  const chained = detectChainedPairs(sortedMoves);
  const f = (n: number) => n.toFixed(4);

  // Build unified zoom, panX, panY expressions as nested if/else chains.
  // Each move contributes its time windows; chained pairs add a pan transition.
  const zoomClauses: string[] = [];
  const panXClauses: string[] = [];
  const panYClauses: string[] = [];

  for (let i = 0; i < sortedMoves.length; i++) {
    const move = sortedMoves[i];
    const scale = move.scale ?? 1.5;
    const holdMs = move.holdMs ?? 0;
    const fadeInSec = move.durationMs / 1000;
    const holdSec = holdMs / 1000;
    const fadeOutSec = fadeInSec;

    const startSec = move.startMs / 1000;
    const zoomInEnd = startSec + fadeInSec;
    const holdEnd = zoomInEnd + holdSec;
    const zoomOutEnd = holdEnd + fadeOutSec;

    const isChainedOut = chained.has(i);       // this move chains into the next
    const isChainedIn = i > 0 && chained.has(i - 1); // previous move chains into this

    // --- Zoom-in phase (skip if chained-in — the pan transition handles it) ---
    if (!isChainedIn) {
      const progress = `(in_time-${f(startSec)})/${f(fadeInSec)}`;
      zoomClauses.push(`if(between(in_time\\,${f(startSec)}\\,${f(zoomInEnd)})\\,1+${progress}*${f(scale - 1)}`);
      panXClauses.push(`if(between(in_time\\,${f(startSec)}\\,${f(zoomInEnd)})\\,${f(move.x)}`);
      panYClauses.push(`if(between(in_time\\,${f(startSec)}\\,${f(zoomInEnd)})\\,${f(move.y)}`);
    }

    // --- Hold phase ---
    if (holdSec > 0) {
      zoomClauses.push(`if(between(in_time\\,${f(zoomInEnd)}\\,${f(holdEnd)})\\,${f(scale)}`);
      panXClauses.push(`if(between(in_time\\,${f(zoomInEnd)}\\,${f(holdEnd)})\\,${f(move.x)}`);
      panYClauses.push(`if(between(in_time\\,${f(zoomInEnd)}\\,${f(holdEnd)})\\,${f(move.y)}`);
    }

    // --- Zoom-out or connected pan transition ---
    if (isChainedOut) {
      const next = sortedMoves[i + 1];
      const nextScale = next.scale ?? 1.5;
      // Pan transition: from current hold end to next zoom-in end
      const rawPanDur = (next.startMs - move.startMs - move.durationMs - holdMs) / 1000 + next.durationMs / 1000;
      const panDur = Math.max(0.1, Math.min(CHAIN_PAN_MS / 1000, rawPanDur));
      const panStart = holdEnd;
      const panEnd = panStart + panDur;

      // During pan: interpolate scale and focus between current and next
      const tExpr = `(in_time-${f(panStart)})/${f(panDur)}`;
      const easedT = easeOutExpr(tExpr);

      // Lerp scale: current scale → next scale
      const lerpScale = `${f(scale)}+(${f(nextScale)}-${f(scale)})*${easedT}`;
      // Lerp focus
      const lerpX = `${f(move.x)}+(${f(next.x)}-${f(move.x)})*${easedT}`;
      const lerpY = `${f(move.y)}+(${f(next.y)}-${f(move.y)})*${easedT}`;

      zoomClauses.push(`if(between(in_time\\,${f(panStart)}\\,${f(panEnd)})\\,${lerpScale}`);
      panXClauses.push(`if(between(in_time\\,${f(panStart)}\\,${f(panEnd)})\\,${lerpX}`);
      panYClauses.push(`if(between(in_time\\,${f(panStart)}\\,${f(panEnd)})\\,${lerpY}`);

      // If there's a gap between pan end and next move's zoom-in, hold at next position
      const nextStart = next.startMs / 1000;
      const nextFadeIn = next.durationMs / 1000;
      const nextZoomInEnd = nextStart + nextFadeIn;
      if (panEnd < nextZoomInEnd) {
        zoomClauses.push(`if(between(in_time\\,${f(panEnd)}\\,${f(nextZoomInEnd)})\\,${f(nextScale)}`);
        panXClauses.push(`if(between(in_time\\,${f(panEnd)}\\,${f(nextZoomInEnd)})\\,${f(next.x)}`);
        panYClauses.push(`if(between(in_time\\,${f(panEnd)}\\,${f(nextZoomInEnd)})\\,${f(next.y)}`);
      }
    } else {
      // Normal zoom-out
      const progress = `1-(in_time-${f(holdEnd)})/${f(fadeOutSec)}`;
      zoomClauses.push(`if(between(in_time\\,${f(holdEnd)}\\,${f(zoomOutEnd)})\\,1+${progress}*${f(scale - 1)}`);
      panXClauses.push(`if(between(in_time\\,${f(holdEnd)}\\,${f(zoomOutEnd)})\\,${f(move.x)}`);
      panYClauses.push(`if(between(in_time\\,${f(holdEnd)}\\,${f(zoomOutEnd)})\\,${f(move.y)}`);
    }
  }

  // Close all clauses with default (no zoom = 1.0, center pan)
  const defaultZoom = '1';
  const defaultX = f(inputWidth / 2);
  const defaultY = f(inputHeight / 2);
  const closingParens = ')'.repeat(zoomClauses.length);

  const zoomExpr = zoomClauses.join('\\,') + `\\,${defaultZoom}${closingParens}`;
  const focusX = panXClauses.join('\\,') + `\\,${defaultX}${closingParens}`;
  const focusY = panYClauses.join('\\,') + `\\,${defaultY}${closingParens}`;

  // Build pan expressions from focus point + zoom
  const panX = `max(0\\,min(${focusX}-iw/(${zoomExpr})/2\\,iw-iw/(${zoomExpr})))`;
  const panY = `max(0\\,min(${focusY}-ih/(${zoomExpr})/2\\,ih-ih/(${zoomExpr})))`;

  const finalLabel = 'camfinal';
  const filter = `${inputLabel}zoompan=z='${zoomExpr}':x='${panX}':y='${panY}':d=1:s=${inputWidth}x${inputHeight}:fps=${Math.max(1, Math.round(fps))}[${finalLabel}]`;

  return {
    filter,
    outputLabel: finalLabel,
  };
}

/**
 * Build an ffmpeg filter expression for motion blur applied after camera moves.
 *
 * Uses tblend to blend consecutive frames, creating a motion blur effect
 * during zoom/pan transitions. The intensity controls the blend opacity.
 *
 * @param inputLabel - Stream label of the camera move output (e.g., '[camfinal]')
 * @param intensity - Blur intensity from 0.0 to 1.0. Default: 0.5.
 * @returns Filter string and output label, or null if intensity is 0.
 */
export function buildMotionBlurFilter(
  inputLabel: string,
  intensity: number = 0.5,
  moves: CameraMove[] = [],
  fps = 30,
): { filter: string; outputLabel: string } | null {
  const clamped = Math.max(0, Math.min(1, intensity));
  if (clamped <= 0) return null;

  // tblend averages current and previous frame with configurable opacity.
  // all_opacity controls how much of the blended result to use (0 = no blur, 1 = full blend).
  const outputLabel = 'mblur';
  const validFps = Number.isFinite(fps) && fps > 0 ? fps : 30;
  const framePadSec = 1 / validFps;
  const windows: string[] = [];

  for (const move of moves) {
    const scale = move.scale ?? 1.5;
    if (scale <= 1.0 || move.durationMs <= 0) continue;

    const startSec = move.startMs / 1000;
    const zoomInEnd = startSec + move.durationMs / 1000;
    const holdEnd = zoomInEnd + Math.max(0, move.holdMs ?? 0) / 1000;
    const zoomOutEnd = holdEnd + move.durationMs / 1000;

    const zoomInStart = Math.max(0, startSec - framePadSec);
    const zoomInStop = zoomInEnd + framePadSec;
    windows.push(`between(t,${formatSeconds(zoomInStart)},${formatSeconds(zoomInStop)})`);

    const zoomOutStart = Math.max(0, holdEnd - framePadSec);
    const zoomOutStop = zoomOutEnd + framePadSec;
    windows.push(`between(t,${formatSeconds(zoomOutStart)},${formatSeconds(zoomOutStop)})`);
  }

  if (moves.length > 0 && windows.length === 0) return null;

  const enableExpr = windows.length > 0 ? `:enable='${windows.join('+')}'` : '';
  const filter =
    `${inputLabel}tblend=all_mode=average:all_opacity=${clamped.toFixed(2)}${enableExpr}[${outputLabel}]`;

  return { filter, outputLabel };
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
 * Scale camera move coordinates from CSS layout pixels to output-frame pixels.
 * During recording, bounding boxes are measured in CSS pixels; export may
 * downscale, preserve, or upscale relative to that layout.
 */
export function scaleCameraMoves(moves: CameraMove[], scaleX: number, scaleY: number = scaleX): CameraMove[] {
  if (scaleX === 1 && scaleY === 1) return moves;
  return moves.map((m) => ({
    ...m,
    x: Math.round(m.x * scaleX),
    y: Math.round(m.y * scaleY),
    w: Math.round(m.w * scaleX),
    h: Math.round(m.h * scaleY),
  }));
}
