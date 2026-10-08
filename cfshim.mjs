/* ============================================================
   cfshim.mjs — Cloudflare Workers runtime shim for Node.js
   Provides: WebSocketPair, cloudflare:sockets connect(),
   D1 (better-sqlite3), ctx.waitUntil builder, request.cf.
   Node 18+ has native: Request/Response/fetch/crypto.subtle/
   TextEncoder/atob/btoa/ReadableStream.
   ============================================================ */
import net from 'net';
import crypto from 'crypto';
import { randomUUID } from 'crypto';

/* ---------- WebSocketPair ---------- */
/* CF semantics: const [client, server] = Object.values(new WebSocketPair());
   server.accept(); server.send(...); return new Response(null, {status:101, webSocket: client}); */
class ShimWSEndpoint {
  constructor() {
    this._events = {};
    this._queue = [];
    this.binaryType = 'arraybuffer';
    this._open = false;
  }
  _on(t, f) { (this._events[t] ||= []).push(f); if (t === 'open' && this._open) f({}); }
  addEventListener(t, f) { this._on(t, f); }
  _emit(t, ev) { (this._events[t] || []).forEach(f => { try { f(ev); } catch (e) {} }); }
  accept() { this._open = true; this._emit('open', {}); }
  send(data) {
    if (!this._open) return;
    let payload = data;
    if (data instanceof Uint8Array) payload = Buffer.from(data);
    else if (data instanceof ArrayBuffer) payload = Buffer.from(data);
    this._peer._emit('message', { data: payload });
  }
  close(code = 1000, reason = '') {
    if (!this._open && !this._events['close']) return;
    this._open = false;
    this._emit('close', { code, reason: reason || '' });
    if (this._peer && this._peer !== this) setTimeout(() => this._peer._emit('close', { code, reason: reason || '' }), 0);
  }
}

export class WebSocketPair {
  constructor() {
    const a = new ShimWSEndpoint();
    const b = new ShimWSEndpoint();
    a._peer = b; b._peer = a;
    // pair[0] = client, pair[1] = server  (panel uses Object.values order)
    this[0] = a;
    this[1] = b;
    // make Object.values() return [a, b] in insertion order
    this.length = 2;
  }
}

/* ---------- cloudflare:sockets connect() ---------- */
/* Panel usage: const sock = connect({ hostname, port }); await sock.opened;
   sock.writable.getWriter().write(...); sock.readable.pipeTo(...) */
export function connect({ hostname, port }) {
  const socket = net.connect({ host: hostname, port: Number(port) });
  let opened = new Promise((res, rej) => {
    socket.once('connect', res);
    socket.once('error', rej);
  });
  const reader = {
    _done: false,
    // minimal async iterator shim
    async *[Symbol.asyncIterator]() {
      yield* [];
    },
  };
  const wrapped = {
    opened,
    closed: new Promise((res) => socket.once('close', res)),
    close: async () => socket.destroy(),
    get remote() { return { address: socket.remoteAddress, port: socket.remotePort }; },
    // Writers/Readers: adapt net socket to what the panel expects.
    writable: {
      getWriter() {
        return {
          write: (data) => new Promise((res) => socket.write(Buffer.from(data), res)),
          close: async () => socket.end(),
          releaseLock: () => {},
        };
      },
    },
    readable: null, // set below
    _socket: socket,
  };
  // readable as a standard web ReadableStream
  const { ReadableStream } = globalThis;
  wrapped.readable = new ReadableStream({
    start(controller) {
      socket.on('data', (chunk) => controller.enqueue(new Uint8Array(chunk)));
      socket.on('end', () => controller.close());
      socket.on('error', (e) => controller.error(e));
    },
    cancel() { socket.destroy(); },
  });
  return wrapped;
}

/* ---------- D1 shim over better-sqlite3 ---------- */
export function makeD1(db) {
  const asyncWrap = (fn) => (...a) => Promise.resolve(fn(...a));
  return {
    _db: db,
    prepare(sql) {
      const stmt = db.prepare(sql);
      let bound = [];
      return {
        bind(...args) { bound = args; return this; },
        all: asyncWrap(() => {
          const rows = stmt.all(...bound);
          return { results: rows };
        }),
        run: asyncWrap(() => {
          const info = stmt.run(...bound);
          return { success: true, meta: { changes: info.changes, last_row_id: info.lastInsertRowid } };
        }),
        first: asyncWrap(() => stmt.get(...bound) ?? null),
      };
    },
    batch: asyncWrap((stmts) => {
      const out = [];
      for (const s of stmts) out.push(s);
      return out;
    }),
    exec: asyncWrap((sql) => db.exec(sql)),
  };
}

/* ---------- ctx (waitUntil) ---------- */
export function makeCtx() {
  const pendings = [];
  return {
    waitUntil(p) { if (p && typeof p.catch === 'function') p.catch(() => {}); pendings.push(p); },
    _drain: async () => { await Promise.allSettled(pendings.splice(0)); },
    passThroughOnException() {},
    set callers(v) {},
  };
}

/* ---------- env extras ---------- */
export function makeRequestCf(req) {
  return {
    country: req.headers.get('cf-ipcountry') || '??',
    asn: 0,
    city: '',
  };
}

export function randomToken(n = 32) {
  return crypto.randomBytes(n).toString('hex');
}

export { randomUUID };
