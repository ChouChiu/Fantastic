/*
 * /amp（Apple Music 官方 API 代理）请求的统一入口：自动重试。
 * 不限速（请求的是 Apple 官方接口；wrapper-lite 和 QQ 源的限速在各自那边）。
 *
 * 用法和 fetch 一样，返回 Response，调用方原有的 res.json()、状态码判断都不用改。
 *
 * 重试（最多 RETRIES 次，指数退避加抖动）：
 *   - 网络错误（fetch 抛 TypeError）
 *   - 429、502、503、504
 *   - 状态 200 但响应体为空或不是合法 JSON（以前会被报成「HTTP 200」）
 * 不重试：其他 4xx（包括调用方自己处理的 400 去掉 l 参数）、调用方中止（AbortError / TimeoutError）。
 *
 * 也挂在 globalThis.ampFetch 上，给 i18n.js、automix.js 这类非模块脚本用。
 */

const RETRIES = 3;
const BASE_DELAY = 500;
const MAX_DELAY = 8000;
const RETRY_STATUS = new Set([429, 502, 503, 504]);

const sleep = (ms, signal) => new Promise((resolve, reject) => {
  if (ms <= 0) return resolve();
  if (signal && signal.aborted) return reject(signal.reason);
  const timer = setTimeout(() => { if (signal) signal.removeEventListener('abort', onAbort); resolve(); }, ms);
  const onAbort = () => { clearTimeout(timer); reject(signal.reason); };
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
});

function backoff(attempt) {
  const ms = Math.min(MAX_DELAY, BASE_DELAY * 2 ** attempt);
  return ms / 2 + Math.random() * ms / 2;
}

function retryAfter(res) {
  const value = res.headers.get('retry-after');
  if (!value) return 0;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(MAX_DELAY * 4, Math.max(0, seconds * 1000));
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(MAX_DELAY * 4, Math.max(0, date - Date.now())) : 0;
}

const isAbort = (err) => err && (err.name === 'AbortError' || err.name === 'TimeoutError');

export async function ampFetch(input, init) {
  const signal = init && init.signal;
  for (let attempt = 0; ; attempt++) {
    const last = attempt >= RETRIES;
    let res;
    let text = null;
    try {
      res = await fetch(input, init);
      // 200 也要先读完响应体：读到一半断开、空响应、非 JSON 都算失败
      if (res.ok && res.status !== 204) text = await res.text();
    } catch (err) {
      if (isAbort(err) || (signal && signal.aborted) || last) throw err;
      await sleep(backoff(attempt), signal);
      continue;
    }

    if (text !== null) {
      let valid = false;
      try { valid = text.trim() !== '' && JSON.parse(text) !== null; } catch {}
      if (valid || last) return new Response(text, { status: res.status, statusText: res.statusText, headers: res.headers });
      await sleep(backoff(attempt), signal);
      continue;
    }
    if (!RETRY_STATUS.has(res.status) || last) return res;
    const wait = Math.max(retryAfter(res), backoff(attempt));
    res.body && res.body.cancel().catch(() => {});
    await sleep(wait, signal);
  }
}

globalThis.ampFetch = ampFetch;
