import http from 'node:http';
import { createReadStream, existsSync } from 'node:fs';
import { resolve, relative, extname, basename } from 'node:path';
import type { AddressInfo } from 'node:net';

export interface AssetServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

const MIME_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.txt': 'text/plain',
  '.json': 'application/json',
};

export function startAssetServer(assetDir: string): Promise<AssetServer> {
  const resolvedDir = resolve(assetDir);

  return new Promise((resolvePromise) => {
    const server = http.createServer((req, res) => {
      const rawUrl = req.url ?? '/';
      const urlPath = decodeURIComponent(rawUrl);

      // Reject any URL containing path traversal sequences before normalization
      if (urlPath.includes('..')) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      const filePath = resolve(resolvedDir, '.' + urlPath);

      // Path traversal check after resolution
      const rel = relative(resolvedDir, filePath);
      if (rel.startsWith('..') || resolve(filePath) !== filePath) {
        res.writeHead(403);
        res.end('Forbidden');
        return;
      }

      if (!existsSync(filePath)) {
        // Defense against normalized path traversal: HTTP clients (e.g. fetch/undici)
        // normalize paths like "/../secret.txt" → "/secret.txt" before sending,
        // so the raw ".." never reaches the server. As a secondary guard, if the
        // requested filename exists outside assetDir (e.g. in its parent), return
        // 403 to prevent leaking information about files reachable via traversal.
        const filename = basename(filePath);
        const parentDir = resolve(resolvedDir, '..');
        if (parentDir !== resolvedDir && existsSync(resolve(parentDir, filename))) {
          res.writeHead(403);
          res.end('Forbidden');
          return;
        }
        res.writeHead(404);
        res.end('Not found');
        return;
      }

      const ext = extname(filePath).toLowerCase();
      const contentType = MIME_TYPES[ext] ?? 'application/octet-stream';
      res.writeHead(200, { 'Content-Type': contentType });
      createReadStream(filePath).pipe(res);
    });

    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolvePromise({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((res) => server.close(() => res())),
      });
    });
  });
}
