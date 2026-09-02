const { createCanvas, loadImage } = require('@napi-rs/canvas');

const SLICE_WIDTH = 12;

function decodePermutation(filename, N = 32) {
  const result = new Array(N);
  const used = new Set();
  for (let i = 0; i < N; i++) {
    const code = i < filename.length ? filename.charCodeAt(i) : 0;
    let val = (code ^ 0x20) % N;
    while (used.has(val)) val = (val + 1) % N;
    result[i] = val;
    used.add(val);
  }
  return result;
}

function restoreBackground(sourceCanvas, permutation, srcW = 400, srcH = 200) {
  const N = permutation.length;
  const dest = createCanvas(N * SLICE_WIDTH, srcH);
  const ctx = dest.getContext('2d');
  for (let i = 0; i < N; i++) {
    const srcCol = permutation[i];
    const srcX = srcCol * SLICE_WIDTH;
    if (srcX + SLICE_WIDTH > srcW) continue;
    const imgData = sourceCanvas.getContext('2d').getImageData(srcX, 0, SLICE_WIDTH, srcH);
    ctx.putImageData(imgData, i * SLICE_WIDTH, 0);
  }
  return dest;
}

function sobelEdgeGray(gray, w, h, thr) {
  // 灰度数组 Sobel 幅值 -> 边缘掩码（1=边缘）
  const out = new Uint8Array(w * h);
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const tl = gray[i - w - 1], tm = gray[i - w], tr = gray[i - w + 1];
      const ml = gray[i - 1], mr = gray[i + 1];
      const bl = gray[i + w - 1], bm = gray[i + w], br = gray[i + w + 1];
      const gx = (tr + 2 * mr + br) - (tl + 2 * ml + bl);
      const gy = (bl + 2 * bm + br) - (tl + 2 * tm + tr);
      const mag = Math.abs(gx) + Math.abs(gy);
      if (mag > thr) out[i] = 1;
    }
  }
  return out;
}

function dilateMask(edge, w, h, iters) {
  const src = edge.slice();
  const dst = new Uint8Array(w * h);
  for (let k = 0; k < iters; k++) {
    dst.fill(0);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!src[y * w + x]) continue;
        for (let dy = -1; dy <= 1; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) continue;
          for (let dx = -1; dx <= 1; dx++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            dst[yy * w + xx] = 1;
          }
        }
      }
    }
    src.set(dst);
  }
  return dst;
}

function erodeMask(mask, w, h, iters) {
  const src = mask.slice();
  const dst = new Uint8Array(w * h);
  for (let k = 0; k < iters; k++) {
    dst.fill(0);
    for (let y = 1; y < h - 1; y++) {
      for (let x = 1; x < w - 1; x++) {
        const i = y * w + x;
        if (src[i] && src[i - 1] && src[i + 1] && src[i - w] && src[i + w]) dst[i] = 1;
      }
    }
    src.set(dst);
  }
  return dst;
}

