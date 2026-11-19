import { enabled } from '../sources/ncm.mjs';

/** Account state is a server boolean; no cookie is read back or persisted in the browser. */
export function mountNcmSettings({ root, signal, onLangChange, toast }) {
  if (!enabled()) return;
  const t = (key) => window.AmI18n.t(key);
  const el = (tag, props = {}, ...children) => {
    const node = Object.assign(document.createElement(tag), props);
    node.append(...children); return node;
  };
  const input = el('input', { id: 'ncm-cookie-input', type: 'password', className: 'set-input',
    autocomplete: 'off', spellcheck: false, value: '' });
  const save = el('button', { id: 'ncm-cookie-save', type: 'button', className: 'btn' });
  const clear = el('button', { id: 'ncm-cookie-clear', type: 'button', className: 'btn' });
  const status = el('span', { id: 'ncm-cookie-status', className: 'set-value' });
  status.setAttribute('role', 'status');
  const title = el('h2', { className: 'set-group-title' });
  const label = el('label', { className: 'set-label', htmlFor: input.id });
  const desc = el('span', { className: 'set-desc' });
  const statusLabel = el('span', { className: 'set-label' });
  const section = el('section', { id: 'ncm', className: 'set-group' }, title,
    el('div', { className: 'set-card' },
      el('div', { className: 'set-row set-row-wide' }, el('div', {}, label, desc), input),
      el('div', { className: 'set-row' }, statusLabel, status),
      el('div', { className: 'set-row set-ncm-actions' }, save, clear)));
  root.querySelector('#general').append(section);
  let stateKey = 'ncm.statusLoading';
  function render() {
    title.textContent = t('source.ncm'); label.textContent = 'Cookie';
    desc.textContent = t('ncm.cookieDesc'); statusLabel.textContent = t('ncm.loginStatus');
    status.textContent = t(stateKey); save.textContent = t('ncm.saveCookie'); clear.textContent = t('ncm.clearCookie');
    input.setAttribute('aria-label', t('ncm.cookieInput'));
  }
  async function refresh() {
    const response = await fetch('/ncm/cookie/status', { signal, cache: 'no-store' });
    if (!response.ok) throw new Error('status');
    const data = await response.json();
    if (signal.aborted) return;
    stateKey = data.configured === true ? 'ncm.configured' : 'ncm.notConfigured'; render();
  }
  async function update(method) {
    save.disabled = clear.disabled = true;
    try {
      const response = await fetch('/ncm/cookie', { method, signal,
        ...(method === 'PUT' ? { headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ cookie: input.value }) } : {}) });
      if (!response.ok) {
        stateKey = response.status === 503 ? 'ncm.cookieUnavailable' : response.status === 400 ? 'ncm.cookieInvalid' : 'ncm.cookieFailed';
        render(); return;
      }
      input.value = '';
      await refresh();
      if (!signal.aborted) toast?.(t(method === 'PUT' ? 'ncm.cookieSaved' : 'ncm.cookieCleared'));
    } catch { if (!signal.aborted) { stateKey = 'ncm.cookieFailed'; render(); } }
    finally { save.disabled = clear.disabled = false; }
  }
  save.addEventListener('click', () => update('PUT'));
  clear.addEventListener('click', () => update('DELETE'));
  signal.addEventListener('abort', () => { input.value = ''; }, { once: true });
  onLangChange(render); render();
  refresh().catch(() => { if (!signal.aborted) { stateKey = 'ncm.cookieFailed'; render(); } });
  return section;
}
