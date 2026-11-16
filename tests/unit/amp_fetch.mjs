// web/amp-fetch.mjs：/amp 请求的限速与自动重试
import test from 'node:test';
import assert from 'node:assert/strict';
import { ampFetch } from '../../web/amp-fetch.mjs';

const json = (body, status = 200, headers = {}) => new Response(body, { status, headers: { 'content-type': 'application/json', ...headers } });

function mockFetch(responses) {
  const calls = [];
  globalThis.fetch = async (input) => {
    calls.push(String(input));
    const next = responses.shift();
    if (next instanceof Error) throw next;
    return typeof next === 'function' ? next() : next;
  };
  return calls;
}

test('200 但响应体为空或不是 JSON 时重试', async () => {
  const calls = mockFetch([json(''), json('<html>'), json('{"data":[1]}')]);
  const res = await ampFetch('http://x/amp/v1/a');
  assert.equal(res.status, 200);
  assert.deepEqual(await res.json(), { data: [1] });
  assert.equal(calls.length, 3);
});

test('网络错误和 503 会重试，429 按 Retry-After 等待', async () => {
  const calls = mockFetch([new TypeError('Failed to fetch'), json('{}', 503), json('{}', 429, { 'retry-after': '0' }), json('{"ok":1}')]);
  const res = await ampFetch('http://x/amp/v1/b');
  assert.deepEqual(await res.json(), { ok: 1 });
  assert.equal(calls.length, 4);
});

test('404 和 400 不重试，原样返回', async () => {
  const calls = mockFetch([json('{"errors":[]}', 404), json('{}', 400)]);
  assert.equal((await ampFetch('http://x/amp/v1/c')).status, 404);
  assert.equal((await ampFetch('http://x/amp/v1/c')).status, 400);
  assert.equal(calls.length, 2);
});

test('重试次数用完后返回最后一次结果', async () => {
  const calls = mockFetch([json('', 200), json('', 200), json('', 200), json('', 200)]);
  const res = await ampFetch('http://x/amp/v1/d');
  assert.equal(res.status, 200);
  assert.equal(await res.json().catch(() => null), null);
  assert.equal(calls.length, 4);
});

test('同时最多 4 个请求', async () => {
  let active = 0, peak = 0;
  globalThis.fetch = async () => {
    active++; peak = Math.max(peak, active);
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return json('{}');
  };
  await Promise.all(Array.from({ length: 10 }, (_, i) => ampFetch(`http://x/amp/v1/e${i}`)));
  assert.equal(peak, 4);
});

test('中止的请求不重试', async () => {
  const calls = mockFetch([() => { throw new DOMException('aborted', 'AbortError'); }]);
  await assert.rejects(ampFetch('http://x/amp/v1/f'), { name: 'AbortError' });
  assert.equal(calls.length, 1);
});
