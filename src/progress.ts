import { spawn, type ChildProcess } from 'node:child_process';

/**
 * Run ffmpeg with progress reporting.
 *
 * Uses `-progress pipe:1` to parse progress output and display a
 * terminal progress bar showing encode percentage.
 */
export async function runFfmpegWithProgress(
  args: string[],
  totalDurationMs?: number,
): Promise<void> {
  // Insert -progress pipe:1 before the output file (last arg)
  const fullArgs = [...args];
  const outputIdx = fullArgs.lastIndexOf('-y');
  if (outputIdx >= 0) {
    fullArgs.splice(outputIdx, 0, '-progress', 'pipe:1', '-nostats');
  } else {
    fullArgs.push('-progress', 'pipe:1', '-nostats');
  }

  return new Promise<void>((resolve, reject) => {
    const proc = spawn('ffmpeg', fullArgs, {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let progressBuf = '';

    proc.stdout?.on('data', (chunk: Buffer) => {
      progressBuf += chunk.toString();
      const lines = progressBuf.split('\n');
      progressBuf = lines.pop() ?? '';

      for (const line of lines) {
        if (line.startsWith('out_time_us=') && totalDurationMs) {
          const us = parseInt(line.slice('out_time_us='.length), 10);
          if (!isNaN(us) && us >= 0) {
            const progressMs = us / 1000;
            const pct = Math.min(100, (progressMs / totalDurationMs) * 100);
            renderProgressBar(pct);
          }
        }
        if (line.startsWith('progress=end')) {
          renderProgressBar(100);
          process.stderr.write('\n');
        }
      }
    });

    // Suppress stderr noise (ffmpeg prints banner, codec info, etc.)
    let stderrBuf = '';
    proc.stderr?.on('data', (chunk: Buffer) => {
      stderrBuf += chunk.toString();
    });

    proc.on('error', (err) => reject(new Error(`Failed to launch ffmpeg: ${err.message}`)));
    proc.on('close', (code) => {
      if (code !== 0) {
        // Show last 20 lines of stderr for debugging
        const lastLines = stderrBuf.split('\n').slice(-20).join('\n');
        reject(new Error(`ffmpeg failed with exit code ${code}\n${lastLines}`));
      } else {
        resolve();
      }
    });
  });
}

const BAR_WIDTH = 40;

function renderProgressBar(pct: number): void {
  const filled = Math.round((pct / 100) * BAR_WIDTH);
  const empty = BAR_WIDTH - filled;
  const bar = '\u2588'.repeat(filled) + '\u2591'.repeat(empty);
  process.stderr.write(`\r  Encoding: ${bar} ${pct.toFixed(1)}%`);
}
