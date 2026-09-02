# SC-DX（顶象滑块验证码 VM 沙箱）

在 Node.js `vm` 沙箱中运行顶象（Dingxiang）滑块验证码 SDK——无 Puppeteer/浏览器——生成 `ac` 指纹提交换取验证 `token`，再经 callWeb 放行返回航班。`vendor/` 下两个 bundle 为不可修改的第三方代码（SHA-256 锁定）。

**目标站点**：四川航空（rcs.sichuanair.com 反代顶象 + m.sichuanair.com callWeb 风控闭环）。

## 快速开始

```bash
npm install
node scratch/2.js 10   # IP精灵代理多轮 e2e，能出 token
```

## 主流程说明

链路：`c1（constId）→ callWeb(0)（风控检查，RISK_VALID_FAIL 弹验证码）→ a（sid/p1/p2/o）→ 图片还原+缺口检测 → 轨迹 → ac（s_v3#）→ v1 提交 → 成功则 callWeb(1) 放行 + 成功轮落盘`

- **成功率**：实测 ~78%（1000 轮：779 成功 / 146 位置拒 / 75 网络错）。失败多为 4012 POSITION_MISMATCH，属服务器概率判定（真实浏览器同样 4012），非代码缺陷。多跑几轮或换 IP。
- **传输**：默认走 IP精灵国内代理池（`scratch/ipzan.js`）；本机 IP 已被顶象标记，直连（`DX_DIRECT=1`）仅诊断。
- **输出**：stdout 为每轮结果 JSON（含 v1/token）；诊断走 stderr。

## 目录结构

```
src/            主流程编排（src/full-flow.js：c1 → a → 还原 → ac → v1 → callWeb）
scratch/        2.js（多轮 e2e 入口）、ipzan.js（代理池）
config/         browser-profile.json（浏览器指纹）
data/           轨迹模板（real-drag-points.json / real-trajectory.json）
docs/           排查文档（troubleshooting.md）
vendor/         顶象 SDK（index.js + gs.js，永不修改）
```

## 风险与注意事项

- 本机 IP 已被顶象标记，必须走国内代理。
- 换 IP 必须重建 cookie jar（`scratch/2.js` 已处理）。
- `vendor/` 永不修改（SHA-256 锁定，记录于 `CLAUDE.md`）。
