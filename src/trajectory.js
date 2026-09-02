// 基于真实浏览器轨迹模板的轨迹生成（data/real-trajectory.json 归一化）
const fs = require('node:fs');
const path = require('node:path');
const { performance: nodePerformance } = require('node:perf_hooks');

let REAL_TEMPLATE = null;
function loadRealTemplate() {
  if (REAL_TEMPLATE) return REAL_TEMPLATE;
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'real-trajectory.json'), 'utf8'));
  const pts = raw.points;
  const x0 = pts[0].x, t0 = pts[0].t;
  const dx = pts[pts.length - 1].x - x0;
  const dt = pts[pts.length - 1].t - t0;
  // 归一化：位移 0→1，时间 0→1。y 保留原始页面坐标（滑块在页面固定位置 ~609/610）。
  // 注意：y 与 targetY（缺口垂直位置，270 域）完全解耦——轨迹 y 是页面绝对坐标，
  // 真实浏览器里滑块组件在页面 y≈609 处，不随缺口 y 移动。之前错误地叠加了 targetY。
  REAL_TEMPLATE = pts.map(p => ({
    u: (p.x - x0) / dx,           // 相对位移 0..1
    v: (p.t - t0) / dt,           // 相对时间 0..1
    y: p.y,                       // 页面绝对坐标（滑块固定位置）
    type: p.type
  }));
  return REAL_TEMPLATE;
}

// 真实浏览器拖动段（从 123.txt 提取固化）：205 move + down + up，总时长 1783ms。
// 相比 real-trajectory.json 模板（154 点），真实点数更多、时间跨度更长（首次 move 24ms、
// 活跃段 1318ms、松手前停顿 441ms）——更贴近真实拖动。x 用相对位移 dx，dispatch 时按 targetX 缩放。
let REAL_DRAG_POINTS = null;
function loadRealDragPoints() {
  if (REAL_DRAG_POINTS) return REAL_DRAG_POINTS;
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'real-drag-points.json'), 'utf8'));
  const dx = raw.points[raw.points.length - 1].dx - raw.points[0].dx || 1;
  REAL_DRAG_POINTS = raw.points.map(p => ({
    type: p.type,
    u: (p.dx - raw.points[0].dx) / dx,  // 相对位移 0..1
    v: p.t / raw.durationMs,            // 相对时间 0..1
    y: p.pageY,                         // 页面绝对坐标
    buttons: p.buttons
  }));
  return REAL_DRAG_POINTS;
}

function rand(min, max) {
  return min + Math.random() * (max - min);
}

/**
 * 生成模拟真人拖动轨迹，基于真实浏览器轨迹的归一化位移-时间曲线。
 * 返回 [{x, y, t, type}]，t 为相对毫秒（从 0 起），x 为相对位移（从 0 起）。
 * opts.jitter（默认 0）：位移曲线随机扰动幅度，0 关闭（完全确定性，直接用真实模板形状）。
 * 用真实模板不扰动（用户确认）：轨迹形状完全来自 real-trajectory.json，最贴近真人。
 */
