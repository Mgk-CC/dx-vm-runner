function createXMLHttpRequestClass({
  transport = fetch,
  journal = [],
  defaultTimeout = 10000,
  journalRequestHeaders = true,
  refererUrl = undefined,
  autoReferer = false,
  userAgent = undefined
} = {}) {
  const chromeVer = /Chrome\/(\d+)/.exec(userAgent || '');
  const version = chromeVer ? chromeVer[1] : '149';
  const secChUa = `"Google Chrome";v="${version}", "Chromium";v="${version}", "Not)A;Brand";v="24"`;
  return class XMLHttpRequestShim {
    constructor() {
      this.readyState = 0;
      this.status = 0;
      this.statusText = '';
      this.responseText = '';
      this.timeout = defaultTimeout;
      this.withCredentials = false;
      this.upload = {};
      this.requestHeaders = {};
      this.responseHeaders = {};
      this._controller = null;
      this._timer = null;
      this._settled = false;
      this._autoReferer = autoReferer;
      this._refererUrl = refererUrl;
      this._userAgent = userAgent;
      this._secChUa = secChUa;
    }

    open(method, url) {
      this.method = String(method).toUpperCase();
      this.url = String(url);
      this.readyState = 1;
    }

    setRequestHeader(name, value) {
      const headerName = String(name);
      const existingName = Object.keys(this.requestHeaders).find(
        key => key.toLowerCase() === headerName.toLowerCase()
      );
      const key = existingName || headerName;
      const headerValue = String(value);
      this.requestHeaders[key] = this.requestHeaders[key]
        ? `${this.requestHeaders[key]}, ${headerValue}`
        : headerValue;
    }

    _buildRequestHeaders() {
      const headers = { ...this.requestHeaders };
      if (this._autoReferer && this._refererUrl) {
        // 强制覆盖 Referer/Origin：782 SDK 硬编码 dingxiang-inc.com，四川航空会校验来源，
        // 必须改成 m.sichuanair.com。autoReferer 开启时始终用 refererUrl 覆盖。
        headers.Referer = this._refererUrl;
        try {
          const u = new URL(this._refererUrl);
          headers.Origin = u.origin;
        } catch {
          // leave Origin unset if refererUrl is not parseable
        }
      }
      // 补 UA 与 Client Hints（sec-ch-ua）：真实浏览器请求必带，缺失会判非真实浏览器。
      if (this._userAgent && !Object.keys(headers).some(k => k.toLowerCase() === 'user-agent')) {
        headers['User-Agent'] = this._userAgent;
      }
      if (this._secChUa && !Object.keys(headers).some(k => k.toLowerCase() === 'sec-ch-ua')) {
        headers['sec-ch-ua'] = this._secChUa;
        headers['sec-ch-ua-mobile'] = '?0';
        headers['sec-ch-ua-platform'] = '"Windows"';
      }
      // sec-fetch-* 头：真实浏览器请求必带（c1 抓包确认 dest=empty/mode=cors/site=same-site）
      if (!Object.keys(headers).some(k => k.toLowerCase() === 'sec-fetch-dest')) {
        headers['sec-fetch-dest'] = 'empty';
        headers['sec-fetch-mode'] = 'cors';
        headers['sec-fetch-site'] = 'same-site';
      }
      return headers;
    }

    send(body) {
      this._controller = new AbortController();
      this._settled = false;
      this._startTimeout();

      void this._send(body);
    }

    abort() {
      if (!this._controller || this._settled) {
        return;
      }
      this._settled = true;
      this._clearTimer();
      this._controller.abort();
      this._call('onabort');
    }

    getResponseHeader(name) {
      const found = Object.keys(this.responseHeaders).find(
        key => key.toLowerCase() === String(name).toLowerCase()
      );
      return found ? this.responseHeaders[found] : null;
    }

    getAllResponseHeaders() {
      const headers = Object.entries(this.responseHeaders);
      return headers.length === 0
        ? ''
        : `${headers.map(([name, value]) => `${name}: ${value}`).join('\r\n')}\r\n`;
    }

    // CORS 简单 header（不触发浏览器 preflight）
    // 非简单 header 必须先发 OPTIONS，否则服务器判非浏览器
    _isSimpleHeader(name) {
      const n = name.toLowerCase();
      return n === 'accept' || n === 'accept-language'
        || n === 'content-language' || n === 'content-type'
        || n === 'sec-fetch-dest' || n === 'sec-fetch-mode'
        || n === 'sec-fetch-site' || n === 'sec-fetch-user'
        || n.startsWith('sec-ch-') || n === 'pragma'
        || n === 'cache-control';
    }

    _hasCustomHeaders(headers) {
      return Object.keys(headers).some(k => !this._isSimpleHeader(k));
    }

    async _sendPreflight(headers) {
      const customNames = Object.keys(headers).filter(k => !this._isSimpleHeader(k));
      if (customNames.length === 0) return;
      try {
        await transport(this.url, {
          method: 'OPTIONS',
          headers: {
            Accept: '*/*',
            Origin: headers.Origin || 'https://m.sichuanair.com',
            Referer: headers.Referer || this._refererUrl || 'https://m.sichuanair.com/',
            'Access-Control-Request-Method': this.method,
            'Access-Control-Request-Headers': customNames.join(', ')
          },
          signal: AbortSignal.timeout(8000)
        });
      } catch {
        // preflight 失败不阻塞——浏览器也会在某些条件忽略 preflight 拒绝
      }
    }

    async _send(body) {
      try {
        const headers = this._buildRequestHeaders();
        // 对齐真实浏览器 CORS preflight 行为——非简单 header 先 OPTIONS
        if (this._hasCustomHeaders(headers)) {
          await this._sendPreflight(headers);
        }
        const response = await transport(this.url, {
          method: this.method,
          headers,
          body: this.method === 'GET' || this.method === 'HEAD' ? undefined : body,
          signal: this._controller.signal
        });
        if (this._settled) {
          return;
        }

        this.status = response.status;
        this.statusText = response.statusText;
        this.responseHeaders = Object.fromEntries(response.headers.entries());
        this.responseText = await response.text();
        if (this._settled) {
          return;
        }

        this._settled = true;
        this._clearTimer();
        journal.push({
          method: this.method,
          url: this.url,
          ...(journalRequestHeaders
            ? { requestHeaders: { ...headers } }
            : {}),
          status: this.status,
          responseHeaders: { ...this.responseHeaders },
          responseText: this.responseText
        });
        this.readyState = 4;
        this._call('onreadystatechange');
        this._call('onload');
      } catch (error) {
        if (this._settled) {
          return;
        }
        this._settled = true;
        this._clearTimer();
        this._call('onerror', error);
      }
    }

    _startTimeout() {
      if (this.timeout <= 0) {
        return;
      }
      this._timer = setTimeout(() => {
        if (this._settled) {
          return;
        }
        this._settled = true;
        this._clearTimer();
        this._controller.abort();
        this._call('ontimeout');
      }, this.timeout);
    }

    _clearTimer() {
      if (this._timer !== null) {
        clearTimeout(this._timer);
        this._timer = null;
      }
    }

    _call(name, ...args) {
      if (typeof this[name] === 'function') {
        this[name](...args);
      }
    }
  };
}

module.exports = { createXMLHttpRequestClass };
