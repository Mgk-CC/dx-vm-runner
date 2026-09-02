const { webcrypto } = require('node:crypto');
const { createDocument, createStorage, createIndexedDB } = require('./dom');

// gs.js 自定义 base64 字符表（真实浏览器用此表编码 _ua → ac）。
// 标准表 ABCD...WXYZabcd...wxyz0123456789+/= 的字符置换。必须与 vendor/gs.js 完全一致，
// 否则服务器按自定义表解码 VM 的 ac 失败 → 4011 HIGH_RISK。
const DX_B64_TABLE = 'XmYj3u1PnvisIZUF8ThR/a6DfO+kW4JHrCELycAzSxleoQp02MtwV9Nd57qGgbKB=';
const DX_B64_STD = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/=';

function customBase64Encode(input) {
  // 与 gs.js btoa 相同：每 3 字节 → 4 字符（自定义表索引）
  let out = '';
  for (let i = 0; i < input.length; i += 3) {
    const v = input.charCodeAt(i);
    const x = i + 1 < input.length ? input.charCodeAt(i + 1) : NaN;
    const e = i + 2 < input.length ? input.charCodeAt(i + 2) : NaN;
    const M = v >> 2;
    const R = ((v & 0x3) << 4) | (isNaN(x) ? 0 : x >> 4);
    const T = (isNaN(x) ? 0 : (x & 0xF) << 2) | (isNaN(e) ? 0 : e >> 6);
    const L = isNaN(e) ? 0 : e & 0x3F;
    out += DX_B64_TABLE[M] + DX_B64_TABLE[R];
    if (isNaN(x)) out += '==';
    else {
      out += DX_B64_TABLE[T];
      out += isNaN(e) ? '=' : DX_B64_TABLE[L];
    }
  }
  return out;
}

function customBase64Decode(input) {
  // 反向：自定义表 → 标准表索引 → 解码
  const lookup = {};
  for (let i = 0; i < DX_B64_TABLE.length; i++) lookup[DX_B64_TABLE[i]] = DX_B64_STD[i];
  let std = '';
  for (const ch of input) std += lookup[ch] || ch;
  return Buffer.from(std, 'base64').toString('binary');
}
const {
  createCanvasFactory,
  AudioContextShim,
  OfflineAudioContextShim
} = require('./canvas-env');