function generateTrajectory(targetX, targetY, opts = {}) {
  // 真实点模式：用 123.txt 真实拖动段（205 move + 1783ms）的位移-时间曲线形状。
  // 关键：点数随 targetX 缩放（真实浏览器约 1.27 点/px，如 x=118 → ~150 点），
  // 使 AC 轨迹点数接近真实成功轮（1990B ac ≈ 150 点），而非固定 205 点。
  if (opts.source === 'real-drag') {
    const template = loadRealDragPoints();
    // 成功轮（2026-08-03 dxdump）实测：41 点/98px/4190ms → 23.4 px/s 慢速拖动。
    // 1783ms（快拖）被判异常（245 px/s 机器速度）。对齐成功轮：约 4200ms。
    // 2026-08-04 新成功轮（123uanair.com HAR 实测）：x=94 提交 → ac 解码 1611 字节，
    // 其中 tag17 轨迹 ~163 点/94px ≈ 1.7 点/px（远密于旧 0.22）。
    // 旧 0.22 点/px（21 点）太稀疏 → 服务器判机器 → 4012。
    // 对齐新成功轮：~1.7 点/px（点距 ~0.6px），配合 4200ms 慢速。
    // 2026-08-04 改回 4200：加速实验(2000ms)速度翻倍(62.5px/s)偏离"23.4px/s 慢速成功"档案；
    // 加速实验仍可用 DX_TRAJECTORY_MS 覆盖(2.js 传 trajectoryMs)。
    const totalMs = opts.totalMs || 4200;
    // 目标点数 = targetX × 1.7（2026-08-04 新成功轮实测：163 点 / 94px ≈ 1.73）
    const targetCount = Math.max(15, Math.round(targetX * 1.7));
    const step = (template.length - 1) / Math.max(1, targetCount - 1);
    // 真实轨迹绝对起点（2026-08-03 AdsPower 断点实测）：x 从 422 起（画布 386 + 36 偏移）。
    // 用绝对坐标语义（dispatch absolute 模式），与 real-sa 一致——相对坐标（sliderLeft+offsetX）
    // 与真实页面滑块位置不符是 4011 HIGH_RISK 根因。
    const startX = opts.realStartX ?? 422;
    // 真实 SDK（basic-captcha-js v1.3.41）源码：V = Math.round(t.dx) + 6（提交 x = 轨迹位移 + 6）
    // → 轨迹位移 = 提交 x - 6。旧值 -7 基于 dxdump 推断，与 live SDK 源码差 1px。
    // 2026-08-03 反混淆 basic-captcha-js 确认：Math.round(t.dx) + 6（源码级证据）
    const dragDist = Math.max(1, targetX - 6);
    // 2026-08-04 轨迹形状 jitter：默认开启，每轮位移曲线随机扰动(±jitter 比例)，
    // 打破"均匀位移+固定模板"的可学习模式（服务器收集多 ac 可发现固定形状）。
    // 保持单调递增 + 首尾精确对齐（起点 startX、终点 startX+dragDist）。
    const jitter = opts.jitter ?? 0.1; // 默认 ±10% 扰动
    // 预生成扰动：每个中间点相对均匀位置 ±jitter 随机偏移（累积不超 dragDist）
    const offsets = [];
    let acc = 0;
    for (let i = 0; i < targetCount; i++) {
      if (i === 0 || i === targetCount - 1) {
        offsets.push(0);
      } else {
        // 扰动增量，累积后保证单调（用归一化位移再累加）
        const base = i / (targetCount - 1);
        const next = (i + 1) / (targetCount - 1);
        const d = (next - base) * (1 + (Math.random() * 2 - 1) * jitter);
        acc += d;
        offsets.push(acc);
      }
    }
    // 归一化扰动到 [0,1]，保证终点精确 = dragDist
    const maxOff = offsets[offsets.length - 1] || 1;
    const points = [];
    for (let i = 0; i < targetCount; i++) {
      const ti = Math.min(template.length - 1, Math.round(i * step));
      const p = template[ti];
      const u = i === 0 ? 0 : (i === targetCount - 1 ? 1 : offsets[i] / maxOff);
      points.push({
        type: i === 0 ? 'mousedown' : (i === targetCount - 1 ? 'mouseup' : p.type),
        x: startX + Math.round(u * dragDist),
        y: p.y,
        // 关键：保留模板的时间比例 v（非均匀变速），而非均匀线性——
        // 真实轨迹有快速拖动+中段微停+松手前停顿（大间隔 221/333/441ms），
        // 均匀时间戳是机器特征，服务端可识别。
        t: Math.round(p.v * totalMs),
        buttons: i === targetCount - 1 ? 0 : 1
      });
    }
    // 时间戳单调递增（模板采样可能重复），且末点对齐 totalMs
    let prev = -1;
    for (const pt of points) {
      if (pt.t <= prev) pt.t = prev + 1;
      prev = pt.t;
    }
    const last = points[points.length - 1];
    last.x = startX + dragDist;
    last.type = 'mouseup';
    last.t = totalMs;
    return points;
  }

  const template = loadRealTemplate();
  const points = [];
  // 起点页面前缀：滑块在页面的绝对位置（真实 ~399）。
  // y 直接用模板原始页面坐标（~609/610），与 targetY 解耦——见 loadRealTemplate 注释。
  const pageOriginX = opts.originX || 399;

  // 位移曲线：默认不扰动（jitter=0），直接用模板归一化位移。仅当显式 jitter>0 才扰动。
  let us = template.map(p => p.u);
  const jitter = opts.jitter ?? 0;
  if (jitter !== 0) {
    let acc = 0;
    const perturbed = [];
    for (let i = 0; i < us.length; i++) {
      const du = i === 0 ? us[0] : us[i] - us[i - 1];
      const d = Math.max(0, du * (1 + (Math.random() - 0.5) * 0.08 * jitter));
      acc += d;
      perturbed.push(acc);
    }
    us = acc > 0 ? perturbed.map(v => v / acc) : us;
  }

  // 时间戳严格单调递增（真实浏览器轨迹不倒退；倒退是机器人特征）。默认也用模板原始时间。
  const totalMs = opts.totalMs || 960;
  const tJitter = jitter !== 0;
  let tAcc = 0;
  let tPrev = 0;
  for (let i = 0; i < template.length; i++) {
    const p = template[i];
    const x = Math.round(us[i] * targetX);
    const y = p.y; // 页面绝对坐标（滑块固定位置 ~609/610），不叠加 targetY
    let t;
    if (tJitter) {
      // 扰动：相邻增量 ±10% 随机缩放并累加，保证单调不减
      const dtTemplate = template.map((pp, ii) => ii === 0 ? pp.v : pp.v - template[ii - 1].v);
      const dt = Math.max(0, dtTemplate[i] * totalMs * rand(0.9, 1.1));
      tAcc += dt;
      if (i > 0 && tAcc <= tPrev) tAcc = tPrev + 1;
      tPrev = tAcc;
      t = Math.round(tAcc);
    } else {
      // 不扰动：直接用模板原始相对时间
      t = Math.round(p.v * totalMs);
    }
    points.push({ x, y, t, type: p.type });
  }
  // 确保终点精确落在 targetX
  const last = points[points.length - 1];
  last.x = targetX;
  return points;
}

