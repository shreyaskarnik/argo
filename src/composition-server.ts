// Lightweight HTTP server for renderComposition. Avoids file:// CORS gotchas
// (chromium blocks file:// from fetching sibling assets even with
// --allow-file-access-from-files for some asset types) and the relative-path
// rewrite that would otherwise be needed when the composition lives in a
// subdirectory but references siblings (e.g. compositions/foo.html loading
// models/bar.glb at the project root).
//
// Pattern: serve `rootDir` (typically the project root) with path-traversal
// protection; expose the composition at `/composition.html` with a `<base
// href="/">` tag injected into <head> so relative URLs resolve from root.
//
// Reuses startAssetServer's structure but extends MIME coverage for the
// asset types compositions actually consume (.html, .glb, .js, .css, etc.).
import http from 'node:http';
import { createReadStream, existsSync, readFileSync, statSync } from 'node:fs';
import { resolve, relative, extname, normalize } from 'node:path';

const MIME_TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.bin': 'application/octet-stream',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
};

export interface CompositionServer {
  /** URL of the composition entry point (HTML with <base href="/"> injected). */
  url: string;
  port: number;
  close: () => Promise<void>;
}

export function startCompositionServer(
  rootDir: string,
  compositionPath: string,
): Promise<CompositionServer> {
  const resolvedRoot = resolve(rootDir);
  const resolvedComp = resolve(compositionPath);

  if (!existsSync(resolvedComp)) {
    return Promise.reject(new Error(`composition file not found: ${resolvedComp}`));
  }
  // Composition must live inside rootDir so relative refs from inside it
  // can target sibling directories at root level.
  const rel = relative(resolvedRoot, resolvedComp);
  if (rel.startsWith('..')) {
    return Promise.reject(new Error(
      `composition ${resolvedComp} must be inside rootDir ${resolvedRoot}`
    ));
  }

  return new Promise((resolveP, rejectP) => {
    const server = http.createServer((req, res) => {
      const rawUrl = req.url ?? '/';
      const urlPath = decodeURIComponent(rawUrl.split('?')[0]);

      // Special-case the composition entry. The browser will resolve
      // relative URLs in the composition against the document URL, so
      // /composition.html with <base href="/"> forces them to root.
      if (urlPath === '/composition.html' || urlPath === '/') {
        try {
          let html = readFileSync(resolvedComp, 'utf-8');
          if (!/<base\b/i.test(html)) {
            html = /<head\b[^>]*>/i.test(html)
              ? html.replace(/<head\b([^>]*)>/i, '<head$1><base href="/">')
              : `<base href="/">\n${html}`;
          }
          res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
          res.end(html);
        } catch (err) {
          res.writeHead(500);
          res.end(`composition read failed: ${(err as Error).message}`);
        }
        return;
      }

      // Reject obvious traversal attempts before normalization.
      if (urlPath.includes('..') || urlPath.includes('\0')) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      const filePath = normalize(resolve(resolvedRoot, '.' + urlPath));
      const relPath = relative(resolvedRoot, filePath);
      if (relPath.startsWith('..')) {
        res.writeHead(403); res.end('Forbidden'); return;
      }

      if (!existsSync(filePath)) { res.writeHead(404); res.end('Not Found'); return; }
      try {
        const stat = statSync(filePath);
        if (!stat.isFile()) { res.writeHead(403); res.end('Not a file'); return; }
        const ext = extname(filePath).toLowerCase();
        const mime = MIME_TYPES[ext] ?? 'application/octet-stream';
        res.writeHead(200, { 'Content-Type': mime, 'Content-Length': String(stat.size) });
        createReadStream(filePath).pipe(res);
      } catch (err) {
        res.writeHead(500);
        res.end(`read failed: ${(err as Error).message}`);
      }
    });

    server.on('error', rejectP);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        rejectP(new Error('composition server failed to bind'));
        return;
      }
      resolveP({
        url: `http://127.0.0.1:${address.port}/composition.html`,
        port: address.port,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  });
}
