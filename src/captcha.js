function generateAid(now = Date.now) {
  const ts = now();
  const random = String(Math.floor(Math.random() * 10000000)).padStart(7, '0');
  const seq = Math.floor(Math.random() * 10) + 1;
  return 'dx-' + ts + '-' + random + '-' + seq;
}

async function loadCaptcha({ ak, c, jsv, t, cid, captchaHost, transport = fetch, timeout = 10000, w = 270, h = 150 }) {
  if (!captchaHost) throw new TypeError('captchaHost is required (四川航空)');
  const aid = generateAid();
  // 参数顺序对齐真实浏览器（HAR 实测）：...lf=0&tpc=ab_1_1&t=<vid>&_r=<random>
  // tpc = 流量渠道标识（真实 ab_1_1，VM 之前空）
  const params = new URLSearchParams({
    w: String(w),
    h: String(h),
    s: '50',
    ak,
    c,
    jsv,
    aid,
    wp: '1',
    de: '0',
    uid: '',
    lf: '0',
    tpc: 'ab_1_1'
  });
  if (t) params.set('t', t);
  if (cid) params.set('cid', cid);
  params.set('_r', String(Math.random()));
  const url = captchaHost + '/api/a?' + params.toString();
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await transport(url, { signal: controller.signal });
    if (resp.status < 200 || resp.status >= 300) throw new Error('captcha HTTP ' + resp.status);
    const body = await resp.json();
    if (!body || typeof body !== 'object') throw new TypeError('captcha not JSON');
    if (typeof body.sid !== 'string' || !body.sid) throw new Error('missing sid');
    if (typeof body.p1 !== 'string' || typeof body.p2 !== 'string') throw new Error('missing p1/p2');
    const y = Number(body.y);
    if (!Number.isFinite(y)) throw new Error('invalid y');
    return { sid: body.sid, aid: body.aid || aid, p1: body.p1, p2: body.p2, y, constId: body.const_id || undefined, cid: body.cid || undefined, o: body.o || undefined };
  } finally { clearTimeout(timer); }
}

async function submitV1({ sid, aid, x, y, ac, c, ak, jsv, uid = '', captchaHost, transport = fetch, timeout = 10000, w, h }) {
  if (!captchaHost) throw new TypeError('captchaHost is required (四川航空)');
  // 真实浏览器 v1 body 字段序（ac 在前，对齐 CDP 抓包）
  const p = new URLSearchParams();
  p.set('ac', ac);           p.set('ak', ak);
  p.set('c', c);             p.set('uid', uid || '');
  p.set('jsv', jsv || '');   p.set('sid', sid);
  p.set('aid', aid);         p.set('x', String(x));
  p.set('y', String(y));
  const body = p;
  if (w !== undefined) body.set('w', String(w));
  if (h !== undefined) body.set('h', String(h));
  const url = captchaHost + '/api/v1';
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    // accept: */* 对齐 AdsPower 真实 v1 请求（抓包确认）
    const resp = await transport(url, { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': '*/*' }, body: body.toString(), signal: controller.signal });
    if (resp.status < 200 || resp.status >= 300) throw new Error('v1 HTTP ' + resp.status);
    const result = await resp.json();
    return {
      success: Boolean(result.success),
      token: result.token || undefined,
      code: result.code ?? null,
      msg: result.msg ?? null,
      retry: typeof result.retry === 'number' ? result.retry : undefined,
      tp: result.tp ?? null,
      sv: result.sv ?? null,
      result: result.result ?? null
    };
  } finally { clearTimeout(timer); }
}

module.exports = { loadCaptcha, submitV1 };
