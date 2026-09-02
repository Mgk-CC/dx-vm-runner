const { createCookiejarTransport, runC1, generateAc } = require('./run');
const { loadCaptcha, submitV1 } = require('./captcha');
const { processCaptchaImages } = require('./image');
const { generateTrajectory, dispatchTrajectory } = require('./trajectory');
const { callFlightSearch } = require('./callweb');
const { randomizeProfile } = require('./fingerprint');

function buildSendTempPayload(x, y) {
  return `x=${x}&y=${y}`;
}

// 给 transport 补浏览器头（Referer/Origin/UA/sec-ch-ua），让图片直取（非 XHR，无 autoReferer）
// 也能通过 rcs 的来源校验。init.headers 里的同名头优先，不覆盖。
// sec-ch-ua 是 Chrome Client Hints，真实浏览器请求必带；缺失会被服务器判非真实浏览器（4011 HIGH_RISK）。
function addBrowserHeaders(transport, profile) {
  // 真实顶象 SDK v1 请求 Referer = 站点根路径（AdsPower 抓包确认），非页面完整 URL
  const refererUrl = profile?.location?.origin ? new URL(profile.location.href).origin + '/' : profile?.location?.href;
  let origin = null;
  try {
    origin = new URL(refererUrl).origin;
  } catch {
    origin = null;
  }
  const ua = profile?.navigator?.userAgent;
  const chromeVer = /Chrome\/(\d+)/.exec(ua || '');
  const version = chromeVer ? chromeVer[1] : '149';
  const secChUa = `"Google Chrome";v="${version}", "Chromium";v="${version}", "Not)A;Brand";v="24"`;
  const platform = profile?.navigator?.platform === 'MacIntel' ? '"macOS"' : '"Windows"';

  async function wrapped(url, init = {}) {
    const requestInit = { ...init };
    const headers = { ...(init.headers || {}) };
    const has = name => Object.keys(headers).some(k => k.toLowerCase() === name);
    if (refererUrl && !has('referer')) headers.Referer = refererUrl;
    if (origin && !has('origin')) headers.Origin = origin;
    if (ua && !has('user-agent')) headers['User-Agent'] = ua;
    if (!has('sec-ch-ua')) headers['sec-ch-ua'] = secChUa;
    if (!has('sec-ch-ua-mobile')) headers['sec-ch-ua-mobile'] = '?0';
    if (!has('sec-ch-ua-platform')) headers['sec-ch-ua-platform'] = platform;
    requestInit.headers = headers;
    return transport(url, requestInit);
  }
  return wrapped;
}