async function dispatchTrajectory(document, points, opts = {}) {
  // 调度时钟:Node 单调时钟(不依赖 VM 时钟,注入冻结 now 不会卡死)
  const schedulerNow = nodePerformance.now.bind(nodePerformance);
  // 事件 timeStamp 时钟:仍用 VM 时钟(ac 内时间戳必须与 tm/记录一致)
  const eventNow = document.defaultView?.performance?.now?.bind(document.defaultView.performance) || schedulerNow;
  const start = schedulerNow();
  // 兼容旧调用：第三个参数传数字 delay 时转成对象
  if (typeof opts === 'number') opts = { delay: opts };
  // 几何参数（真实浏览器语义，参考 scratch/hook-mousemove 抓包 123.txt）：
  // - sliderLeft/sliderTop：滑块按钮 IMG 在页面的绝对左上角（真实 ~218/523）
  // - pressOffsetX/pressOffsetY：按下时鼠标在按钮内部的位置（真实 ~30/~20，恒定）
  // 服务器校验的是相对语义（offset 恒定、位移、时长），绝对布局不校验。
  const sliderLeft = opts.sliderLeft ?? 504;
  const sliderTop = opts.sliderTop ?? 488;
  const pressOffsetX = opts.pressOffsetX ?? (25 + Math.random() * 10); // 25~35
  const pressOffsetY = opts.pressOffsetY ?? (15 + Math.random() * 10); // 15~25
  const targetX = points.length ? points[points.length - 1].x : 0;
  const delay = opts.delay ?? 5;

  // 真实滑块是 IMG 元素（不是 DIV），mousedown 落在 hover 变体、move/up 落在 focus 变体
  const makeTarget = cls => {
    const img = document.createElement('img');
    img.className = cls;
    img.id = cls + '_1';
    img.offsetWidth = 67;
    img.offsetHeight = 67;
    img.getBoundingClientRect = () => ({ left: sliderLeft, top: sliderTop, width: 67, height: 67 });
    return img;
  };
  let targetHover = null;
  let targetFocus = null;
  try {
    targetHover = makeTarget('dx_captcha_basic_slider-img-hover');
    targetFocus = makeTarget('dx_captcha_basic_slider-img-focus');
  } catch { /* target 由 dispatchEvent 兜底 */ }

  let prevPageX = null;
  let prevPageY = null;
  // offsetX/offsetY 全程恒定 = 按下时鼠标在按钮内部的位置（真实 29~32/10~22）。
  // 关键：真实浏览器滑块按钮跟随鼠标移动，offsetX 恒定 → pageX 首末差 = 实际拖动距离。
  // 若逐点扰动 offsetX，则 AC 首末 pageX 差值 = targetX±1/±2，破坏与 TEMP/v1 的位移对账。
  const offsetX = Math.min(35, Math.max(25, pressOffsetX));
  const offsetY0 = Math.min(25, Math.max(10, pressOffsetY));
  for (const pt of points) {
    const targetMs = pt.t - (points[0] ? points[0].t : 0);
    // 时间调度：等够目标时间。用 Node 单调时钟(schedulerNow)，冻结 VM now 不卡死；
    // 带 stall 熔断：调度时钟若停滞(elapsed 不前进)超 1000 次则抛错，兜底防死循环。
    let lastElapsed = -1, stalled = 0;
    while (schedulerNow() - start < targetMs) {
      const elapsed = schedulerNow() - start;
      if (elapsed <= lastElapsed) { if (++stalled > 1000) throw new Error('trajectory-clock-stalled'); }
      else stalled = 0;
      lastElapsed = elapsed;
      const remaining = targetMs - (schedulerNow() - start);
      if (remaining <= 0) break;
      await new Promise(r => setTimeout(r, Math.min(delay, remaining)));
    }
    const now = eventNow();
    // absolute 模式：pt.x/pt.y 是页面绝对坐标（real-sa 轨迹），直接使用。
    // 否则：x 是相对位移，pageX = 按钮页面左 + 恒定 offsetX + 位移。
    const pageX = opts.absolute ? Math.round(pt.x) : Math.round(sliderLeft + offsetX + pt.x);
    const yJitter = Math.round((Math.random() - 0.5) * 6);
    const offsetY = Math.min(25, Math.max(10, offsetY0 + yJitter));
    const pageY = opts.absolute ? Math.round(pt.y) : Math.round(sliderTop + offsetY + yJitter);

    const movementX = prevPageX === null ? 0 : pageX - prevPageX;
    const movementY = prevPageY === null ? 0 : pageY - prevPageY;
    prevPageX = pageX;
    prevPageY = pageY;

    const target = pt.type === 'mousedown'
      ? (targetHover || undefined)
      : (targetFocus || undefined);
    const event = {
      type: pt.type,
      pageX, pageY,
      clientX: pageX, clientY: pageY,
      offsetX, offsetY,
      screenX: pageX, screenY: pageY,
      timeStamp: now,
      movementX, movementY,
      which: 1,
      button: 0,
      // 真实点轨迹带自定义 buttons（mousedown 前按下时 buttons=1，拖动中 1，松手 0）
      buttons: pt.buttons !== undefined ? pt.buttons : (pt.type === 'mouseup' ? 0 : 1),
      detail: pt.type === 'mousedown' ? 1 : 0,
      view: 'window',
      isTrusted: true,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    if (target) {
      try {
        Object.defineProperty(event, 'target', { value: target, configurable: true });
      } catch { /* target 由 dispatchEvent 兜底 */ }
    }
    document.dispatchEvent(event);
  }
}

/**
 * 拖动前鼠标历史：模拟真实浏览器用户在按下滑块前，已在页面上小幅移动鼠标。
 * 真实抓包（123.txt）在 mousedown 前有 ~288 个 mousemove（buttons=0，不触发拖动）。
 * 这些活动让 recordSA 的累计时间（Date.now()-tm）在拖动前就有非零累积，
 * 且 MMInterval 节流计数器开始递增 → mm 计数更接近真实（20 vs VM 的 4）。
 * opts: { count, sliderLeft, sliderTop, totalMs }
 */
async function dispatchPreMouse(document, opts = {}) {
  const count = opts.count ?? 30;
  const sliderLeft = opts.sliderLeft ?? 504;
  const sliderTop = opts.sliderTop ?? 488;
  const totalMs = opts.totalMs ?? 800; // 拖动前活动总时长（真实 ~1.6s）
  // 调度时钟：Node 单调时钟(不依赖 VM 时钟，注入冻结 now 不会卡死)
  const schedulerNow = nodePerformance.now.bind(nodePerformance);
  // 事件 timeStamp 时钟：仍用 VM 时钟(ac 内时间戳必须与 tm/记录一致)
  const eventNow = document.defaultView?.performance?.now?.bind(document.defaultView.performance) || schedulerNow;
  const start = schedulerNow();
  const target = document.createElement('img');
  target.className = 'dx_captcha_basic_slider-img-focus';
  let prevX = sliderLeft + 30, prevY = sliderTop + 20;
  for (let i = 0; i < count; i++) {
    const targetMs = Math.round(totalMs * i / count);
    // 调度用 Node 单调时钟 + stall 熔断(同 dispatchTrajectory)
    let lastElapsed = -1, stalled = 0;
    while (schedulerNow() - start < targetMs) {
      const elapsed = schedulerNow() - start;
      if (elapsed <= lastElapsed) { if (++stalled > 1000) throw new Error('trajectory-clock-stalled'); }
      else stalled = 0;
      lastElapsed = elapsed;
      const remaining = targetMs - (schedulerNow() - start);
      if (remaining <= 0) break;
      await new Promise(r => setTimeout(r, Math.min(5, remaining)));
    }
    // 小幅随机游走（±3px），buttons=0，不按下
    const pageX = Math.round(prevX + (Math.random() - 0.5) * 6);
    const pageY = Math.round(prevY + (Math.random() - 0.5) * 6);
    const movementX = pageX - prevX;
    const movementY = pageY - prevY;
    prevX = pageX; prevY = pageY;
    const event = {
      type: 'mousemove',
      pageX, pageY,
      clientX: pageX, clientY: pageY,
      offsetX: 30, offsetY: 20,
      screenX: pageX, screenY: pageY,
      timeStamp: eventNow(),
      movementX, movementY,
      which: 1, button: 0, buttons: 0,
      detail: 0, view: 'window', isTrusted: true,
      bubbles: true, cancelable: true, composed: true
    };
    try { Object.defineProperty(event, 'target', { value: target, configurable: true }); } catch {}
    document.dispatchEvent(event);
  }
}

// 额外 mousedown/mouseup 对（模拟真实用户多次按下定位滑块）——真实浏览器 md=3
function dispatchPressPair(document, count, opts = {}) {
  const sliderLeft = opts.sliderLeft ?? 504;
  const sliderTop = opts.sliderTop ?? 488;
  const pressOffsetX = opts.pressOffsetX ?? 30;
  const pressOffsetY = opts.pressOffsetY ?? 20;
  const hover = document.createElement('img');
  hover.className = 'dx_captcha_basic_slider-img-hover';
  const focus = document.createElement('img');
  focus.className = 'dx_captcha_basic_slider-img-focus';
  for (let i = 0; i < count; i++) {
    const x = sliderLeft + pressOffsetX + Math.round((Math.random() - 0.5) * 6);
    const y = sliderTop + pressOffsetY + Math.round((Math.random() - 0.5) * 6);
    for (const [type, target, buttons, detail] of [
      ['mousedown', hover, 1, 1],
      ['mouseup', focus, 0, 1]
    ]) {
      const e = {
        type, pageX: x, pageY: y, clientX: x, clientY: y,
        offsetX: pressOffsetX, offsetY: pressOffsetY, movementX: 0, movementY: 0,
        which: 1, button: 0, buttons, detail,
        view: 'window', isTrusted: true, bubbles: true, cancelable: true, composed: true
      };
      try { Object.defineProperty(e, 'target', { value: target, configurable: true }); } catch {}
      document.dispatchEvent(e);
    }
  }
}

// keydown（模拟真实用户键盘操作）——真实浏览器 kd=2（方向键/回车）
function dispatchKeydown(document, count, opts = {}) {
  const focus = document.createElement('img');
  focus.className = 'dx_captcha_basic_slider-img-focus';
  const keys = [39, 37, 13]; // ArrowRight, ArrowLeft, Enter
  for (let i = 0; i < count; i++) {
    const keyCode = keys[i % keys.length];
    const e = {
      type: 'keydown',
      keyCode,
      which: keyCode,
      key: keyCode === 13 ? 'Enter' : keyCode === 39 ? 'ArrowRight' : 'ArrowLeft',
      repeat: false,
      view: 'window', isTrusted: true, bubbles: true, cancelable: true
    };
    try { Object.defineProperty(e, 'target', { value: focus, configurable: true }); } catch {}
    document.dispatchEvent(e);
  }
}

module.exports = { generateTrajectory, dispatchTrajectory, dispatchPreMouse, dispatchPressPair, dispatchKeydown };
