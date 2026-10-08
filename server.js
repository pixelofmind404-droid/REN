/* ============================================================
   server.js — Nahan v3.0.4 (itsyebekhe/nahan) on Node.js
   Runs the original Cloudflare Worker code (_worker.js) under
   a Node HTTP server with a CF-compatible environment.
   Persistence: SQLite (kv_store table) — same schema as D1 original.
   Ported from HamedPanelNode (cfshim) for the CF 1101 bug.
   ============================================================ */
import http from 'http';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { DatabaseSync } from 'node:sqlite';
import { WebSocketPair, connect, makeD1, makeCtx } from './cfshim.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 8787);
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'nahan_data.sqlite3');

/* ---------- storage: kv_store in SQLite (identical schema to the CF original) ---------- */
const db = new DatabaseSync(DB_PATH);
db.exec('CREATE TABLE IF NOT EXISTS kv_store (key TEXT PRIMARY KEY, value TEXT)');

/* ---------- load worker module ---------- */
// The worker imports "cloudflare:sockets" — rewrite to our shim and write to a real temp file
const workerCode = fs.readFileSync(path.join(__dirname, '_worker.js'), 'utf-8');

const patched = workerCode.replace(
  'import { connect } from "cloudflare:sockets";',
  'import { connect } from "./cfshim_sockets.mjs";'
);
const workerFile = path.join(__dirname, '.worker_patched.mjs');
fs.writeFileSync(workerFile, patched);
const { pathToFileURL } = await import('url');
const worker = await import(pathToFileURL(workerFile).href);
// Node ESM quirk: some module shapes land on `default.default` — normalize once
const workerMod = worker.default?.fetch ? worker.default : worker;

/* ---------- D1-compatible env ---------- */
const env = {
  IOT_DB: makeD1(db),
  IOT_DB_INITIALIZED: false,
  SESSIONS_KV: null,
  BACKUP_BUCKET: null,
  RELAY_IP: undefined,
};

/* ---------- HTTP server: translate Node req/res ↔ CF Request/Response ---------- */
const server = http.createServer(async (req, res) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);

    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) {
      if (Array.isArray(v)) v.forEach(vv => headers.append(k, vv));
      else if (v != null) headers.append(k, v);
    }
    if (!headers.has('cf-connecting-ip')) {
      headers.set('cf-connecting-ip', req.socket.remoteAddress || '127.0.0.1');
    }

    const method = req.method || 'GET';
    let body = null;
    if (!['GET', 'HEAD'].includes(method)) {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      body = buf.length ? buf : null;
    }

    const request = new Request(urlObj.toString(), {
      method,
      headers,
      body,
      ...(body ? { duplex: 'half' } : {}),
    });

    const ctx = makeCtx();
    const response = await workerMod.fetch(request, env, ctx);
    await ctx._drain();

    const outHeaders = {};
    response.headers.forEach((v, k) => { outHeaders[k] = v; });

    if (response.status === 101 && response.webSocket) {
      res.writeHead(400);
      res.end('WS handled elsewhere');
      return;
    }

    res.writeHead(response.status, outHeaders);
    if (response.body) {
      const reader = response.body.getReader();
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(Buffer.from(value));
      }
    }
    res.end();
  } catch (e) {
    console.error('[server] request error:', e.message);
    try { res.writeHead(500, { 'Content-Type': 'text/plain' }); res.end('Internal error: ' + e.message); } catch (x) { /* noop */ }
  }
});

/* ---------- WebSocket (telemetry path) over the same HTTP server ---------- */
const wss = new (await import('ws')).WebSocketServer({ noServer: true });

server.on('upgrade', async (req, socket, head) => {
  try {
    const urlObj = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    const headers = new Headers();
    for (const [k, v] of Object.entries(req.headers)) headers.set(k, v);
    headers.set('cf-connecting-ip', req.socket.remoteAddress || '127.0.0.1');

    const request = new Request(urlObj.toString(), { method: 'GET', headers });
    const ctx = makeCtx();
    const response = await workerMod.fetch(request, env, ctx);

    if (response.status === 101 && response.webSocket) {
      wss.handleUpgrade(req, socket, head, (clientWs) => {
        const pairClient = response.webSocket;
        pairClient.accept?.();
        clientWs.on('message', (data) => { try { pairClient.send(new Uint8Array(data)); } catch (e) {} });
        pairClient.addEventListener('message', (ev) => { try { clientWs.send(Buffer.from(ev.data)); } catch (e) {} });
        const bye = () => { try { pairClient.close(1000, ''); } catch (e) {} try { clientWs.close(1000, ''); } catch (e) {} };
        clientWs.on('close', bye);
        pairClient.addEventListener('close', bye);
      });
    } else {
      socket.destroy();
    }
  } catch (e) {
    console.error('[server] upgrade error:', e.message);
    try { socket.destroy(); } catch (x) {}
  }
});

server.listen(PORT, () => {
  console.log(`[server] Nahan (Node port) listening on http://127.0.0.1:${PORT}`);
  console.log('[server] DB:', DB_PATH);
});

/* ---------- scheduled (cron) — Nahan uses it only for optional auto-update ---------- */
// autoUpdate defaults to false, so this is a no-op unless enabled in the panel.
setInterval(async () => {
  try {
    const ctx = makeCtx();
    await workerMod.scheduled?.({ scheduledTime: Date.now() }, env, ctx);
    await ctx._drain();
    console.log('[cron] scheduled handler ran');
  } catch (e) {
    console.error('[cron] error:', e.message);
  }
}, 15 * 60 * 1000).unref();
