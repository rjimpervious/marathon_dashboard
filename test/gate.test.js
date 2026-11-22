import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGate } from '../src/gate.js';

const TOKEN = 'test-token-0123456789abcdef';
const ORIGIN = 'https://run.rjlopez.me';

function request(path, cookie) {
  const headers = cookie ? { Cookie: cookie } : {};
  return new Request(ORIGIN + path, { headers });
}

describe('evaluateGate', () => {
  it('refuses a real host when no token is configured', () => {
    assert.deepEqual(evaluateGate(request('/'), ''), { action: 'deny', status: 503 });
    assert.deepEqual(evaluateGate(request('/api/stats'), undefined), { action: 'deny', status: 503 });
  });

  it('allows localhost even without a token', () => {
    const local = new Request('http://localhost:8787/api/stats');
    assert.deepEqual(evaluateGate(local, undefined), { action: 'allow' });
  });

  it('allows localhost even with a token', () => {
    const local = new Request('http://localhost:8787/api/stats');
    assert.deepEqual(evaluateGate(local, TOKEN), { action: 'allow' });
  });

  it('denies a visitor without credentials', () => {
    assert.deepEqual(evaluateGate(request('/'), TOKEN), { action: 'deny', status: 401 });
  });

  it('denies api requests without credentials', () => {
    assert.deepEqual(evaluateGate(request('/api/stats'), TOKEN), { action: 'deny', status: 401 });
  });

  it('redirects a correct link to the clean url and sets the cookie', () => {
    const result = evaluateGate(request('/?k=' + TOKEN), TOKEN);
    assert.equal(result.action, 'redirect');
    assert.equal(result.location, '/');
    assert.match(result.setCookie, new RegExp('^rd_access=' + TOKEN + ';'));
    assert.match(result.setCookie, /Max-Age=31536000/);
    assert.match(result.setCookie, /HttpOnly/);
    assert.match(result.setCookie, /Secure/);
    assert.match(result.setCookie, /SameSite=Lax/);
    assert.match(result.setCookie, /Path=\//);
  });

  it('keeps the path and other parameters when it strips the token', () => {
    const result = evaluateGate(request('/api/stats?k=' + TOKEN + '&x=1'), TOKEN);
    assert.equal(result.action, 'redirect');
    assert.equal(result.location, '/api/stats?x=1');
  });

  it('denies a wrong token in the link', () => {
    assert.deepEqual(evaluateGate(request('/?k=wrong-token-0123456789'), TOKEN), { action: 'deny', status: 401 });
  });

  it('denies a token that is only a prefix of the real one', () => {
    assert.deepEqual(evaluateGate(request('/?k=' + TOKEN.slice(0, -1)), TOKEN), { action: 'deny', status: 401 });
  });

  it('allows a valid cookie', () => {
    assert.deepEqual(evaluateGate(request('/', 'rd_access=' + TOKEN), TOKEN), { action: 'allow' });
  });

  it('finds the cookie among several cookies', () => {
    const cookie = 'a=1; rd_access=' + TOKEN + '; b=2';
    assert.deepEqual(evaluateGate(request('/api/status', cookie), TOKEN), { action: 'allow' });
  });

  it('denies a wrong cookie', () => {
    assert.deepEqual(evaluateGate(request('/', 'rd_access=nope'), TOKEN), { action: 'deny', status: 401 });
  });

  it('ignores cookies with other names', () => {
    assert.deepEqual(evaluateGate(request('/', 'other=' + TOKEN), TOKEN), { action: 'deny', status: 401 });
  });

  it('fails closed when the token is too short', () => {
    assert.deepEqual(evaluateGate(request('/?k=short'), 'short'), { action: 'deny', status: 503 });
  });
});
