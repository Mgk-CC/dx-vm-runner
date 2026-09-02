const path = require('node:path');
const { createBrowserEnvironment } = require('./browser-env');
const { createXMLHttpRequestClass } = require('./xhr');
const {
  ensureContext,
  loadGlobalBundle
} = require('./load-vendor');
const vendorDirectory = path.resolve(__dirname, '..', 'vendor');
const { validateC1Response, validateServer, validateAc } = require('./validate');
const { withTimeout } = require('./with-timeout');

async function settleThenable(thenable) {
  try {
    return { status: 'fulfilled', value: await thenable };
  } catch (reason) {
    return { status: 'rejected', reason };
  }
}

function createCookiejarTransport(baseTransport) {
  // 2026-08-04 修复:jar 按 host 过滤 cookie(真实浏览器 cookie 是 host 隔离的)。
  // 之前无 host 过滤:callWeb(0) 在 m.sichuanair.com 下发的 acw_tc/JSESSIONID 被附加到
  // rcs.sichuanair.com 的 a/p1/p2/v1 请求(cross-domain 泄漏),且 callWeb(1) 带真实浏览器
  // 没有的 Cookie 头 → RISK_VALID_REJECT。按 (host, name) 存。
  const jar = new Map(); // key = `${host}|${name}`

  function cookieHost(url) {
    try { return new URL(url).host; } catch { return ''; }
  }

  async function wrapped(url, init) {
    const host = cookieHost(url);
    // 只发目标 host 的 cookie(真实浏览器同源策略)
    const cookies = [...jar.entries()]
      .filter(([k]) => k.startsWith(host + '|'))
      .map(([k, v]) => k.slice(host.length + 1) + '=' + v);
    const requestInit = init === undefined ? {} : { ...init };
    if (cookies.length) {
      requestInit.headers = { ...(requestInit.headers || {}), Cookie: cookies.join('; ') };
    }

    const resp = await baseTransport(url, requestInit);

    // Extract Set-Cookie from response. Use getSetCookie() so each cookie is
    // split by the HTTP parser (a combined header would break on the comma in
    // Expires and let attributes leak into the jar as fake cookies).
    const values = typeof resp.headers.getSetCookie === 'function'
      ? resp.headers.getSetCookie()
      : (resp.headers.get('set-cookie') || '').split(',').filter(Boolean);
    for (const raw of values) {
      const nameValue = String(raw).split(';')[0];
      const eq = nameValue.indexOf('=');
      if (eq > 0) {
        jar.set(host + '|' + nameValue.substring(0, eq).trim(), nameValue.substring(eq + 1).trim());
      }
    }

    return resp;
  }

  wrapped.jar = jar; // 保持兼容(外部合并 c1 阶段 cookie 用)
  return wrapped;
}

function createVendorContext({
  profile,
  transport = fetch,
  timeout,
  now = Date.now
}) {
  const journal = [];
  const cookieTransport = createCookiejarTransport(transport);
  const XMLHttpRequest = createXMLHttpRequestClass({
    transport: cookieTransport,
    journal,
    defaultTimeout: timeout,
    journalRequestHeaders: false,
    // 真实 c1 请求 Referer = 站点根路径（2026-08-01 抓包确认），非页面完整 URL
    refererUrl: profile.location.origin ? new URL(profile.location.href).origin + '/' : profile.location.href,
    autoReferer: true,
    userAgent: profile.navigator?.userAgent
  });
  const environment = createBrowserEnvironment({ profile, XMLHttpRequest, now });
  const context = ensureContext(environment);
  context.XMLHttpRequest = XMLHttpRequest;
  return { context, journal, cookieJar: cookieTransport.jar };
}

