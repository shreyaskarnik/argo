import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { loadConfig } from './config.js';

interface CheckResult {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  message: string;
}

function checkCommand(cmd: string, args: string[]): string | null {
  try {
    return execFileSync(cmd, args, { encoding: 'utf-8', stdio: 'pipe' }).trim();
  } catch {
    return null;
  }
}

export async function runDoctor(cwd: string = process.cwd()): Promise<CheckResult[]> {
  const results: CheckResult[] = [];

  // 1. ffmpeg
  const ffmpegVersion = checkCommand('ffmpeg', ['-version']);
  if (ffmpegVersion) {
    const version = ffmpegVersion.split('\n')[0];
    results.push({ name: 'ffmpeg', status: 'ok', message: version });
  } else {
    results.push({ name: 'ffmpeg', status: 'fail', message: 'Not found. Install: brew install ffmpeg (macOS) or apt install ffmpeg (Linux)' });
  }

  // 2. ffprobe
  const ffprobeVersion = checkCommand('ffprobe', ['-version']);
  if (ffprobeVersion) {
    results.push({ name: 'ffprobe', status: 'ok', message: 'Available' });
  } else {
    results.push({ name: 'ffprobe', status: 'fail', message: 'Not found (usually comes with ffmpeg)' });
  }

  // 3. Playwright browsers
  const browsers = ['chromium', 'webkit', 'firefox'];
  for (const browser of browsers) {
    const check = checkCommand('npx', ['playwright', 'install', '--dry-run', browser]);
    // If playwright is installed, check the browser registry
    const registryPath = `node_modules/playwright-core/.local-browsers`;
    if (existsSync(registryPath)) {
      results.push({ name: `playwright/${browser}`, status: 'ok', message: 'Installed' });
    } else {
      // Just check if playwright itself is available
      const pwVersion = checkCommand('npx', ['playwright', '--version']);
      if (pwVersion) {
        results.push({ name: `playwright/${browser}`, status: 'warn', message: `Playwright ${pwVersion} found — run: npx playwright install ${browser}` });
      } else {
        results.push({ name: `playwright/${browser}`, status: 'fail', message: 'Playwright not found' });
      }
    }
  }

  // 4. Config file
  const configFiles = ['argo.config.mjs', 'argo.config.js', 'argo.config.ts'];
  const foundConfig = configFiles.find(f => existsSync(f));
  if (foundConfig) {
    results.push({ name: 'config', status: 'ok', message: foundConfig });

    // 5. Load and validate config
    try {
      const config = await loadConfig(cwd);

      // baseURL
      if (config.baseURL) {
        results.push({ name: 'baseURL', status: 'ok', message: config.baseURL });
      } else {
        results.push({ name: 'baseURL', status: 'warn', message: 'Not set — required for record/pipeline. Set in config or use --base-url' });
      }

      // demosDir
      if (existsSync(config.demosDir)) {
        results.push({ name: 'demosDir', status: 'ok', message: config.demosDir });
      } else {
        results.push({ name: 'demosDir', status: 'warn', message: `${config.demosDir} does not exist — run: npx argo init` });
      }

      // thumbnail
      if (config.export.thumbnailPath) {
        if (existsSync(config.export.thumbnailPath)) {
          results.push({ name: 'thumbnail', status: 'ok', message: config.export.thumbnailPath });
        } else {
          results.push({ name: 'thumbnail', status: 'warn', message: `${config.export.thumbnailPath} not found — video will export without cover art` });
        }
      }

      // video settings
      const { width, height, browser, deviceScaleFactor } = config.video;
      results.push({ name: 'video', status: 'ok', message: `${width}x${height} @ ${browser}, scale=${deviceScaleFactor}` });

      if (deviceScaleFactor > 1 && browser === 'webkit') {
        results.push({ name: 'video/dpi', status: 'warn', message: 'deviceScaleFactor > 1 has known issues with webkit — stick to 1 for now' });
      }

    } catch (err) {
      results.push({ name: 'config/load', status: 'fail', message: (err as Error).message });
    }
  } else {
    results.push({ name: 'config', status: 'warn', message: 'No config file found — run: npx argo init' });
  }

  return results;
}

export function formatDoctorResults(results: CheckResult[]): string {
  const lines: string[] = ['Argo Doctor', '─'.repeat(50)];

  for (const r of results) {
    const icon = r.status === 'ok' ? '✓' : r.status === 'warn' ? '!' : '✗';
    const prefix = r.status === 'ok' ? '  ' : r.status === 'warn' ? '  ' : '  ';
    lines.push(`${prefix}${icon} ${r.name.padEnd(22)} ${r.message}`);
  }

  lines.push('─'.repeat(50));
  const fails = results.filter(r => r.status === 'fail').length;
  const warns = results.filter(r => r.status === 'warn').length;
  if (fails > 0) {
    lines.push(`  ${fails} issue(s) need fixing`);
  } else if (warns > 0) {
    lines.push(`  All good, ${warns} warning(s)`);
  } else {
    lines.push('  All checks passed');
  }

  return lines.join('\n');
}