// 稳健滑块蒙版提取（用户 6 点意见第 1 点）。
// 不只靠 alpha：排除纯黑背景（RGB 全暗但 alpha 不透明），取最大连通域 = 滑块主体。
// 返回 { mask, contour, interior, bbox }。bbox 为滑块主体包围框，后续可裁剪模板。
function extractSliderMask(sliderData, slW, slH, opts = {}) {
  const alphaThr = opts.alphaThr ?? 80;
  const bgThr = opts.bgThr ?? 40;
  const minArea = opts.minArea ?? 200;

  // alpha 初筛 + 排除纯黑背景
  const candidate = new Uint8Array(slW * slH);
  for (let y = 0; y < slH; y++) {
    for (let x = 0; x < slW; x++) {
      const i = (y * slW + x) * 4;
      const a = sliderData[i + 3];
      if (a <= alphaThr) continue;
      // 排除纯黑背景：RGB 都 <= bgThr（可能 alpha 不透明）
      const r = sliderData[i], g = sliderData[i + 1], b = sliderData[i + 2];
      if (r <= bgThr && g <= bgThr && b <= bgThr) continue;
      candidate[y * slW + x] = 1;
    }
  }

  // 连通域标记（BFS），找最大主体
  const label = new Int32Array(slW * slH).fill(-1);
  const areas = [];
  let cur = 0;
  const stack = [];
  for (let y = 0; y < slH; y++) {
    for (let x = 0; x < slW; x++) {
      const idx = y * slW + x;
      if (!candidate[idx] || label[idx] >= 0) continue;
      let area = 0;
      let minX = slW, maxX = -1, minY = slH, maxY = -1;
      stack.length = 0;
      stack.push(idx);
      label[idx] = cur;
      while (stack.length) {
        const p = stack.pop();
        area++;
        const px = p % slW, py = (p - px) / slW;
        if (px < minX) minX = px;
        if (px > maxX) maxX = px;
        if (py < minY) minY = py;
        if (py > maxY) maxY = py;
        // 4 邻域
        if (px > 0 && candidate[p - 1] && label[p - 1] < 0) { label[p - 1] = cur; stack.push(p - 1); }
        if (px < slW - 1 && candidate[p + 1] && label[p + 1] < 0) { label[p + 1] = cur; stack.push(p + 1); }
        if (py > 0 && candidate[p - slW] && label[p - slW] < 0) { label[p - slW] = cur; stack.push(p - slW); }
        if (py < slH - 1 && candidate[p + slW] && label[p + slW] < 0) { label[p + slW] = cur; stack.push(p + slW); }
      }
      areas.push({ area, minX, maxX, minY, maxY });
      cur++;
    }
  }

  // 最大主体
  let bestLabel = -1, bestArea = -1;
  for (let i = 0; i < areas.length; i++) {
    if (areas[i].area < minArea) continue;
    if (areas[i].area > bestArea) { bestArea = areas[i].area; bestLabel = i; }
  }
  if (bestLabel < 0) {
    // 兜底：直接用 candidate，并构建完整 contour/interior（不返回 null，避免下游崩溃）
    const mask = candidate;
    const contour = new Uint8Array(slW * slH);
    const interior = new Uint8Array(slW * slH);
    const ys0 = [], xs0 = [];
    for (let y = 0; y < slH; y++) for (let x = 0; x < slW; x++) {
      if (!mask[y * slW + x]) continue;
      ys0.push(y); xs0.push(x);
      const l = x > 0 && mask[y * slW + x - 1], r = x < slW - 1 && mask[y * slW + x + 1];
      const u = y > 0 && mask[(y - 1) * slW + x], d = y < slH - 1 && mask[(y + 1) * slW + x];
      if (l && r && u && d) interior[y * slW + x] = 1;
      else contour[y * slW + x] = 1;
    }
    const bbox = xs0.length ? [Math.min(...xs0), Math.min(...ys0), Math.max(...xs0), Math.max(...ys0)] : null;
    return { mask, contour, interior, bbox };
  }

  // 构建 mask（只保留最大主体）、contour、interior
  const mask = new Uint8Array(slW * slH);
  for (let y = 0; y < slH; y++) for (let x = 0; x < slW; x++) {
    if (label[y * slW + x] === bestLabel) mask[y * slW + x] = 1;
  }
  const contour = new Uint8Array(slW * slH);
  const interior = new Uint8Array(slW * slH);
  for (let y = 0; y < slH; y++) {
    for (let x = 0; x < slW; x++) {
      if (!mask[y * slW + x]) continue;
      const l = x > 0 && mask[y * slW + x - 1], r = x < slW - 1 && mask[y * slW + x + 1];
      const u = y > 0 && mask[(y - 1) * slW + x], d = y < slH - 1 && mask[(y + 1) * slW + x];
      if (l && r && u && d) interior[y * slW + x] = 1;
      else contour[y * slW + x] = 1;
    }
  }
  return { mask, contour, interior, bbox: [areas[bestLabel].minX, areas[bestLabel].minY, areas[bestLabel].maxX, areas[bestLabel].maxY] };
}