async function runFullFlow({
  appId,
  ak = appId,
  jsv,
  t,
  cid,
  captchaHost,
  imageHost,
  server,
  profile,
  timeout,
  transport = fetch,
  w,
  h,
  acVersion,
  dwellMs,
  preMouseCount,
  referrer,
  trajectorySource,
  trajectoryMs,
  mdCount,
  kdCount,
  tmOffsetMs
}) {
  if (typeof jsv !== 'string' || jsv.length === 0) {
    throw new TypeError('jsv is required for the full v1 flow');
  }

  // 指纹模式(2026-08-04):
  //   DX_RANDOM_FP=0  固定指纹(单轮诊断)
  //   DX_RANDOM_FP=2  不随机、用传入 profile 原样(2.js 按 IP 外部生成指纹,同 IP 固定、换 IP 换)
  //   缺省/其它       每轮随机(旧行为)
  const fpMode = Number(process.env.DX_RANDOM_FP || 1);
  if (fpMode !== 2) {
    profile = randomizeProfile(profile, { random: fpMode !== 0 });
  }
  // fpMode===2 时:profile 保持调用方传入的(已按 IP 生成),不做任何改动

  // 统一几何：/api/a 请求、x/y 映射、轨迹和 v1 使用同一组 effectiveW/effectiveH（四川航空 270×150）。
  const effectiveW = Number(w) > 0 ? Number(w) : 270;
  const effectiveH = Number(h) > 0 ? Number(h) : 150;

  // 整个 flow 共享一个 cookie jar（真实浏览器对同域全请求公用 cookie 存储）。
  let sharedTransport = createCookiejarTransport(addBrowserHeaders(transport, profile));

  // c1 -> constID data (also the dynamic credential `c`).
  // runC1 内部 createVendorContext 会包另一层 jar——c1 的 Set-Cookie 卷在内层，
  // 必须合并回外层 shared jar，captcha 请求才能带 c1 阶段的 cookie。
  const { response, data, context, cookieJar: c1Jar } = await runC1({
    appId,
    server,
    profile,
    timeout,
    transport: sharedTransport
  });
  // 将 c1 阶段的 cookie 合并到共享 jar。
  // 2026-08-04:jar 已按 host 过滤(key = `${host}|${name}`)。c1 的 host 是
  // rcs.sichuanair.com——旧 key 形态(name,无 host 前缀)统一补 host,否则过滤失效。
  if (c1Jar && sharedTransport.jar) {
    for (const [k, v] of c1Jar) {
      sharedTransport.jar.set(k.includes('|') ? k : 'rcs.sichuanair.com|' + k, v);
    }
  }

  // t = _dx_captcha_vid（设备验证 ID）。2026-08-04 实测 vid 复用是减分项（成功率 20% → ~80%）：
  // 主流程 2.js 恒传 t:null（每轮纯新设备，a 接口不带 t 参数），不再持久化 vid。
  const vid = t && t !== '' ? t : null;
  // 风控闭环（2026-08-04）：c1 拿到 const_id 后，先调 callWeb(validType=0, constId)
  // 建立会话风控状态（真实浏览器 222.har 证实：callWeb → RISK_VALID_FAIL → 弹验证码）。
  // VM 之前跳过此步 → 服务器不认会话 → 不累计失败 → 不升级 → 4012。
  // 仅诊断日志，不因失败中断（callWeb 拒绝是预期，表示需要验证码）。
  try {
    const riskResp = await callFlightSearch({
      validType: 0,
      constId: data,
      extCurrentUrl: profile.location?.href,
      transport: sharedTransport,
      timeout,
      profile
    });
    process.stderr.write(`[callweb] validType=0 → status=${riskResp?.body?.status || '?'} keyCode=${riskResp?.body?.message?.keyCode || '?'}\n`);
  } catch (e) {
    // 2026-08-04:网络类失败(TLS 断开/socket/超时) = 该 IP 不稳/被掐 → 抛给上层(2.js)换 IP。
    // 风控拒绝(RISK_VALID_FAIL 等)是预期,不抛;仅网络错误抛。
    const msg = String(e && e.message || e);
    if (/socket|tls|ssl|handshake|timeout|ECONNRESET|UND_ERR/i.test(msg)) {
      const err = new Error('[callweb-net] ' + msg);
      err.callwebNet = true;
      throw err;
    }
    process.stderr.write(`[callweb] 调用失败: ${msg}\n`);
  }
  const captcha = await loadCaptcha({
    ak,
    c: data,
    jsv,
    t: vid || undefined,
    cid,
    captchaHost,
    transport: sharedTransport,
    timeout,
    w: effectiveW,
    h: effectiveH
  });

  const image = await processCaptchaImages({
    p1: captcha.p1,
    p2: captcha.p2,
    transport: sharedTransport,
    imageHost,
    key: captcha.o,
    renderedW: effectiveW,
    yTest: captcha.y !== undefined ? Math.round(captcha.y * 200 / effectiveH) : undefined
  });
  const y = captcha.y;
  const x = image.x;
  // 校验 xSubmit：要求有限且合法（禁止 -1 等异常坐标进入轨迹/AC/v1）。
  // wouldReject 只作诊断，不拦截坐标——正确候选必须能提交到 v1 由服务器判定。
  if (!Number.isFinite(x) || x < 0 || x > effectiveW) {
    throw new Error('gap-invalid-x x=' + x + ' raw=' + (image.xImage ?? '?') + ' (非法坐标，中止)');
  }

  // 默认 real-drag：归一化真实曲线按 targetX=xSubmit 缩放，轨迹位移 = 提交 x。
  const src = trajectorySource || 'real-drag';
  // trajectoryMs 可选：控制轨迹总时长(ms)。默认 4200(对齐真实慢速拖动 23px/s)。
  // 加速实验用 DX_TRAJECTORY_MS 调(如 2000=2秒)。注意:太快可能像机器,成功率可能降。
  const trajectory = generateTrajectory(x, y, { source: src, totalMs: trajectoryMs });
  // 附加(2026-08-04):counters 透传供样本采集(任务 4);纯附加,不改行为。
  const { ac, acInfo, counters } = await generateAc({
    context,
    constID: data,
    token: captcha.sid,
    // real-drag 也用 absolute（轨迹 x 已是页面绝对坐标，见 generateTrajectory real-drag 分支）
    simulateEvents: ctx => dispatchTrajectory(ctx.document, trajectory, { absolute: true }),
    sendTempPayload: buildSendTempPayload(x, y),
    expectedAcVersion: acVersion,
    dwellMs,
    preMouseCount,
    referrer,
    mdCount: mdCount ?? 3,
    kdCount: kdCount ?? 2,
    tmOffsetMs
  });
  // 诊断（临时）：轨迹点数 + ac 长度
  process.stderr.write(`[debug] x=${x} y=${y} 轨迹点数=${trajectory.length} acBytes=${Buffer.from(ac.slice(5), 'base64').length}\n`);

  const v1 = await submitV1({
    sid: captcha.sid,
    aid: captcha.aid,
    x,
    y,
    ac,
    c: captcha.constId || data,
    ak,
    jsv,
    captchaHost,
    transport: sharedTransport,
    timeout
  });

  // callWeb(1) 放行：v1 成功就放行(修复 2026-08-04 回归:原条件曾把放行也禁了)
  if (v1.success && v1.token) {
    // 风控闭环第 2 步：callWeb(validType=1, token="<token>:<constId>") → 放行返回航班
    // （真实浏览器 123uanair.com 证实：token 格式 = "<顶象token>:<const_id>"）
    try {
      const tokenPayload = `${v1.token}:${captcha.constId || data}`;
      const passResp = await callFlightSearch({
        validType: 1,
        token: tokenPayload,
        extCurrentUrl: profile.location?.href,
        transport: sharedTransport,
        timeout,
        profile
      });
      // status 在 head.status(callWeb 响应结构 {body, head:{status}}),不在 body.status——旧打印永远 '?'
      const headStatus = passResp?.head?.status || passResp?.body?.status;
      const headKey = passResp?.head?.keyCode || passResp?.body?.message?.keyCode;
      process.stderr.write(`[callweb] validType=1 → status=${headStatus || '?'} keyCode=${headKey || '?'}\n`);
    } catch (e) {
      process.stderr.write(`[callweb] validType=1 调用失败: ${e.message}\n`);
    }
  }

  return { response, data, captcha, image, ac, acInfo, counters, v1, x };
}

module.exports = { runFullFlow, buildSendTempPayload, addBrowserHeaders };
