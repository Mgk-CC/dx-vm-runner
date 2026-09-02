function validateC1Response(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('c1 response must be a JSON object');
  }
  if (value.status !== 1 && value.status !== 2) {
    throw new Error(`c1 status is ${String(value.status)}`);
  }
  if (typeof value.data !== 'string' || value.data.length === 0) {
    throw new Error('c1 data must be a non-empty string');
  }
  return value;
}

function validateServer(server) {
  if (server === undefined) {
    return undefined;
  }
  if (typeof server !== 'string') {
    throw new TypeError('server must be a valid https URL');
  }

  let url;
  try {
    url = new URL(server);
  } catch {
    throw new TypeError('server must be a valid https URL');
  }
  if (url.protocol !== 'https:') {
    throw new TypeError('server must use https');
  }
  if (url.username !== '' || url.password !== '') {
    throw new TypeError('server must not include credentials');
  }
  if (url.pathname !== '/udid/c1') {
    throw new TypeError(
      'server must be the full c1 endpoint ending exactly /udid/c1'
    );
  }
  if (
    url.search !== ''
    || url.hash !== ''
    || url.href.endsWith('?')
    || url.href.endsWith('#')
  ) {
    throw new TypeError('server must not include a query string or fragment');
  }
  return url.toString();
}

function validateAc(ac, expectedVersion = 's_v3') {
  if (expectedVersion === undefined) expectedVersion = 's_v3';
  if (typeof ac !== 'string') {
    throw new TypeError('ac must be a string');
  }
  const match = /^([^#]+)#([A-Za-z0-9+/]+={0,2})/.exec(ac);
  if (!match || match[0] !== ac) {
    throw new Error('ac format is invalid or payload is not Base64');
  }
  const [, version, payload] = match;
  if (version !== expectedVersion) {
    throw new Error(`ac version must be ${expectedVersion}, got ${version}`);
  }
  if (payload.length % 4 !== 0) {
    throw new Error('ac Base64 payload length is invalid');
  }
  const decoded = Buffer.from(payload, 'base64');
  if (decoded.length === 0) {
    throw new Error('ac Base64 payload must decode to non-empty bytes');
  }
  return { version, payload, decodedBytes: decoded.length };
}

function formatOutput(response, ac) {
  return `${JSON.stringify(response, null, 2)}\n\n${ac}\n`;
}

module.exports = {
  validateC1Response,
  validateServer,
  validateAc,
  formatOutput
};
