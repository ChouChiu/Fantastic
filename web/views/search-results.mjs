// 首页的搜索：与 music.apple.com/search 相同的 amp-api 调用（经服务端 /amp 代理）。
// 本文件是搜索条目（toItem）、条目的行 / 卡片排版与结果区（分组、分类标签、分页）；输入框、建议下拉与地址栏在 home.mjs。
import { amp, artUrl } from '../amp.mjs';
import { albumPathOf } from './actions.mjs';
import { parseAppleLink } from './links.mjs';
import * as qq from '../sources/qq.mjs';
import * as ncm from '../sources/ncm.mjs';
import { trackKey } from '../sources/track.mjs';

const { AmI18n } = window;
const { t } = AmI18n;

export function el(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function artNode(className, src) {
  const box = el('span', className);
  box.append(src ? Object.assign(document.createElement('img'), { src, alt: '', loading: 'lazy', decoding: 'async' }) : el('span', 'ph'));
  return box;
}

function fmtDuration(ms) {
  if (!ms) return '';
  const s = Math.round(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function explicitBadge() {
  const badge = el('span', 'explicit', 'E');
  badge.title = t('search.explicit');
  badge.setAttribute('aria-label', t('search.explicit'));
  return badge;
}

/** 目录资源 → 可打开的歌曲 / MV / 专辑 / 歌单 / 艺人条目；其余类型本站无法打开，忽略 */
const KINDS = { songs: 'song', 'music-videos': 'music-video', albums: 'album', playlists: 'playlist', artists: 'artist' };
export const KIND_LABELS = { song: 'home.detectSong', 'music-video': 'home.detectMv', album: 'home.detectAlbum', playlist: 'home.detectPlaylist', artist: 'home.detectArtist' };

export function toItem(resource, storefront) {
  const attrs = resource && resource.attributes;
  const kind = resource && KINDS[resource.type];
  if (!attrs || !kind) return null;
  const mv = kind === 'music-video';
  let link = parseAppleLink(attrs.url || '');
  // 歌曲的 url 是 album/<slug>/<id>?i=<id>，搜索结果里的歌曲仍打开歌曲页
  const albumSong = kind === 'song' && link && link.match(/^https:\/\/music\.apple\.com\/([a-z]{2})\/album\/([^/?#]+)\/\d+\?i=(\d+)$/);
  if (albumSong) link = `https://music.apple.com/${albumSong[1]}/song/${albumSong[2]}/${albumSong[3]}`;
  if (!link || !link.includes(`/${kind}/`)) link = `https://music.apple.com/${storefront}/${kind}/_/${resource.id}`;
  return {
    // 歌单没有 artistName，副标题用歌单作者（curatorName）
    kind, mv, href: '/' + link, title: attrs.name || resource.id, artist: attrs.artistName || attrs.curatorName || '', album: attrs.albumName || '',
    year: (attrs.releaseDate || '').slice(0, 4), genre: (attrs.genreNames || [])[0] || '',
    artwork: attrs.artwork, duration: attrs.durationInMillis, explicit: attrs.contentRating === 'explicit',
    traits: attrs.audioTraits || [], has4K: !!attrs.has4K, subtitle: attrs.subtitle || '',
    // 封面按钮与「更多」菜单（见 actions.mjs）
    resource, apple: attrs.url || link, country: storefront,
  };
}

/** 音质标志：歌曲用 app.css 的 .q-icon 图标（与播放条同一套），MV 用 4K 文字标签 */
const QUALITY_LABELS = { hires: 'Hi-Res Lossless', lossless: 'Lossless', atmos: 'Dolby Atmos' };
function qualityBadges(item, mvClass = '') {
  if (item.mv) return item.has4K ? [el('span', `q-badge ${mvClass}`.trim(), '4K')] : [];
  const keys = [];
  if (item.traits.includes('hi-res-lossless')) keys.push('hires');
  else if (item.traits.includes('lossless')) keys.push('lossless');
  if (item.traits.includes('atmos')) keys.push('atmos');
  return keys.map((key) => {
    const icon = el('span', `q-icon q-icon--${key}`);
    icon.title = QUALITY_LABELS[key];
    icon.setAttribute('role', 'img');
    icon.setAttribute('aria-label', QUALITY_LABELS[key]);
    return icon;
  });
}

// 分组顺序按接口返回的 meta.results.order（与官网一致），缺失时用这里的顺序
const GROUPS = [['top', 'search.top'], ['artist', 'search.artists'], ['album', 'search.albums'], ['song', 'search.songs'], ['playlist', 'search.playlists'], ['music_video', 'search.mvs']];
const GROUP_LABELS = Object.fromEntries(GROUPS);
// “全部”视图里每组只露一行（歌曲为 3 列 × 3 行），多出的在对应分类标签页里看；桌面宽度下的行宽由 app.css 控制
const PREVIEW = { song: 9, music_video: 4 };
const PREVIEW_CARDS = 6;
const TOP_LIMIT = 6;
// next 分页地址只带 groups / offset / term / types / l，其余参数需补上，否则返回空结果
const PAGE_PARAMS = { limit: '21', platform: 'web', with: 'serverBubbles', 'omit[resource]': 'autos' };

/** QQ 音乐搜索：分组 key → cloudsearch 类型（顺序即“全部”视图里的顺序）与每页数量 */
const QQ_GROUPS = [['song', 'song'], ['artist', 'artist'], ['album', 'album'], ['playlist', 'playlist'], ['music_video', 'mv']];
const QQ_LIMIT = { song: 30, artist: 20, album: 20, playlist: 20, music_video: 20 };
const yearOf = (ms) => (ms ? String(new Date(Number(ms)).getUTCFullYear()) : '');
const names = (artists) => (artists || []).map((artist) => artist.name).filter(Boolean).join(' / ');

/**
 * 结果区：/v1/catalog/{storefront}/search，取最佳结果与歌曲、艺人、专辑、歌单、MV 五组，next 分页地址同样经 /amp 代理。
 * els: { section, title, tabs, body }；storefront() / catalogLang() 为当前地区与曲库语言；ready() 返回 wrapper-lite 状态检查的 Promise（QQ 搜索不等它）。
 * source() 为搜索音源（'apple' | 'qq'）：QQ 时各类型分别请求 QQ 音乐搜索，分页按 offset。player 用于 QQ 歌曲的播放，toast 提示翻页失败
 */
export function createResults({ els, actions, storefront, catalogLang, ready, source = () => 'apple', player, toast }) {
  /** groups: [{ key, items, next }]；view: 'all' 或某个分组 key */
  const search = { term: '', controller: null, groups: [], view: 'all' };
  const LAYOUTS = { music_video: ['mv-grid', mvCard], album: ['album-grid', albumCard], playlist: ['album-grid', playlistCard], artist: ['album-grid', artistCard] };

  const statusNode = (text, className) => el('p', `results-state${className ? ' ' + className : ''}`, text);

  // 标签的方向键：← → 切换到相邻标签，Home / End 到头尾（与设置页的标签相同）
  els.tabs.addEventListener('keydown', (event) => {
    const tabs = [...els.tabs.querySelectorAll('[role="tab"]')];
    const index = tabs.indexOf(document.activeElement);
    if (index < 0) return;
    const rtl = getComputedStyle(els.tabs).direction === 'rtl';
    const next = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1 }[event.key];
    let target = null;
    if (next) target = tabs[(index + next + tabs.length) % tabs.length];
    else if (event.key === 'Home') target = tabs[0];
    else if (event.key === 'End') target = tabs[tabs.length - 1];
    if (!target) return;
    event.preventDefault();
    setView(target.dataset.key, true);
  });

  async function run(term) {
    // 同一关键词重新搜索（切换地区、语言）时保留当前分类标签
    const keepView = term === search.term ? search.view : 'all';
    search.term = term;
    if (search.controller) search.controller.abort();
    const controller = search.controller = new AbortController();
    els.section.hidden = false;
    els.title.textContent = t('search.results', { term });
    els.tabs.hidden = true;
    els.body.replaceChildren(statusNode(t('search.loading'), 'loading'));
    try {
      if (['qq', 'ncm'].includes(source())) {
        const requestedSource = source();
        const adapter = requestedSource === 'ncm' ? ncm : qq;
        const groups = requestedSource === 'ncm' ? QQ_GROUPS.filter(([, type]) => type !== 'mv') : QQ_GROUPS;
        const results = await Promise.allSettled(groups.map(([key, type]) =>
          adapter.search(term, type, { limit: QQ_LIMIT[key], signal: controller.signal })));
        if (controller !== search.controller || source() !== requestedSource) return;
        // 各类型分别请求，部分失败时照样显示其余的；全部失败才报错
        if (results.every((result) => result.status === 'rejected')) throw results[0].reason;
        search.groups = groups.map(([key, type], index) => {
          const result = results[index];
          if (result.status !== 'fulfilled') return null;
          const { items, total } = result.value;
          const group = { key, items: [], next: null, qq: { source: requestedSource, term, type, offset: items.length } };
          group.items = qqItems(key, items, group);
          group.next = items.length && items.length < total ? 'qq' : null;
          return group;
        }).filter((group) => group && group.items.length);
        search.view = search.groups.some((group) => group.key === keepView) ? keepView : 'all';
        render();
        return;
      }
      await ready();
      const data = await amp(`/v1/catalog/${storefront()}/search`, {
        term, l: await catalogLang(), types: 'songs,albums,music-videos,playlists,artists', ...PAGE_PARAMS,
      }, { signal: controller.signal });
      if (controller !== search.controller) return;
      const results = data.results || {};
      const order = (data.meta && data.meta.results && data.meta.results.order) || GROUPS.map(([key]) => key);
      const cc = storefront();
      search.groups = order
        .filter((key) => GROUP_LABELS[key] && results[key] && results[key].data)
        .map((key) => {
          const items = results[key].data.map((res) => toItem(res, cc)).filter(Boolean);
          return key === 'top' ? { key, items: items.slice(0, TOP_LIMIT), next: null } : { key, items, next: results[key].next || null };
        })
        .filter((group) => group.items.length);
      search.view = search.groups.some((group) => group.key === keepView) ? keepView : 'all';
      render();
    } catch (error) {
      if (controller !== search.controller || error.name === 'AbortError') return;
      els.body.replaceChildren(statusNode(t('search.failed', { msg: error.message }), 'error'));
    }
  }

  function close() {
    search.term = '';
    search.groups = [];
    search.view = 'all';
    if (search.controller) search.controller.abort();
    search.controller = null;
    els.section.hidden = true;
    els.body.replaceChildren();
  }

  /** 分类标签（全部 / 歌曲 / 专辑 …）与当前视图 */
  function render(focusTab = false) {
    const { groups, view } = search;
    const tabKeys = ['all', ...groups.map((group) => group.key).filter((key) => key !== 'top')];
    // 重建标签前焦点在标签上（点击或方向键切换）：重建后移到新选中的标签，焦点不丢
    const refocus = focusTab || els.tabs.contains(document.activeElement);
    els.tabs.hidden = tabKeys.length < 3; // 只有一个分类时标签没有意义
    els.tabs.replaceChildren(...tabKeys.map((key) => {
      const tab = el('button', 'results-tab', t(key === 'all' ? 'search.all' : GROUP_LABELS[key]));
      tab.type = 'button';
      tab.id = `results-tab-${key}`;
      tab.dataset.key = key;
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(key === view));
      tab.setAttribute('aria-controls', 'results-body');
      // 只有选中的标签可以 Tab 进入，其余用方向键
      tab.tabIndex = key === view ? 0 : -1;
      tab.addEventListener('click', () => setView(key));
      return tab;
    }));
    const selected = els.tabs.querySelector('[aria-selected="true"]');
    if (selected && !els.tabs.hidden) {
      els.body.setAttribute('role', 'tabpanel');
      els.body.setAttribute('aria-labelledby', selected.id);
      if (refocus) selected.focus({ preventScroll: true });
    } else {
      els.body.removeAttribute('role');
      els.body.removeAttribute('aria-labelledby');
    }
    if (!groups.length) { els.body.replaceChildren(statusNode(t('search.none'))); return; }
    els.body.replaceChildren(...(view === 'all'
      ? groups.map(previewNode)
      : [fullNode(groups.find((group) => group.key === view))]));
  }

  function setView(key, focusTab = false) {
    if (key === search.view) return;
    search.view = key;
    render(focusTab);
    // 标签栏吸顶；切换后回到结果开头
    if (els.section.getBoundingClientRect().top < 0) els.section.scrollIntoView({ block: 'start' });
  }

  function groupHead(label, action) {
    const head = el('div', 'group-head');
    head.append(el('h3', 'group-title', t(label)));
    if (action) head.append(action);
    return head;
  }

  /** “全部”视图中的一组：只显示一行，更多的通过“查看全部”进入分类标签 */
  function previewNode(group) {
    const { key, items, next } = group;
    const section = el('div', `result-group${key === 'top' ? ' top-group' : ''}`);
    const [listClass, renderItem] = key === 'top' ? ['song-grid', topRow] : LAYOUTS[key] || ['song-grid', songRow];
    const limit = key === 'top' ? TOP_LIMIT : PREVIEW[key] || PREVIEW_CARDS;
    const list = el('div', `${listClass} preview`);
    list.append(...items.slice(0, limit).map(renderItem));
    let action = null;
    if (key !== 'top' && (items.length > limit || next)) {
      action = el('button', 'see-all', t('search.seeAll'));
      action.type = 'button';
      // 「查看全部」所在的区块会被替换：焦点移到对应的标签
      action.addEventListener('click', () => setView(key, true));
    }
    section.append(groupHead(GROUP_LABELS[key], action), list);
    return section;
  }

  /** 分类标签页：该组全部结果，底部“加载更多”按 next 翻页 */
  function fullNode(group) {
    const { key } = group;
    const [listClass, renderItem] = LAYOUTS[key] || ['song-grid', songRow];
    const section = el('div', 'result-group');
    const list = el('div', listClass);
    list.append(...group.items.map(renderItem));
    const more = el('button', 'btn load-more', t('search.more'));
    more.type = 'button';
    more.hidden = !group.next;
    const controller = search.controller;
    more.addEventListener('click', async () => {
      more.disabled = true;
      try {
        if (group.qq) {
          const { term, type } = group.qq;
          const page = await (group.qq.source === 'ncm' ? ncm : qq).search(term, type, { offset: group.qq.offset, limit: QQ_LIMIT[key], signal: controller.signal });
          if (controller !== search.controller) return;
          group.qq.offset += page.items.length;
          const seen = new Set(group.items.map((item) => item.href));
          const added = qqItems(key, page.items, group).filter((item) => !seen.has(item.href));
          group.items.push(...added);
          group.next = page.items.length && group.qq.offset < page.total ? 'qq' : null;
          list.append(...added.map(renderItem));
        } else {
          const data = await amp(group.next, PAGE_PARAMS, { signal: controller.signal });
          const page = (data.results && (data.results[key] || Object.values(data.results)[0])) || {};
          const cc = storefront();
          const added = (page.data || []).map((res) => toItem(res, cc)).filter(Boolean);
          group.items.push(...added);
          group.next = page.next || null;
          list.append(...added.map(renderItem));
        }
        more.hidden = !group.next;
      } catch (error) {
        if (error.name === 'AbortError') return;
        toast?.(t('search.failed', { msg: error.message }));
      }
      more.disabled = false;
    });
    section.append(list, more);
    return section;
  }

  /** QQ 搜索结果 → 与 toItem 相同形状的条目；歌曲从这一首开始播放本组已载入的歌曲 */
  function qqItems(key, list, group) {
    const adapter = group.qq.source === 'ncm' ? ncm : qq;
    const base = { source: group.qq.source, mv: false, explicit: false, traits: [], has4K: false, subtitle: '', year: '', genre: '', album: '', artist: '' };
    return list.map((value) => {
      if (key === 'song') {
        const item = { ...base, kind: 'song', href: value.href, title: value.name, artist: value.artist, album: value.album,
          artwork: value.artwork, duration: value.duration, track: value };
        item.onPlay = () => {
          const songs = group.items.filter((entry) => entry.track);
          if (player.current && trackKey(player.current) === value.key) { player.toggle(); return; }
          player.playQueue(songs.map((entry) => adapter.entryOf(entry.track)), Math.max(0, songs.indexOf(item)));
        };
        return item;
      }
      if (key === 'artist') return { ...base, kind: 'artist', href: adapter.artistPath(value.mid), title: value.name, artwork: value.avatar,
        genre: value.albumSize ? t('qq.artistAlbums', { n: value.albumSize }) : '' };
      if (key === 'album') return { ...base, kind: 'album', href: adapter.albumPath(value.mid), title: value.name, artwork: value.cover,
        artist: names(value.artists), year: yearOf(value.publishTime) };
      if (key === 'playlist') return { ...base, kind: 'playlist', href: adapter.playlistPath(value.id), title: value.name, artwork: value.cover,
        artist: value.creator || '' };
      return { ...base, kind: 'music-video', mv: true, href: qq.mvPath(value.vid), title: value.name, artwork: value.cover,
        artist: names(value.artists), duration: value.durationMs };
    });
  }

  /** 搜索结果条目 → actions.mjs 的条目；歌曲单独播放，菜单里可前往专辑 */
  function targetOf(item) {
    if (['qq', 'ncm'].includes(item.source)) {
      return { kind: item.kind, source: item.source, href: item.href, name: item.title, track: item.track,
        albumHref: item.track?.albumHref || '', ...(item.onPlay ? { onPlay: item.onPlay } : {}) };
    }
    return {
      kind: item.kind, href: item.href, apple: item.apple, name: item.title, country: item.country, resource: item.resource,
      albumHref: item.kind === 'song' ? albumPathOf(item.resource) : '',
    };
  }

  /** 最佳结果的一行：与歌曲行同样的布局，副标题带类型；艺人圆形头像，MV 用 16:9 缩略图 */
  function topRow(item) {
    const row = el('a', 'song-row');
    row.href = item.href;
    const title = el('span', 'row-title', item.title);
    if (item.explicit) title.append(explicitBadge());
    const main = el('span', 'row-main');
    main.append(title, el('span', 'row-sub', [t(KIND_LABELS[item.kind]), item.artist].filter(Boolean).join(' · ')));
    const cover = item.mv ? artNode('row-cover wide', artUrl(item.artwork, 160, 90))
      : artNode(item.kind === 'artist' ? 'row-cover round' : 'row-cover', artUrl(item.artwork, 96, 96));
    row.append(cover, main);
    if (item.kind === 'song' || item.mv) {
      const meta = el('span', 'row-meta');
      meta.append(...qualityBadges(item), el('span', 'row-time', fmtDuration(item.duration)));
      row.append(meta);
    }
    return actions.wrapRow(row, targetOf(item));
  }

  function songRow(item) {
    const row = el('a', 'song-row');
    row.href = item.href;
    const title = el('span', 'row-title', item.title);
    if (item.explicit) title.append(explicitBadge());
    const main = el('span', 'row-main');
    main.append(title, el('span', 'row-sub', [item.artist, item.album].filter(Boolean).join(' · ')));
    const meta = el('span', 'row-meta');
    meta.append(...qualityBadges(item), el('span', 'row-time', fmtDuration(item.duration)));
    row.append(artNode('row-cover', artUrl(item.artwork, 96, 96)), main, meta);
    return actions.wrapRow(row, targetOf(item));
  }

  function albumCard(item) {
    const card = el('a', 'album-card');
    card.href = item.href;
    const title = el('span', 'recent-title', item.title);
    if (item.explicit) title.append(explicitBadge());
    card.append(artNode('album-thumb', artUrl(item.artwork, 360, 360)), title, el('span', 'recent-sub', [item.artist, item.year].filter(Boolean).join(' · ')));
    return actions.wrapCard(card, targetOf(item));
  }

  /** 艺人：圆形头像，副标题为主要流派（与官网搜索结果一致） */
  function artistCard(item) {
    const card = el('a', 'album-card artist-card');
    card.href = item.href;
    card.append(artNode('album-thumb round', artUrl(item.artwork, 360, 360)), el('span', 'recent-title', item.title), el('span', 'recent-sub', item.genre));
    return actions.wrapCard(card, targetOf(item));
  }

  function playlistCard(item) {
    const card = el('a', 'album-card');
    card.href = item.href;
    card.append(artNode('album-thumb', artUrl(item.artwork, 360, 360)), el('span', 'recent-title', item.title), el('span', 'recent-sub', item.artist));
    return actions.wrapCard(card, targetOf(item));
  }

  function mvCard(item) {
    const card = el('a', 'mv-card');
    card.href = item.href;
    const thumb = artNode('mv-thumb', artUrl(item.artwork, 480, 270));
    if (item.duration) thumb.append(el('span', 'mv-time', fmtDuration(item.duration)));
    thumb.append(...qualityBadges(item, 'mv-q'));
    const title = el('span', 'recent-title', item.title);
    if (item.explicit) title.append(explicitBadge());
    card.append(thumb, title, el('span', 'recent-sub', item.artist));
    return actions.wrapCard(card, targetOf(item));
  }

  return {
    run,
    close,
    get term() { return search.term; },
  };
}
