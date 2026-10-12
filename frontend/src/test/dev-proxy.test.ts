// Real HTTP checks with isolated synthetic servers; never use the private API.
import { createServer as createHTTPServer, request } from 'node:http';
import { readFile } from 'node:fs/promises';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { createServer, type ViteDevServer } from 'vite';
import config from '../../vite.config';

let vite: ViteDevServer;
let authority: string;
let apiAuthority: string;
const seen: Array<{ host?: string; origin?: string; cookie?: string; url?: string }> = [];
const backend = createHTTPServer((req, res) => {
  seen.push({
    host: req.headers.host,
    origin: req.headers.origin,
    cookie: req.headers.cookie,
    url: req.url,
  });
  const hostOK = req.headers.host === apiAuthority;
  const originOK = req.method === 'GET' || req.headers.origin === `http://${apiAuthority}`;
  res.writeHead(hostOK && originOK ? 200 : 403, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ synthetic: true }));
});
function send(path: string, method = 'GET', origin?: string, omitHost = false) {
  return new Promise<{ status: number; headers: Record<string, unknown> }>((resolve, reject) => {
    const req = request(
      `http://${authority}${path}`,
      {
        method,
        setHost: !omitHost,
        headers: {
          Cookie: 'synthetic-session=synthetic-only',
          ...(origin === undefined ? {} : { Origin: origin }),
        },
      },
      (res) => {
        res.resume();
        res.on('end', () => resolve({ status: res.statusCode!, headers: res.headers }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}
beforeAll(async () => {
  await new Promise<void>((resolve) => backend.listen(0, '127.0.0.1', resolve));
  apiAuthority = `127.0.0.1:${(backend.address() as { port: number }).port}`;
  const proxy = Object.fromEntries(
    Object.entries(config.server!.proxy!).map(([path, options]) => [
      path,
      typeof options === 'string'
        ? `http://${apiAuthority}`
        : { ...options, target: `http://${apiAuthority}` },
    ]),
  );
  vite = await createServer({
    ...config,
    configFile: false,
    server: { ...config.server, host: '127.0.0.1', port: 0, proxy },
  });
  await vite.listen();
  authority = `127.0.0.1:${(vite.httpServer!.address() as { port: number }).port}`;
}, 30_000);
afterAll(async () => {
  await vite?.close();
  await new Promise<void>((resolve, reject) => backend.close((e) => (e ? reject(e) : resolve())));
});
it('defaults to fixed loopback development without automatic LAN exposure or permissive CORS', async () => {
  const pkg = JSON.parse(await readFile('package.json', 'utf8'));
  expect(pkg.scripts.dev).toBe('vite');
  expect(config.server).toMatchObject({
    host: '127.0.0.1',
    port: 5173,
    strictPort: true,
    cors: false,
  });
});
it('proxies API, docs and schema with the exact upstream Host', async () => {
  for (const path of ['/api/v1/session', '/docs', '/openapi.json']) {
    expect((await send(path)).status).toBe(200);
    expect(seen.at(-1)).toMatchObject({
      host: apiAuthority,
      url: path,
      cookie: 'synthetic-session=synthetic-only',
    });
  }
});
it('translates only a matching browser development Origin for cookie mutations', async () => {
  for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
    expect((await send('/api/v1/session', method, `http://${authority}`)).status).toBe(200);
    expect(seen.at(-1)).toMatchObject({ host: apiAuthority, origin: `http://${apiAuthority}` });
  }
});
it('preserves hostile or missing Origins so the private backend rejects cookie mutations', async () => {
  for (const origin of [
    undefined,
    'http://hostile.invalid',
    'null',
    'http://127.0.0.1:1',
    `http://${authority}/`,
    `https://${authority}`,
  ]) {
    const response = await send('/api/v1/session', 'POST', origin);
    expect(response.status).toBe(403);
    expect(seen.at(-1)?.origin).toBe(origin);
    expect(response.headers['access-control-allow-origin']).toBeUndefined();
  }
});
it('rejects a missing incoming Host before forwarding a cookie mutation', async () => {
  const before = seen.length;
  const response = await send('/api/v1/session', 'POST', 'http://undefined', true);
  expect(response.status).toBe(400);
  expect(seen).toHaveLength(before);
});
