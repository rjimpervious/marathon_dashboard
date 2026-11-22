const COOKIE_NAME = 'rd_access';
const TOKEN_PARAM = 'k';
const COOKIE_MAX_AGE_SECONDS = 365 * 24 * 3600;
const MIN_TOKEN_LENGTH = 16;
const LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

function safeEqual(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const encoder = new TextEncoder();
  const x = encoder.encode(a);
  const y = encoder.encode(b);
  let diff = x.length ^ y.length;
  const length = Math.max(x.length, y.length);
  for (let i = 0; i < length; i++) diff |= (x[i] || 0) ^ (y[i] || 0);
  return diff === 0;
}

function readCookie(header, name) {
  if (!header) return null;
  for (const part of header.split(';')) {
    const index = part.indexOf('=');
    if (index > 0 && part.slice(0, index).trim() === name) return part.slice(index + 1).trim();
  }
  return null;
}

function accessCookie(token) {
  return COOKIE_NAME + '=' + token + '; Max-Age=' + COOKIE_MAX_AGE_SECONDS + '; Path=/; HttpOnly; Secure; SameSite=Lax';
}

export function evaluateGate(request, token) {
  const url = new URL(request.url);
  if (LOCAL_HOSTS.includes(url.hostname)) return { action: 'allow' };
  if (!token || token.length < MIN_TOKEN_LENGTH) return { action: 'deny', status: 503 };

  const supplied = url.searchParams.get(TOKEN_PARAM);
  if (supplied !== null && safeEqual(supplied, token)) {
    url.searchParams.delete(TOKEN_PARAM);
    return { action: 'redirect', location: url.pathname + url.search, setCookie: accessCookie(token) };
  }
  if (safeEqual(readCookie(request.headers.get('Cookie'), COOKIE_NAME), token)) return { action: 'allow' };
  return { action: 'deny', status: 401 };
}
