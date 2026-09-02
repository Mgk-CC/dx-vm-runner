// 四川航空 callWeb FLIGHT_SEARCH_ROUND —— 风控校验入口。
// 真实浏览器链路（222.har/123uanair.com 证实）：
//   c1(拿const_id) → callWeb(validType=0, constId) → RISK_VALID_FAIL → 弹顶象验证码
//   → a接口 → 滑块/点选成功(token) → callWeb(validType=1, token) → 放行返回航班
// VM 之前直接 c1 → a → v1，缺 callWeb —— 服务器不认会话 → 不累计失败 → 不升级 → 4012。
const crypto = require('node:crypto');

// 浏览器请求头（对齐真实 HAR m.sichuanair.com.har 的 callWeb 请求）
// 川航 m.sichuanair.com 校验严格：缺 UA/sec-ch-ua/sec-fetch 等头 → 代理下被拒（Tomcat 错误页）。
const DEFAULT_PROFILE = require('../config/browser-profile.json');

// browserHeaders(profile)：默认用固定 profile，可传随机化后的 profile
function browserHeaders(profile = DEFAULT_PROFILE) {
  const ua = profile.navigator?.userAgent;
  const chromeVer = /Chrome\/(\d+)/.exec(ua || '');
  const version = chromeVer ? chromeVer[1] : '149';
  return {
    'Accept': 'application/json, text/plain, */*',
    'Accept-Encoding': 'gzip, deflate, br, zstd',
    'Accept-Language': 'zh-CN,zh;q=0.9',
    'Content-Type': 'application/json',
    'Origin': 'https://m.sichuanair.com',
    'User-Agent': ua,
    'sec-ch-ua': `"Google Chrome";v="${version}", "Chromium";v="${version}", "Not)A;Brand";v="24"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'sec-fetch-dest': 'empty',
    'sec-fetch-mode': 'cors',
    'sec-fetch-site': 'same-origin'
  };
}

const CALLWEB_URL = 'https://m.sichuanair.com/tribe-touch-web-h5/tribe/common/callWeb?action=FLIGHT_SEARCH_ROUND';
const SERIAL_UID = '3468346970403940848L';

function genTransActionId() {
  // 真实格式：UUID（7bef3c78-f1f5-4c26-8fb7-0b9546c90eb9）
  return crypto.randomUUID();
}

// 构造 risk 对象
function buildRisk({ validType, constId, token, extCurrentUrl }) {
  const risk = { serialVersionUID: SERIAL_UID, validType };
  if (constId !== undefined) risk.constId = constId;
  if (token !== undefined) risk.token = token;
  if (extCurrentUrl) risk.extCurrentUrl = extCurrentUrl;
  return risk;
}

// 航班搜索请求（对齐真实：成都↔阿勒泰往返）
// 2026-08-04 修复：orgDate/rtnDate 由调用方从 extCurrentUrl 的 URL 参数解析传入，
// 保证 extCurrentUrl/searchRequest/Referer 三方日期一致（真实浏览器三方完全一致）；
// 无参调用时兜底 2026-08-14/2026-08-29（与 config/browser-profile.json 的 extCurrentUrl 一致）。
function buildSearchRequest(overrides = {}) {
  const { orgDate = '2026-08-14', rtnDate = '2026-08-29', ...rest } = overrides;
  return {
    airLineType: 'D',
    dstCode: 'TFU',
    orgCode: 'AAT',
    orgDate,
    passengers: { adults: '1', children: '0', infants: '0' },
    rtnDate,
    dstCodeType: 'C',
    orgCodeType: 'C',
    ...rest
  };
}

/**
 * 调 callWeb 风控接口
 * @param {object} opts { validType, constId, token, extCurrentUrl, transport, searchRequest }
 * @returns {Promise<object>} 响应 JSON
 */
async function callFlightSearch({
  validType,
  constId,
  token,
  extCurrentUrl,
  transport = fetch,
  searchRequest,
  timeout = 15000,
  profile
}) {
  // 2026-08-04 修复：searchRequest 日期从 extCurrentUrl 的 URL 参数解析，保证与 Referer 三方一致。
  // 真实浏览器 extCurrentUrl/searchRequest/Referer 日期完全一致；硬编码日期与 profile 过期日期互斥。
  // extCurrentUrl 缺省时兜底根 URL（与 Referer 兜底一致），日期解析不到则用 08-14/08-29 默认值。
  const currentUrl = extCurrentUrl || 'https://m.sichuanair.com/';
  const u = new URL(currentUrl);
  const departDate = u.searchParams.get('departDate') || '2026-08-14';
  const returnDate = u.searchParams.get('returnDate') || '2026-08-29';

  const body = {
    body: {
      data: {
        risk: buildRisk({ validType, constId, token, extCurrentUrl }),
        searchRequest: searchRequest || buildSearchRequest({ orgDate: departDate, rtnDate: returnDate }),
        firstSearch: '1'
      }
    },
    head: { platformId: 3, imie: '', transActionId: genTransActionId() }
  };

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const resp = await transport(CALLWEB_URL, {
      method: 'POST',
      headers: {
        ...browserHeaders(profile),
        // 真实浏览器 Referer = 完整页面 URL（HAR 证实），不是根路径
        'Referer': extCurrentUrl || 'https://m.sichuanair.com/'
      },
      body: JSON.stringify(body),
      signal: controller.signal
    });
    const text = await resp.text();
    let json;
    try { json = JSON.parse(text); } catch {
      // 非 JSON（如代理被川航拒返回的 Tomcat 错误页）——明确标注，不误导
      json = { raw: text.slice(0, 200), parseError: true, status: `ERR:${resp.status}` };
    }
    return json;
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { callFlightSearch, buildRisk, buildSearchRequest, genTransActionId };