function createNavigator(profile) {
  // Construct non-Array PluginArray/MimeTypeArray to match real Chrome
  const pluginArrayProto = Object.create(Array.prototype);
  pluginArrayProto.item = function(i) { return this[i] || null; };
  pluginArrayProto.namedItem = function(name) { return this.find(p => p.name === name) || null; };
  pluginArrayProto.refresh = function() {};
  Object.defineProperty(pluginArrayProto, Symbol.iterator, {
    value: Array.prototype[Symbol.iterator],
    writable: true, configurable: true
  });

  const mimeArrayProto = Object.create(Array.prototype);
  mimeArrayProto.item = function(i) { return this[i] || null; };
  mimeArrayProto.namedItem = function(name) { return this.find(m => m.type === name) || null; };
  Object.defineProperty(mimeArrayProto, Symbol.iterator, {
    value: Array.prototype[Symbol.iterator],
    writable: true, configurable: true
  });

  // 对齐真实 Chrome 151：5 个 PDF 插件 + 2 个 MIME 类型（无 NaCl/x-nacl/x-pnacl，已废弃）
  const pluginObjects = [
    { name: 'PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 },
    { name: 'Chrome PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 },
    { name: 'Chromium PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 },
    { name: 'Microsoft Edge PDF Viewer', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 },
    { name: 'WebKit built-in PDF', filename: 'internal-pdf-viewer', description: 'Portable Document Format', length: 2 }
  ];
  const mimeObjects = [
    { type: 'application/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: pluginObjects[0] },
    { type: 'text/pdf', suffixes: 'pdf', description: 'Portable Document Format', enabledPlugin: pluginObjects[0] }
  ];

  const mimeTypes = Object.create(mimeArrayProto);
  Object.assign(mimeTypes, mimeObjects);
  mimeTypes.length = mimeObjects.length;

  const plugins = Object.create(pluginArrayProto);
  Object.assign(plugins, pluginObjects);
  plugins.length = pluginObjects.length;

  const userAgent = profile.navigator.userAgent;
  const uaVersionMatch = /Chrome\/(\d+)/.exec(userAgent);
  const chromeVersion = uaVersionMatch ? uaVersionMatch[1] : '151';

  return {
    ...profile.navigator,
    plugins,
    mimeTypes,
    webdriver: false,
    doNotTrack: null,
    onLine: true,
    cpuClass: undefined,
    product: 'Gecko',
    productSub: '20030107',
    vendor: 'Google Inc.',
    vendorSub: '',
    appCodeName: 'Mozilla',
    hardwareConcurrency: profile.navigator.hardwareConcurrency || 8,
    clipboard: { read: async () => { throw new Error('NotAllowedError'); }, write: async () => {}, readText: async () => { throw new Error('NotAllowedError'); }, writeText: async () => {} },
    permissions: { query: async () => ({ state: 'prompt' }) },
    connection: {
      effectiveType: '4g',
      rtt: 100,
      downlink: 10,
      saveData: false,
      type: 'ethernet'
    },
    geolocation: {
      getCurrentPosition: (success, error) => {
        if (error) error({ code: 1, message: 'User denied Geolocation' });
      }
    },
    mediaDevices: {
      enumerateDevices: async () => [
        { deviceId: 'default', kind: 'audioinput', label: '', groupId: 'default' },
        { deviceId: 'communications', kind: 'audioinput', label: '', groupId: 'communications' },
        { deviceId: 'default', kind: 'audiooutput', label: '', groupId: 'default' },
        { deviceId: 'communications', kind: 'audiooutput', label: '', groupId: 'communications' }
      ]
    },
    serviceWorker: undefined,
    storage: {
      estimate: async () => ({ ...profile.storage })
    },
    userAgentData: {
      brands: chromeVersion >= '151' ? [
        { brand: 'Not=A?Brand', version: '99' },
        { brand: 'Google Chrome', version: chromeVersion },
        { brand: 'Chromium', version: chromeVersion }
      ] : [{ brand: 'Google Chrome', version: chromeVersion }],
      mobile: false,
      platform: 'Windows',
      async getHighEntropyValues() {
        return {
          platform: 'Windows',
          platformVersion: '10.0.0',
          architecture: 'x86',
          bitness: '64',
          fullVersionList: [
            { brand: 'Google Chrome', version: `${chromeVersion}.0.0.0` }
          ]
        };
      }
    }
  };
}

function createBrowserEnvironment({
  profile,
  XMLHttpRequest,
  now = Date.now
}) {
  const canvasFactory = createCanvasFactory(profile);
  const document = createDocument({ canvasFactory });

  // Coherent time axis shared by all collectors (getTK, mouse events, etc.)
  const timingProfile = profile.timingProfile || {};
  const pageLoadMinMs = timingProfile.pageLoadMinMs || 5000;
  const pageLoadMaxMs = timingProfile.pageLoadMaxMs || 7000;
  const pageLoadOffset = pageLoadMinMs + Math.floor(Math.random() * (pageLoadMaxMs - pageLoadMinMs));
  const timeOrigin = now() - pageLoadOffset;

  const navStart = timeOrigin;
  const dnsEnd = navStart + 40;
  const tcpEnd = dnsEnd + 60;
  const requestStart = tcpEnd + 30;
  const responseStart = requestStart + 120;
  const responseEnd = responseStart + 180;
  const domComplete = navStart + 2500;
  const loadEventEnd = domComplete + 50;

  const timing = {
    navigationStart: navStart,
    unloadEventStart: 0,
    unloadEventEnd: 0,
    redirectStart: 0,
    redirectEnd: 0,
    fetchStart: navStart,
    domainLookupStart: navStart,
    domainLookupEnd: dnsEnd,
    connectStart: dnsEnd,
    connectEnd: tcpEnd,
    secureConnectionStart: dnsEnd,
    requestStart,
    responseStart,
    responseEnd,
    domLoading: responseEnd + 100,
    domInteractive: domComplete - 200,
    domContentLoadedEventStart: domComplete - 150,
    domContentLoadedEventEnd: domComplete - 100,
    domComplete,
    loadEventStart: domComplete,
    loadEventEnd,
    toJSON() { return { ...this }; }
  };

  function perfNow() {
    return now() - timeOrigin;
  }

  const navigationEntry = {
    name: profile.location.href,
    entryType: 'navigation',
    startTime: 0,
    duration: loadEventEnd - navStart,
    initiatorType: 'navigation',
    deliveryType: '',
    nextHopProtocol: 'h2',
    workerStart: 0,
    redirectStart: 0,
    redirectEnd: 0,
    fetchStart: timing.fetchStart - navStart,
    domainLookupStart: timing.domainLookupStart - navStart,
    domainLookupEnd: timing.domainLookupEnd - navStart,
    connectStart: timing.connectStart - navStart,
    connectEnd: timing.connectEnd - navStart,
    secureConnectionStart: timing.secureConnectionStart - navStart,
    requestStart: timing.requestStart - navStart,
    responseStart: timing.responseStart - navStart,
    responseEnd: timing.responseEnd - navStart,
    transferSize: 0,
    encodedBodySize: 0,
    decodedBodySize: 0,
    serverTiming: [],
    unloadEventStart: 0,
    unloadEventEnd: 0,
    domInteractive: timing.domInteractive - navStart,
    domContentLoadedEventStart: timing.domContentLoadedEventStart - navStart,
    domContentLoadedEventEnd: timing.domContentLoadedEventEnd - navStart,
    domComplete: timing.domComplete - navStart,
    loadEventStart: timing.loadEventStart - navStart,
    loadEventEnd: timing.loadEventEnd - navStart,
    type: 'navigate',
    redirectCount: 0,
    activationStart: 0,
    toJSON() { return { ...this }; }
  };

  const nativeIntl = Intl;

  const env = {
    document,
    navigator: createNavigator(profile),
    screen: {
      ...profile.screen,
      orientation: {
        type: 'landscape-primary',
        angle: 0,
        onchange: null
      }
    },
    location: {
      ...profile.location,
      ancestorOrigins: { length: 0 },
      assign: () => {}, replace: () => {}, reload: () => {},
      toString() { return this.href; }
    },
    history: { length: 1, scrollRestoration: 'manual' },
    openDatabase: undefined,
    performance: {
      now: perfNow,
      timeOrigin,
      timing,
      memory: { jsHeapSizeLimit: 4294705152, totalJSHeapSize: 10000000, usedJSHeapSize: 5000000 },
      navigation: { type: 0, redirectCount: 0, toJSON() { return { type: 0, redirectCount: 0 }; } },
      getEntriesByType(type) {
        return type === 'navigation' ? [navigationEntry] : [];
      },
      getEntries() {
        return [navigationEntry];
      },
      toJSON() { return { timeOrigin, timing: { ...timing } }; }
    },
    localStorage: createStorage(),
    sessionStorage: createStorage(),
    indexedDB: createIndexedDB(),
    XMLHttpRequest,
    AudioContext: AudioContextShim,
    webkitAudioContext: AudioContextShim,
    OfflineAudioContext: OfflineAudioContextShim,
    webkitOfflineAudioContext: OfflineAudioContextShim,
    // 关键：gs.js 自定义 base64 表（XmYj...），非标准 base64！
    // 真实浏览器 ac = s_v3#<自定义表 base64(_ua)>；Node 标准 btoa 编码会被服务器解码失败 → 4011。
    btoa: value => customBase64Encode(value),
    atob: value => customBase64Decode(value),
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    queueMicrotask,
    TextEncoder,
    TextDecoder,
    Blob,
    URL,
    AbortController,
    crypto: webcrypto,
    Intl: nativeIntl,
    // Node 18+ native Web APIs that real Chrome has
    fetch,
    Response,
    Request,
    Headers,
    FormData,
    Event,
    CustomEvent,
    EventTarget,
    ReadableStream,
    WritableStream,
    TransformStream,
    MessageChannel,
    MessagePort,
    BroadcastChannel,
    WebSocket,
    // Real Chrome has event constructors
    MouseEvent: globalThis.MouseEvent || class extends Event { constructor(t,i) { super(t,i||{}); Object.assign(this,i||{}); } },
    KeyboardEvent: globalThis.KeyboardEvent || class extends Event { constructor(t,i) { super(t,i||{}); Object.assign(this,i||{}); } },
    PointerEvent: globalThis.PointerEvent || class extends Event { constructor(t,i) { super(t,i||{}); Object.assign(this,i||{}); } },
    WheelEvent: globalThis.WheelEvent || class extends Event { constructor(t,i) { super(t,i||{}); Object.assign(this,i||{}); } },
    InputEvent: globalThis.InputEvent || class extends Event { constructor(t,i) { super(t,i||{}); Object.assign(this,i||{}); } },
    FocusEvent: globalThis.FocusEvent || class extends Event { constructor(t,i) { super(t,i||{}); Object.assign(this,i||{}); } },
    // Chrome namespace (for fingerprinting)
    chrome: {
      runtime: {},
      loadTimes: function() {},
      csi: function() {}
    },
    // Other DOM APIs
    MutationObserver: class MutationObserver {
      constructor() {}
      observe() {}
      disconnect() {}
      takeRecords() { return []; }
    },
    IntersectionObserver: class IntersectionObserver {
      constructor() {}
      observe() {}
      unobserve() {}
      disconnect() {}
    },
    ResizeObserver: class ResizeObserver {
      constructor() {}
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  };
  Object.assign(env, profile.window);
  env.window = env;
  env.self = env;
  env.globalThis = env;
  env.top = env;
  document.defaultView = env;
  return env;
}

module.exports = { createBrowserEnvironment };
