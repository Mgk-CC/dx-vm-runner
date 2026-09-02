# SC-DX 踩坑记录(Troubleshooting)

本文件记录项目开发过程中踩过的坑与根因,供后续维护参考。按阶段分类,每个坑含:现象 → 根因 → 解决。

> 原则:工具必须先可信再下结论;服务器判定是概率的;真成功标准是 callWeb 放行(航班列表),不是 v1 success。

---

## 一、基础设施层

| 坑 | 现象 | 根因 | 解决 |
|---|---|---|---|
| 4011 HIGH_RISK | VM 提交稳定 4011 | 轨迹用相对坐标(sliderLeft 218),真实页面滑块在 422 | 改绝对坐标(realStartX=422) |
| 事件监听器累积 | 多轮脚本每轮耗时线性涨,像死循环 | 复用 c1.context,每轮 bindDomEvents 向同一 document 注册 ~7 个 handler,dom.js 不去重 | 每轮 createVendorContext 新 context |
| 冻结时钟死循环 | 注入冻结 now 后轨迹调度永不退出 | 调度用 VM performance.now(=now()-timeOrigin) | 调度改 Node 单调时钟(perf_hooks),事件 timeStamp 仍走 VM 时钟 |
| runC1 永久等待 | vendor thenable 不 settle,主流程挂住 | XHR timeout 兜不住 vendor 异常路径 | withTimeout 看门狗(timeout+3000) |
| Node v24 ERR_INVALID_THIS | `performance.now` 裸调用抛错 | Node v24 要求 this 绑定 | `.bind(nodePerformance)` |
| 无进展重试 | 同一 sid/ac 连提 5 次,相同请求相同响应,纯消耗 | 无状态进展检测 | retry-no-progress 熔断(连续相同签名停止) |

## 二、请求层(差分工具)

| 坑 | 现象 | 根因 | 解决 |
|---|---|---|---|
| seq 按完成序 | 并发 p1/p2 顺序乱(真实是发起序) | logger 在 await 后 push | seq 在入口分配 + startedAt/endedAt/duration |
| null 归一化不对称 | 假阳性 RESP 差异 | request-log 保留 null("null"),har-to-graph 删 null | 抽共享 normalizeValue,两侧对称 |
| body 误判 | callWeb 的 JSON body 被当 form 切,constId 混入字段名 | JSON 含 `=`(extCurrentUrl 的 query)触发 form 分支 | body JSON-first(先 JSON.parse 拍平,失败再 form) |
| 测试假通过 | 收敛判定测试实际在测 MISMATCH 分支 | real[0] 是资源路径 → 走 MISMATCH,恰好返回收敛字符串 | 改同路径 + 仅 OBSERVATIONAL 的用例 |
| p2 URL 缺 `&` | 真实浏览器 bug(`...HyVL1_r=` 黏在一起) | 非 VM 问题 | 白名单豁免 |
| v1 502 是业务码 | HTTP 200,code=502 在响应体 | 业务失败码不在 HTTP 层 | 按业务码处理,别按 HTTP 状态 |

## 三、AC 层

| 坑 | 现象 | 根因 | 解决 |
|---|---|---|---|
| 标准 b64 解 ac 是乱码 | ac payload 解出垃圾 tag | ac payload 是**置换字母表** base64,非标准表 | 破置换表(`XmYj3u1PnvisIZUF8ThR/a6DfO+kW4JHrCELycAzSxleoQp02MtwV9Nd57qGgbKB=`),置换解码 → 明文 _ua tag 流 |
| 轨迹密度证据循环 | 1.7 点/px 系数无独立样本支撑 | 系数来自 123.txt 模板自身密度(205/118=1.737) | 实测真实成功轮 41 点/98px=0.42 点/px |
| 重复时间戳 88 个 | VM 轨迹 88 个重复 c,真实 7% | c = Date.now()-tm 现场取时,事件按 15.6ms 定时器量子分簇 → 同毫秒重复 | 定位到机制(非轨迹 t 重复,t 有单调修正) |
| tag17 轨迹解密 | 轨迹密文 8B/点 | encryptSA 自反(解密=加密,seed 33265) | 验证:x=422 与 realStartX 完全一致 |
| 信封式 ac 格式 | adspower-ac-tags.json 是另一种格式(tag128 内嵌) | 疑似 v2/v3 升级路径的 ac | 识别区分,v1 明文 tag 流为主 |

## 四、callWeb 层(最终突破口)

| 坑 | 现象 | 根因 | 解决 |
|---|---|---|---|
| RISK_VALID_REJECT(2021060603) | callWeb(1) 带 token 仍被拒 | callWeb(0) 下发的 acw_tc/JSESSIONID 被 jar 无过滤附加到 callWeb(1) 与 rcs 请求(真实浏览器全程无 cookie) | jar 按 host 过滤(host\|name 存) |
| 日期三方互斥 | extCurrentUrl 过期 07 月、searchRequest 08 月,真实三处一致 | 硬编码日期与 profile 过期日期不一致 | searchRequest 日期从 extCurrentUrl 解析,profile 日期更新 |
| callWeb 放行读不到(status=?) | 成功轮 callWeb(1) 打印 status=? | proxy-fetch 不解压 gzip → 37KB 航班响应 JSON.parse 失败 | 加 gzip gunzipSync + 去 encoding 头 |
| 打印读错层 | callWeb 的 status 永远 '?' | status 在 `head.status` 不在 `body.status` | 改读 head.status |

## 五、流程/资产坑

| 坑 | 说明 |
|---|---|
| dxdump.json / HAR3/HAR4 丢失 | 唯一成功轮真值、升级路径素材丢失 → 靠 vm-success-samples/ 重建 |
| travel-x 插码虚惊 | 加载器在页面 HTML 但脚本从未被请求(真实浏览器也没加载)→ 排除"缺旁路脚本" |
| sc-dx-fix 副本 | 另一台机器(WSL)的同步副本,硬编码 /home/z/ 路径,本机跑不了;内容已被主仓库覆盖 |
| plan mode 卡 agent | 写完计划没调 ExitPlanMode,派出的 agent 被 plan mode 拦下只读 | 先 ExitPlanMode 再派 agent |
| 文档与磁盘不符 | CLAUDE.md 引用的 constid.demo-5755.js.bak、v1接口.md 实际不存在 | 清理时一并修正 |

---

## 最有价值的三条认知

1. **服务器判定是概率的**——检测零偏差、ac 结构无缺失,还是 4012;成功靠 IP 池时机,不是"更像真人"。
2. **工具必须先可信再下结论**——F1/F2 假阳性不修,请求层结论全是错的。
3. **真成功标准是 callWeb 放行**,不是 v1 success——v1 出 token 只是中间产物,航班列表才是终点。
