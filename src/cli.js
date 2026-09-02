const fs = require('node:fs');
const path = require('node:path');
const { runDx } = require('./run');
const { runFullFlow } = require('./full-flow');
const { validateServer, formatOutput } = require('./validate');

const optionNames = new Map([
  ['--app-id', 'appId'],
  ['--ua-token', 'uaToken'],
  ['--server', 'server'],
  ['--profile', 'profilePath'],
  ['--timeout', 'timeout'],
  ['--mode', 'mode'],
  ['--ak', 'ak'],
  ['--jsv', 'jsv'],
  ['--captcha-host', 'captchaHost'],
  ['--image-host', 'imageHost'],
  ['--ac-version', 'acVersion'],
  ['--w', 'w'],
  ['--h', 'h'],
  ['--proxy', 'proxy']
]);

function parseTimeout(value) {
  if (!/^-?\d+$/.test(value)) {
    throw new TypeError('timeout must be an integer');
  }
  const timeout = Number(value);
  if (timeout < 1 || timeout > 60000) {
    throw new RangeError('timeout must be between 1 and 60000');
  }
  return timeout;
}

function parseDimension(value, name) {
  if (!/^\d+$/.test(value)) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  const n = Number(value);
  if (n < 1 || n > 2000) {
    throw new RangeError(`${name} must be between 1 and 2000`);
  }
  return n;
}

function parseOptions(argv, env) {
  const values = {
    appId: env.DX_APP_ID,
    uaToken: env.DX_UA_TOKEN,
    server: env.DX_SERVER,
    profilePath: env.DX_PROFILE,
    timeout: env.DX_TIMEOUT,
    mode: env.DX_MODE,
    ak: env.DX_AK,
    jsv: env.DX_JSV,
    captchaHost: env.DX_CAPTCHA_HOST,
    imageHost: env.DX_IMAGE_HOST,
    acVersion: env.DX_AC_VERSION,
    w: env.DX_W,
    h: env.DX_H,
    proxy: env.DX_PROXY
  };

  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    const name = optionNames.get(flag);
    if (!name) {
      throw new TypeError(`unknown option: ${flag}`);
    }
    const value = argv[index + 1];
    if (value === undefined || value.startsWith('--')) {
      throw new TypeError(`${flag} requires a value`);
    }
    values[name] = value;
    index += 1;
  }

  const timeout = values.timeout === undefined ? undefined : parseTimeout(values.timeout);
  const server = validateServer(values.server);
  const mode = values.mode === undefined ? 'c1' : values.mode;
  if (mode !== 'c1' && mode !== 'full') {
    throw new TypeError('mode must be c1 or full');
  }
  const w = values.w === undefined ? undefined : parseDimension(values.w, 'w');
  const h = values.h === undefined ? undefined : parseDimension(values.h, 'h');
  return { ...values, server, timeout, mode, w, h };
}

function loadProfile(profilePath) {
  const filename = profilePath === undefined
    ? path.resolve(__dirname, '..', 'config', 'browser-profile.json')
    : path.resolve(profilePath);
  return JSON.parse(fs.readFileSync(filename, 'utf8'));
}

function diagnosticMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message
    .replace(/\bparam\b/gi, '[redacted]')
    .replace(/\b\d{4}#[A-Za-z0-9+/]+={0,2}/g, '[redacted]');
}

function formatFullOutput(result) {
  let out = `${JSON.stringify(result.response, null, 2)}\n\n${result.ac}\n`;
  if (result.v1) {
    out += `\n${JSON.stringify(result.v1, null, 2)}\n`;
  }
  return out;
}

function writeDiagnostic(stderr, prefix, error) {
  stderr.write(`${prefix}: ${diagnosticMessage(error)}\n`);
}

async function main({ argv, env, stdout, stderr, runner, fullRunner }) {
  let options;
  let profile;
  try {
    options = parseOptions(argv, env);
    if (typeof options.appId !== 'string' || options.appId.length === 0) {
      throw new TypeError('appId is required');
    }
    profile = loadProfile(options.profilePath);
  } catch (error) {
    writeDiagnostic(stderr, '配置错误', error);
    return 2;
  }

  try {
    const run = options.mode === 'full' ? fullRunner : runner;
    let transport;
    if (options.proxy) {
      const { createProxiedFetch } = require('./proxy-fetch');
      transport = createProxiedFetch(options.proxy);
    }
    const result = await run({ ...options, profile, ...(transport ? { transport } : {}) });

    stdout.write(
      options.mode === 'full'
        ? formatFullOutput(result)
        : formatOutput(result.response, result.ac)
    );
    return 0;
  } catch (error) {
    writeDiagnostic(stderr, '运行失败', error);
    return 1;
  }
}

module.exports = { main, parseOptions };

if (require.main === module) {
  const { argv, env, stdout, stderr } = process;
  main({
    argv: argv.slice(2),
    env,
    stdout,
    stderr,
    runner: runDx,
    fullRunner: runFullFlow
  }).then(code => {
    process.exitCode = code;
  });
}