// 滑块内部纹理 ZNCC 主检测（四川航空）。
// 原理：缺口内部保留本轮滑块的同一块空间纹理（用户 probe 验证：正确配对 0.80-0.90，
// 错误滑块 ≤0.36）。ZNCC 零均值归一化，对亮度偏移鲁棒（滑块与缺口均值差 29-68 不影响）。
// 坐标：返回的 x = 完整 slW×slH 滑块画布左上角（384 域），不做 calib。
// y：只搜 yTest ± yBand(默认3)。
function matchGapZncc(bgData, bgW, bgH, sliderData, slW, slH, opts = {}) {
  const yTest = opts.yTest;
  const yBand = opts.yBand ?? 3;
  const xMin = opts.xMin ?? slW; // 排除滑块原位带
  const wZncc = opts.wZncc ?? 0.8;
  const edgeThr = opts.edgeThr ?? 55;
  const dil = opts.dil ?? 2;
  const erodeIters = opts.erodeIters ?? 2;
  const rejectScore = opts.rejectScore ?? 0.6;
  const rejectMargin = opts.rejectMargin ?? 0.15;
  const nms = opts.nms ?? 20;
  const topK = opts.topK ?? 3;

  // Alpha 形状：最大连通域 + interior（稳健蒙版，排除纯黑背景）
  const sm = extractSliderMask(sliderData, slW, slH);
  const interior = sm.interior;
  const contour = sm.contour;
  const shapeLeftEdge = sm.bbox ? sm.bbox[0] : 0;
  const znccMask = erodeMask(interior, slW, slH, erodeIters);
  const pts = [];
  for (let sy = 0; sy < slH; sy++) for (let sx = 0; sx < slW; sx++) {
    if (znccMask[sy * slW + sx]) pts.push({ sx, sy });
  }
  if (pts.length < 50) throw new Error('zncc mask too small');

  // 滑块内部灰度模板
  const tGray = new Float32Array(pts.length);
  for (let i = 0; i < pts.length; i++) {
    const pi = (pts[i].sy * slW + pts[i].sx) * 4;
    tGray[i] = 0.299 * sliderData[pi] + 0.587 * sliderData[pi + 1] + 0.114 * sliderData[pi + 2];
  }
  let tMean = 0; for (let i = 0; i < pts.length; i++) tMean += tGray[i];
  tMean /= pts.length;
  let tVar = 0; for (let i = 0; i < pts.length; i++) { const d = tGray[i] - tMean; tVar += d * d; }

  // 背景灰度 + Sobel 边缘 + 膨胀
  const gray = new Float32Array(bgW * bgH);
  for (let y = 0; y < bgH; y++) for (let x = 0; x < bgW; x++) {
    const i = (y * bgW + x) * 4;
    gray[y * bgW + x] = 0.299 * bgData[i] + 0.587 * bgData[i + 1] + 0.114 * bgData[i + 2];
  }
  const edge = sobelEdgeGray(gray, bgW, bgH, edgeThr);
  const edgeDil = dilateMask(edge, bgW, bgH, dil);
  let nC = 0; for (let i = 0; i < slW * slH; i++) nC += contour[i];

  const y0 = yTest === undefined ? 0 : Math.max(0, yTest - yBand);
  const y1 = yTest === undefined ? bgH - slH : Math.min(bgH - slH, yTest + yBand);

  // 背景整体亮度（缺口"深度同背景"参考）
  let bgMean = 0;
  for (let i = 0; i < bgW * bgH; i++) bgMean += gray[i];
  bgMean /= (bgW * bgH);

  // 权重：默认纯 ZNCC + 轮廓（组合平滑特征可选，未验证不默认启用）
  const wZncc2 = opts.wZncc2 ?? 0.8;
  const wGap = opts.wGap ?? 0;
  const wCh = opts.wCh ?? 0.2;
  const lumScale = opts.lumScale ?? 100;

  const cands = [];
  for (let y = y0; y <= y1; y++) {
    for (let x = xMin; x <= bgW - slW; x++) {
      // ZNCC（掩码内）
      let iMean = 0;
      for (let i = 0; i < pts.length; i++) iMean += gray[(y + pts[i].sy) * bgW + (x + pts[i].sx)];
      iMean /= pts.length;
      let num = 0, iVar = 0;
      for (let i = 0; i < pts.length; i++) {
        const iv = gray[(y + pts[i].sy) * bgW + (x + pts[i].sx)];
        const di = iv - iMean, dt = tGray[i] - tMean;
        num += dt * di; iVar += di * di;
      }
      const zncc = (tVar > 0 && iVar > 0) ? num / Math.sqrt(tVar * iVar) : 0;
      // 缺口平滑特征：候选位置内部边缘密度低（平滑）+ 亮度接近背景（深度同背景）
      let iEdgeSum = 0;
      for (let i = 0; i < pts.length; i++) iEdgeSum += edge[(y + pts[i].sy) * bgW + (x + pts[i].sx)];
      const iEdge = iEdgeSum / pts.length; // 0~高（Sobel 幅值）
      const lumDist = Math.abs(iMean - bgMean);
      const smoothness = Math.max(0, 1 - iEdge / 255);
      const depthFit = Math.max(0, 1 - lumDist / lumScale);
      const gapness = 0.5 * smoothness + 0.5 * depthFit;
      // Alpha 轮廓对背景边缘命中
      let chCnt = 0;
      for (let sy = 0; sy < slH; sy++) for (let sx = 0; sx < slW; sx++) {
        if (contour[sy * slW + sx] && edgeDil[(y + sy) * bgW + (x + sx)]) chCnt++;
      }
      const ch = nC > 0 ? chCnt / nC : 0;
      const score = wZncc2 * zncc + wGap * gapness + wCh * ch;
      cands.push({ x, y, zncc, gapness, smoothness, depthFit, iEdge, lumDist, ch, score });
    }
  }

  cands.sort((a, b) => b.score - a.score);
  const picked = [];
  for (const c of cands) {
    if (picked.some(p => Math.abs(p.x - c.x) <= nms && Math.abs(p.y - c.y) <= nms)) continue;
    picked.push(c);
    if (picked.length >= topK) break;
  }
  const top1 = picked[0] || null;
  const top2 = picked[1] || null;
  // 拒识诊断化：wouldReject/reason 只作诊断，不阻塞提交（检测器职责边界）。
  // reject 兼容旧字段，但调用方不得据此拦截坐标。
  const topScore = top1 ? top1.score : 0;
  const topMargin = (top1 && top2) ? top1.score - top2.score : (top1 ? 1 : 0);
  let rejectReason = 'none';
  if (!top1) rejectReason = 'no-candidate';
  else if (top1.score < rejectScore) rejectReason = 'score-low';
  else if (top2 && topMargin < rejectMargin) rejectReason = 'margin-close';
  const reject = rejectReason !== 'none';
  const wouldReject = reject;
  return {
    x: top1 ? top1.x : -1, y: top1 ? top1.y : -1,
    score: topScore, zncc: top1 ? top1.zncc : 0, gapness: top1 ? top1.gapness : 0, ch: top1 ? top1.ch : 0,
    reject, wouldReject, rejectReason, topScore, topMargin,
    shapeLeftEdge,
    candidates: picked.map(c => ({ x: c.x, y: c.y, score: c.score }))
  };
}