async function runC1({
  appId,
  server,
  profile,
  timeout,
  transport
}) {
  if (typeof appId !== 'string' || appId.length === 0) {
    throw new TypeError('appId must be a non-empty string');
  }
  // 782 SDK 要求 server 必填（5755 可省略走 constid.dingxiang-inc.com）。项目只面向四川航空，
  // 未传 server 时补四川 rcs 默认端点。
  const resolvedServer = server === undefined
    ? 'https://rcs.sichuanair.com/udid/c1'
    : server;
  const validatedServer = validateServer(resolvedServer);

  const { context, journal, cookieJar } = createVendorContext({
    profile,
    transport,
    timeout
  });
  // 四川航空实际 constid SDK 是 v1.782.0：浏览器全局脚本，导出到 window._dx.ConstID
  // （非 CommonJS module.exports）。用 loadGlobalBundle 加载，从全局取 ConstID。
  loadGlobalBundle(context, path.join(vendorDirectory, 'index.js'));
  const ConstID = context._dx?.ConstID;
  if (typeof ConstID !== 'function') {
    throw new Error('vendor ConstID unavailable (window._dx.ConstID)');
  }
  const vendorOutcome = await settleThenable(
    withTimeout(
      ConstID({
        appId,
        cache: false,
        timeout,
        ...(validatedServer === undefined ? {} : { server: validatedServer })
      }),
      (timeout || 10000) + 3000,
      'ConstID'
    )
  );
  const vendorRejected = vendorOutcome.status === 'rejected';

  // 从 journal 中找到第一条成功、可解析、含非空 data 的响应作为权威值。
  // 官方 demo 返回纯 JSON（GET/POST 相同）；四川航空 GET 返回纯 JSON、POST 返回
  // JSONP（`_callback({...})`），vendor resolve 的值是 Param 封装（#5755#base64）
  // 而非明文 constID，因此统一以 journal 中的明文 data 为准。
  // 782 SDK 会发两次 c1：第一次可能 status:-4（lid invalid，本地 cookie 校验），
  // 第二次 status:2（成功）。必须跳过失败响应，只取 status 1/2 的成功响应。
  const entry = journal.find(e => {
    if (e.status < 200 || e.status >= 300) return false;
    let parsed;
    try {
      parsed = JSON.parse(String(e.responseText));
    } catch {
      return false;
    }
    return (parsed.status === 1 || parsed.status === 2)
      && typeof parsed?.data === 'string' && parsed.data.length > 0;
  });
  if (!entry) {
    if (vendorRejected) {
      throw vendorOutcome.reason;
    }
    throw new Error('c1 request did not complete');
  }

  let response;
  try {
    response = validateC1Response(JSON.parse(entry.responseText));
  } catch (error) {
    if (vendorRejected) {
      throw vendorOutcome.reason;
    }
    throw error;
  }

  if (vendorRejected) {
    if (vendorOutcome.reason?.message !== 'status2: 1') {
      throw vendorOutcome.reason;
    }
  }
  const data = response.data;

  return {
    response,
    data,
    context,
    request: {
      method: entry.method,
      url: entry.url,
      status: entry.status
    },
    cookieJar  // 供上层合并到全流程共享 jar
  };
}

