const http = require('node:http');
const https = require('node:https');
const tls = require('node:tls');
const zlib = require('node:zlib');
const { URL } = require('node:url');

// 给 promise 加超时护栏，防止任何中间态悬挂（悬挂会让 Node 检测不到活动句柄 → 静默退出）。
function withTimeout(promise, ms, message) {
  if (!ms || ms <= 0) return promise;
  promise.catch(() => {}); // 防 timeout 分支胜出后原 promise reject 变 unhandledRejection
  let timer = null;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

// HTTP CONNECT 代理 fetch（Node 原生 fetch 不读 HTTP_PROXY）。
// 手动 CONNECT 隧道 + tls.connect({socket})，已验证可行。
function createProxiedFetch(proxyUrl) {
  const proxy = new URL(proxyUrl);

  // 代理 URL 带 user:pass 时，CONNECT 请求加 Proxy-Authorization（账号密码模式）
  const authHeader = proxy.username || proxy.password
    ? 'Basic ' + Buffer.from(proxy.username + ':' + proxy.password).toString('base64')
    : null;

  function connectTunnel(host, port, timeout, signal) {
    return new Promise((resolve, reject) => {
      // 不缓存隧道：请求带 Connection: close，服务器响应后关闭连接，
      // 复用缓存里的死 socket 会让下一请求 TLS 握手失败（同一 host 连续请求必现）。
      // 串行流程下每次新建 CONNECT 仅多一次往返，且符合"每轮全新会话"纪律。
      const headers = { Host: `${host}:${port}`, 'Proxy-Connection': 'Keep-Alive' };
      if (authHeader) headers['Proxy-Authorization'] = authHeader;
      const req = http.request({
        host: proxy.hostname,
        port: proxy.port || 80,
        method: 'CONNECT',
        path: `${host}:${port}`,
        headers
      });
      const onAbort = () => { req.destroy(); reject(new Error('aborted')); };
      const timer = timeout > 0 ? setTimeout(() => { req.destroy(); reject(new Error('proxy CONNECT timeout')); }, timeout) : null;
      if (signal) {
        if (signal.aborted) return onAbort();
        signal.addEventListener('abort', onAbort, { once: true });
      }
      req.on('connect', (res, socket) => {
        if (timer) clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
        if (res.statusCode !== 200) {
          socket.destroy();
          return reject(new Error('proxy CONNECT failed: ' + res.statusCode));
        }
        resolve(socket);
      });
      req.on('error', reject);
      req.end();
    });
  }

  async function requestThroughTunnel(target, init) {
    const isHttps = target.protocol === 'https:';
    const port = target.port || (isHttps ? 443 : 80);
    const path = target.pathname + target.search;
    const timeout = typeof init.timeout === 'number' ? init.timeout : 0;
    const signal = init.signal || null;
    const headers = {};
    if (init.headers) {
      for (const k of Object.keys(init.headers)) headers[k] = init.headers[k];
    }
    if (init.body && !headers['content-length']) headers['content-length'] = Buffer.byteLength(init.body);

    const tunnel = await withTimeout(connectTunnel(target.hostname, port, timeout, signal), timeout, 'proxy CONNECT timeout');
    const rawSocket = isHttps
      ? tls.connect({ socket: tunnel, servername: target.hostname })
      : tunnel;

    if (timeout > 0) rawSocket.setTimeout(timeout);
    const onSocketTimeout = () => { rawSocket.destroy(); };
    rawSocket.on('timeout', onSocketTimeout);
    const onAbort = () => { rawSocket.destroy(); };
    if (signal) {
      if (signal.aborted) { rawSocket.destroy(); throw new Error('aborted'); }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    if (isHttps) {
      await withTimeout(
        new Promise((resolve, reject) => {
          rawSocket.once('secureConnect', resolve);
          rawSocket.once('error', reject);
          // 关键兜底：超时/代理异常 destroy socket 时可能只触发 close 不触发 error，
          // 若不 reject，secureConnect promise 永不 settle → Node 静默退出（无日志）。
          rawSocket.once('close', () => reject(new Error('tls handshake interrupted (socket closed)')));
        }),
        timeout,
        'tls handshake timeout'
      );
    }

    const reqLine = `${init.method || 'GET'} ${path} HTTP/1.1\r\n`;
    const hostLine = `Host: ${target.hostname}\r\n`;
    let reqHead = reqLine + hostLine;
    for (const [k, v] of Object.entries(headers)) reqHead += `${k}: ${v}\r\n`;
    reqHead += 'Connection: close\r\n\r\n';

    return new Promise((resolve, reject) => {
      const parser = new HttpResponseParser();
      rawSocket.on('data', chunk => parser.push(chunk));
      rawSocket.on('error', reject);
      rawSocket.on('close', () => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (timeout > 0) rawSocket.removeListener('timeout', onSocketTimeout);
        if (!parser.done) reject(new Error('connection closed before response complete'));
      });
      rawSocket.write(reqHead + (init.body || ''));
      parser.onDone(({ status, headers, bodyBytes }) => {
        if (signal) signal.removeEventListener('abort', onAbort);
        if (timeout > 0) rawSocket.removeListener('timeout', onSocketTimeout);
        rawSocket.destroy(); // 释放连接，配合 Connection: close，不留死 socket
        // 2026-08-04 修复:代理层不解压 gzip → callWeb(1) 的航班列表(37KB gzip)被 JSON.parse 失败,
        // 打成 status=?。这里按 content-encoding 解压,并去掉 encoding 头(下游视为明文)。
        const enc = (headers['content-encoding'] || '').toLowerCase();
        let bodyBuf = Buffer.from(bodyBytes);
        if (enc === 'gzip') {
          try {
            bodyBuf = zlib.gunzipSync(bodyBuf);
            delete headers['content-encoding'];
            delete headers['content-length'];
          } catch (e) {
            // 解压失败:保留原样(可能是伪 gzip 头),下游 JSON.parse 会自然失败
          }
        }
        resolve(new Response(bodyBuf, { status, headers }));
      });
    });
  }

  return (url, init = {}) => {
    const target = new URL(url);
    return requestThroughTunnel(target, init);
  };
}

// 简单 HTTP/1.1 响应解析器（代理场景，需解析 status/headers/body）
class HttpResponseParser {
  constructor() {
    this.buffer = Buffer.alloc(0);
    this.headersDone = false;
    this.status = 0;
    this.headers = {};
    this.body = [];
    this.done = false;
    this._listeners = [];
  }
  push(chunk) {
    this.buffer = Buffer.concat([this.buffer, chunk]);
    if (!this.headersDone) {
      const idx = this.buffer.indexOf('\r\n\r\n');
      if (idx === -1) return;
      const headStr = this.buffer.slice(0, idx).toString('latin1');
      const lines = headStr.split('\r\n');
      const statusMatch = /^HTTP\/1\.[01] (\d+)/.exec(lines[0]);
      this.status = statusMatch ? parseInt(statusMatch[1], 10) : 0;
      for (let i = 1; i < lines.length; i++) {
        const c = lines[i].indexOf(':');
        if (c > 0) this.headers[lines[i].slice(0, c).trim().toLowerCase()] = lines[i].slice(c + 1).trim();
      }
      this.headersDone = true;
      this.buffer = this.buffer.slice(idx + 4);
    }
    // 处理 chunked 编码
    if (this.headersDone && this.headers['transfer-encoding'] === 'chunked') {
      this._parseChunked();
    } else if (this.headersDone) {
      this.body.push(this.buffer);
      this.buffer = Buffer.alloc(0);
      const len = parseInt(this.headers['content-length'] || '0', 10);
      const bodyLen = this.body.reduce((a, b) => a + b.length, 0);
      if (this.headers['content-length'] === undefined || bodyLen >= len) {
        this._finish();
      }
    }
  }
  _parseChunked() {
    while (true) {
      const idx = this.buffer.indexOf('\r\n');
      if (idx === -1) break;
      const sizeStr = this.buffer.slice(0, idx).toString('latin1').split(';')[0].trim();
      const size = parseInt(sizeStr, 16);
      if (Number.isNaN(size)) break;
      if (size === 0) {
        this.buffer = Buffer.alloc(0);
        this._finish();
        return;
      }
      if (this.buffer.length < idx + 2 + size + 2) break;
      this.body.push(this.buffer.slice(idx + 2, idx + 2 + size));
      this.buffer = this.buffer.slice(idx + 2 + size + 2);
    }
  }
  _finish() {
    if (this.done) return;
    this.done = true;
    this._listeners.forEach(cb => cb({ status: this.status, headers: this.headers, bodyBytes: Buffer.concat(this.body) }));
  }
  onDone(cb) {
    if (this.done) cb({ status: this.status, headers: this.headers, bodyBytes: Buffer.concat(this.body) });
    else this._listeners.push(cb);
  }
}

module.exports = { createProxiedFetch };
