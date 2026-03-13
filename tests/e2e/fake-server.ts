import http from 'node:http';
import type { AddressInfo } from 'node:net';

const HTML = `<!DOCTYPE html>
<html>
<head><title>Argo E2E Test</title></head>
<body>
  <h1>Welcome to Argo Demo</h1>
  <p>This is a fake app for E2E testing.</p>
  <button id="action" onclick="document.getElementById('result').textContent='Done!'">
    Get Started
  </button>
  <div id="result"></div>
</body>
</html>`;

export interface FakeServer {
  url: string;
  port: number;
  close: () => Promise<void>;
}

export function startFakeServer(): Promise<FakeServer> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(HTML);
    });

    const onError = (error: Error) => {
      reject(error);
    };

    server.once('error', onError);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', onError);
      const { port } = server.address() as AddressInfo;
      resolve({
        url: `http://127.0.0.1:${port}`,
        port,
        close: () => new Promise((res, rej) => server.close((error) => (error ? rej(error) : res()))),
      });
    });
  });
}