async function generateAc({
  context,
  constID,
  token,
  simulateEvents,
  sendTempPayload,
  expectedAcVersion,
  dwellMs,
  preMouseCount = 0,
  referrer,
  mdCount = 0,
  kdCount = 0,
  tmOffsetMs
}) {
  loadGlobalBundle(context, path.join(vendorDirectory, 'gs.js'));
  if (typeof context._dx?.UA?.init !== 'function') {
    throw new Error('vendor UA.init is unavailable');
  }
  // document.referrer：真实浏览器非空（用户从上游页面跳转进来），VM 默认空串。
  // getLO（tag4）采集 location.href + document.referrer，referrer 空 → tag4 仅 29B
  // （真实 209B）。init 内部 start→getLO 已采集，须在 init 前设置。
  if (referrer !== undefined && context.document) {
    context.document.referrer = referrer;
  }
  // 真实页面 basic-captcha-js.js 调用: _dx.UA.init({token: i.sid}) 只传 token，不传 constID
  const uaInstance = context._dx.UA.init({
    token: token || ''
  });

  // 时间基准：recordSA 编码 `Date.now()-tm`（tm=init 时刻）。
  // 决定性发现（2026-08-02）：真实浏览器从页面加载到拖动经过约 663.5 秒（11 分钟），
  // 首个 recordSA 前缀 `f1 fb d9`；VM 若 dwell 5s 则 c≈5s → 前缀 `f1 f1 e2`，被服务器判程序化。
  // Ft 与 VM 完全同参（遍历 c 精确命中 f1 fb），差异纯在 c。
  // 修复：不空等，而是把 tm 提前（模拟 UA 在页面加载时 init，实际拖动在当前时刻）。
  // tmOffsetMs 每轮随机（5-70 分钟覆盖真实分布，含昨天的 67 分钟案例），0 关闭（诊断用）。
  const tmOffset = tmOffsetMs === 0 ? 0 : (tmOffsetMs || (5 + Math.floor(Math.random() * 65)) * 60 * 1000);
  if (tmOffset > 0) {
    uaInstance.tm = Date.now() - tmOffset;
  }
  // 保留短 dwell（可选，模拟页面内观察），与 tm 提前正交。
  const dwell = dwellMs === 0 ? 0 : (dwellMs || 3000 + Math.floor(Math.random() * 5000));
  if (dwell > 0) await new Promise(resolve => setTimeout(resolve, dwell));

  // 真实 basic-captcha-js.js 调用链（从 greenseer decoded 源码 + 网络抓包确认）：
  //   UA.init({token}) → init 内部自动调 start() 采集环境 → bindDomEvents 注册事件
  //   → 用户拖动（mm/md/kd 由事件采集器累积）→ dragEnd 触发 sendSA → sendTemp → getUA
  //
  // 关键对齐（P0，2026-08-02）：
  //   - init 内部已调 start()，勿重复（重复会重置采集状态）
  //   - process 是纯数据处理工具（flatten+encrypt），非生命周期 API，勿显式调用
  //   - bindDomEvents 仍需显式调用：注册 document 级事件供轨迹 dispatch 触发
  //
  // 之前错误：显式 start() + process() 导致重复采集和空参数加密垃圾数据进入 _ua
  if (typeof uaInstance.bindDomEvents === 'function') uaInstance.bindDomEvents();
  // Flush queued microtasks so timer/observer-driven collectors run.
  await new Promise(resolve => setImmediate(resolve));

  if (simulateEvents) {
    const { dispatchPreMouse, dispatchPressPair, dispatchKeydown } = require('./trajectory');
    // 拖动前鼠标历史：模拟真实浏览器按下滑块前的页面活动（让 mmInterval 节流累积，mm→20）。
    if (preMouseCount > 0) {
      await dispatchPreMouse(context.document, { count: preMouseCount, totalMs: Math.max(2500, preMouseCount * 4) });
    }
    // 额外 mousedown/mouseup 对（真实用户多次按下定位，md=3）与 keydown（kd=2）。
    // 离线验证：md=3、kd=2 与真实浏览器完全一致。
    if (mdCount > 0) dispatchPressPair(context.document, mdCount);
    if (kdCount > 0) dispatchKeydown(context.document, kdCount);
    await simulateEvents(context);
  }
  if (typeof uaInstance.sendSA === 'function') uaInstance.sendSA();
  if (sendTempPayload !== undefined && typeof uaInstance.sendTemp === 'function') {
    uaInstance.sendTemp(sendTempPayload);
  }
  if (typeof uaInstance.getUA !== 'function') {
    throw new Error('vendor UA.getUA is unavailable');
  }
  const ac = uaInstance.getUA();
  return {
    ac,
    acInfo: validateAc(ac, expectedAcVersion),
    // 附加(2026-08-04):暴露 UA 实例 counters 供 AC 结构差分采样;不改任何采集行为。
    counters: uaInstance.counters ? { ...uaInstance.counters } : {}
  };
}

async function runDx({
  appId,
  uaToken,
  server,
  profile,
  timeout,
  transport
}) {
  const { response, data, context, request } = await runC1({
    appId,
    server,
    profile,
    timeout,
    transport
  });
  const { ac, acInfo } = await generateAc({
    context,
    constID: data,
    token: uaToken || ''
  });

  return { response, data, ac, acInfo, request };
}

module.exports = {
  settleThenable,
  createVendorContext,
  createCookiejarTransport,
  runC1,
  generateAc,
  runDx
};
