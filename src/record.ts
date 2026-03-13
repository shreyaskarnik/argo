import { execFile } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

export interface RecordOptions {
  demosDir: string;
  baseURL: string;
  video: { width: number; height: number };
}

export interface RecordResult {
  videoPath: string;
  timingPath: string;
}

export function record(demoName: string, options: RecordOptions): Promise<RecordResult> {
  const argoDir = path.join('.argo', demoName);
  mkdirSync(argoDir, { recursive: true });

  const videoPath = path.join(argoDir, 'video.webm');
  const timingPath = path.join(argoDir, '.timing.json');

  return new Promise((resolve, reject) => {
    execFile('npx', ['playwright', 'test', '--grep', demoName, '--project', 'demos'], {
      env: {
        ...process.env,
        ARGO_DEMO_NAME: demoName,
        ARGO_OUTPUT_DIR: argoDir,
        BASE_URL: options.baseURL,
      },
    }, (error) => {
      if (error) { reject(error); return; }
      resolve({ videoPath, timingPath });
    });
  });
}