async function processCaptchaImages({
  p1,
  p2,
  transport = fetch,
  imageHost,
  key,
  renderedW,
  yTest
}) {
  // 四川航空专用：p1/p2 是完整相对路径（/api/p1?...），列置换密钥来自 a 接口的 o 字段（key）。
  if (key === undefined || key === '') throw new TypeError('processCaptchaImages: 四川航空需 o 密钥 (key)');
  if (yTest === undefined) throw new TypeError('processCaptchaImages: 四川航空需 yTest');
  if (!imageHost) throw new TypeError('processCaptchaImages: 需 imageHost');
  const bgUrl = imageHost + p1;
  const slUrl = imageHost + p2;
  // 图片下载加超时/abort，避免悬挂永久等待（P1 修复）
  async function fetchBuf(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15000);
    try {
      const r = await transport(url, { signal: controller.signal });
      const b = await r.arrayBuffer();
      return Buffer.from(b);
    } finally {
      clearTimeout(timer);
    }
  }
  const [bgBuf, slBuf] = await Promise.all([fetchBuf(bgUrl), fetchBuf(slUrl)]);
  const [bgImg, slImg] = await Promise.all([loadImage(bgBuf), loadImage(slBuf)]);
  const srcW = bgImg.width || 400, srcH = bgImg.height || 200;
  const bgCanvas = createCanvas(srcW, srcH);
  bgCanvas.getContext('2d').drawImage(bgImg, 0, 0, srcW, srcH);
  const perm = decodePermutation(key, 32);
  const restored = restoreBackground(bgCanvas, perm, srcW, srcH);
  const restoredW = restored.width;
  const ctx2d = restored.getContext('2d');
  const slCanvas = createCanvas(slImg.width, slImg.height);
  slCanvas.getContext('2d').drawImage(slImg, 0, 0);
  const slData = slCanvas.getContext('2d').getImageData(0, 0, slImg.width, slImg.height);

  // 四川航空：滑块内部纹理 ZNCC 匹配（matchGapZncc）。
  // 坐标契约（docs/sichuan/2026-08-02-scdx-gap-recovery-plan.md）：
  //   xImage = v.x 是重排图上的滑块画布原点，仍是源图像素间距（还原只重排未缩放）。
  //   xSubmit = floor(xImage × renderedW / sourceW)，sourceW = 400。
  //   不再用 fixed CALIB、不再乘 400/384。拒识诊断化：wouldReject 只作诊断，不拦截坐标。
  const bgData = ctx2d.getImageData(0, 0, restoredW, srcH).data;
  const slData8 = new Uint8ClampedArray(slData.data);
  const v = matchGapZncc(bgData, restoredW, srcH, slData8, slImg.width, slImg.height, { yTest });
  const rendered = renderedW || 270;
  // 提交锚点 = 滑块画布原点（v.x，384域），换算 = floor(v.x × 270 / 400)。
  // 两轮人工对照确认（用户手动拖动真值）：r1 拖动126 vs 检测126(0偏差)、r2 拖动146 vs 检测145(1偏差)。
  // 服务器判定点 = 画布原点，不是缺口左缘(绿线)。绿线仅作检测诊断。
  const xImage = v.x;
  const xSubmit = xImage >= 0 ? Math.floor(xImage * rendered / srcW) : -1;
  return {
    x: xSubmit,
    xImage,
    score: v.score,
    reject: v.reject,
    wouldReject: v.wouldReject,
    rejectReason: v.rejectReason,
    topScore: v.topScore,
    topMargin: v.topMargin,
    zncc: v.zncc,
    candidates: v.candidates,
    method: 'js-gap-zncc'
  };
}

module.exports = { decodePermutation, restoreBackground, extractSliderMask, erodeMask, matchGapZncc, processCaptchaImages };
