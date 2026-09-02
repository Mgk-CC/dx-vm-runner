// 随机化环境指纹——模拟"每次都是不同设备"。
// 背景：VM 固定 browser-profile.json（固定 UA/screen/硬件），每次跑同一指纹 + 不同 IP，
// 是"代理池 + 固定指纹"的可疑组合，服务器能识别并判自动化（不累积升级）。
// 随机化后：每次跑指纹不同（UA版本/screen/硬件/语言），配合新 IP 更像真实用户/新设备。
// 不改原 config，返回深拷贝的随机化副本。
function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}

// 常见屏幕分辨率（含可用高度=高度-浏览器UI 100~120）。
// 2026-08-04 恢复多档随机：固定 1K 曾导致所有 IP 同指纹(屏幕+语言)，服务器跨 IP 关联判自动化——
// 换 IP 时分辨率必须跟着变(同 IP 固定由 2.js currentProfile 保证，换 IP 重新随机)。
const SCREENS = [
  { width: 1920, height: 1080, availHeight: 969, dpr: 1 },
  { width: 1366, height: 768, availHeight: 657, dpr: 1 },
  { width: 2560, height: 1440, availHeight: 1309, dpr: 2 },
  { width: 1536, height: 864, availHeight: 753, dpr: 1 },
  { width: 1440, height: 900, availHeight: 789, dpr: 1.25 },
  { width: 1680, height: 1050, availHeight: 939, dpr: 1 },
  { width: 1280, height: 720, availHeight: 609, dpr: 1 },
  { width: 1600, height: 900, availHeight: 789, dpr: 1 },
  { width: 1024, height: 768, availHeight: 657, dpr: 1 }
];

// 生成随机 UA（Chrome 版本 130-170，平台 Windows/Mac，品牌 Chrome/Edge）。
// 2026-08-04 拓宽：加 macOS 平台 + Edge 品牌（设备大类变，跨平台更不关联）。
function randomUserAgent(chromeVer, { platform = 'Windows', brand = 'Chrome' } = {}) {
  const plat =
    platform === 'Mac'
      ? 'Macintosh; Intel Mac OS X 10_15_7'
      : 'Windows NT 10.0; Win64; x64';
  const brandSuffix = brand === 'Edge' ? ` Edg/${chromeVer}.0.0.0` : '';
  return `Mozilla/5.0 (${plat}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVer}.0.0.0 Safari/537.36${brandSuffix}`;
}

// 随机化 profile（返回新对象，不改 base）。
// opts.random=false 时返回深拷贝原样（单轮诊断固定指纹用，DX_RANDOM_FP=0 开关）。
function randomizeProfile(base, { random = true } = {}) {
  if (!random) return JSON.parse(JSON.stringify(base));
  const p = JSON.parse(JSON.stringify(base));
  const screen = pick(SCREENS);
  // 2026-08-04 拓宽：UA 版本范围 130-170；平台 Windows 80% / Mac 20%；品牌 Chrome 85% / Edge 15%
  const chromeVer = randInt(130, 170);
  const platform = Math.random() < 0.8 ? 'Windows' : 'Mac';
  const brand = Math.random() < 0.85 ? 'Chrome' : 'Edge';
  // 2026-08-04 恢复随机语言：固定 zh-CN 曾导致所有 IP 同指纹(与固定分辨率叠加跨 IP 关联)；
  // 80% zh-CN（川航国内站）/ 20% en-US 与换 IP 随机一致。
  const isZh = Math.random() < 0.8;
  const hardwareConcurrency = pick([4, 6, 8, 12, 16]);
  const deviceMemory = pick([4, 8, 16]);
  const maxTouchPoints = Math.random() < 0.1 ? 5 : 0; // 少部分触摸屏
  const screenLeft = randInt(0, 50); // 多显示器偏移
  // 2026-08-04 时区固定 Asia/Shanghai：目标用户是中国人，都是北京时间(UTC+8)；
  // 随机时区反而假（中国人不会有东京/新加坡时区）。固定即可。
  const timezone = 'Asia/Shanghai';

  // navigator
  p.navigator = {
    ...p.navigator,
    userAgent: randomUserAgent(chromeVer, { platform, brand }),
    appVersion: platform === 'Mac' ? '5.0 (Macintosh; Intel Mac OS X 10_15_7)' : '5.0 (Windows)',
    platform: platform === 'Mac' ? 'MacIntel' : 'Win32',
    hardwareConcurrency,
    deviceMemory,
    maxTouchPoints,
    language: isZh ? 'zh-CN' : 'en-US',
    languages: isZh ? ['zh-CN', 'zh'] : ['en-US', 'en']
  };

  // 时区（2026-08-04 新增）：随机时区字段供 VM 覆盖 Intl
  p.timezone = timezone;

  // screen
  p.screen = {
    width: screen.width,
    height: screen.height,
    availWidth: screen.width,
    availHeight: screen.availHeight,
    colorDepth: 32,
    pixelDepth: 32
  };

  // window
  p.window = {
    innerWidth: screen.width,
    innerHeight: screen.availHeight,
    outerWidth: screen.width,
    outerHeight: screen.height,
    devicePixelRatio: screen.dpr,
    screenLeft,
    screenTop: randInt(0, 30)
  };

  return p;
}

module.exports = { randomizeProfile, randomUserAgent };
