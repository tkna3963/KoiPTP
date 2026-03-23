/**
 * 気象庁 XML フィードビューア — app.js
 * 高性能版: DocumentFragment, 仮想スクロール, requestIdleCallback,
 *           WeakMap キャッシュ, AbortController, スロットリング
 */

'use strict';

/* ===== 定数 ===== */
const FEEDS = [
    { key: 'regular', url: 'https://www.data.jma.go.jp/developer/xml/feed/regular.xml', interval: 60, label: '定時' },
    { key: 'extra', url: 'https://www.data.jma.go.jp/developer/xml/feed/extra.xml', interval: 60, label: '随時' },
    { key: 'eqvol', url: 'https://www.data.jma.go.jp/developer/xml/feed/eqvol.xml', interval: 60, label: '地震火山' },
    { key: 'other', url: 'https://www.data.jma.go.jp/developer/xml/feed/other.xml', interval: 60, label: 'その他' },
    { key: 'regular_l', url: 'https://www.data.jma.go.jp/developer/xml/feed/regular_l.xml', interval: 1800, label: '定時(長)' },
    { key: 'extra_l', url: 'https://www.data.jma.go.jp/developer/xml/feed/extra_l.xml', interval: 1800, label: '随時(長)' },
    { key: 'eqvol_l', url: 'https://www.data.jma.go.jp/developer/xml/feed/eqvol_l.xml', interval: 1800, label: '地震火山(長)' },
    { key: 'other_l', url: 'https://www.data.jma.go.jp/developer/xml/feed/other_l.xml', interval: 1800, label: 'その他(長)' },
];

const ITEM_H = 54;          // エントリ行の高さ(px) — 仮想スクロール用
const OVERSCAN = 8;         // 上下の余分描画行数

/* ===== 状態 ===== */
const seenIds = new Set();
let allEntries = [];
let filteredEntries = [];
let currentEntryUrl = null;
let currentView = 'raw';
let contentReady = false;
const nextRefreshAt = {};
let renderScheduled = false;   // rAF デバウンス
let relTimeRafId = null;

/** AbortController for 現在実行中のエントリXML取得 */
let entryAbort = null;

/* ===== XML パーサキャッシュ ===== */
const domParser = new DOMParser();

/* ===== リセット時用タイムスタンプキャッシュ (WeakMap不可なので Map) ===== */
const relTimeCache = new Map();  // ts→{result,at}

/* ===== DOM refs ===== */
const $ = id => document.getElementById(id);

/* ===== Init ===== */
document.addEventListener('DOMContentLoaded', () => {
    FEEDS.forEach(f => {
        fetchFeed(f);
        nextRefreshAt[f.key] = Date.now() + f.interval * 1000;
        setInterval(() => {
            fetchFeed(f);
            nextRefreshAt[f.key] = Date.now() + f.interval * 1000;
        }, f.interval * 1000);
    });

    setInterval(tickCountdown, 1000);
    setInterval(tickRelTimes, 5000);   // 5秒ごとで十分
    startNowTime();
    initVirtualScroll();
    initSwipe();
});

/* ===== 時計 ===== */
function startNowTime() {
    const el = $('NowTime');
    const pad = n => String(n).padStart(2, '0');
    const tick = () => {
        const d = new Date();
        el.textContent = `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日 ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    };
    tick();
    setInterval(tick, 1000);
}

/* ===== カウントダウン ===== */
function tickCountdown() {
    const nextKey = Object.keys(nextRefreshAt).reduce((a, b) =>
        nextRefreshAt[a] < nextRefreshAt[b] ? a : b);
    const sec = Math.max(0, Math.round((nextRefreshAt[nextKey] - Date.now()) / 1000));
    const f = FEEDS.find(f => f.key === nextKey);
    const el = $('next-refresh');
    if (el) el.textContent = `次回更新: ${f.label} あと${sec}秒`;
}

/* ===== 相対時刻 ===== */
function relTime(s) {
    if (!s) return '';
    const cached = relTimeCache.get(s);
    const now = Date.now();
    if (cached && now - cached.at < 5000) return cached.result;
    try {
        const sec = Math.floor((now - new Date(s).getTime()) / 1000);
        if (sec < 0) return '';
        if (sec < 60) { const r = `(${sec}秒前)`; relTimeCache.set(s, { result: r, at: now }); return r; }
        if (sec < 3600) { const r = `(${Math.floor(sec / 60)}分前)`; relTimeCache.set(s, { result: r, at: now }); return r; }
        if (sec < 86400) { const r = `(${Math.floor(sec / 3600)}時間前)`; relTimeCache.set(s, { result: r, at: now }); return r; }
        const r = `(${Math.floor(sec / 86400)}日前)`; relTimeCache.set(s, { result: r, at: now }); return r;
    } catch { return ''; }
}

function tickRelTimes() {
    relTimeCache.clear();   // キャッシュ無効化 → 次の描画で再計算
    // 仮想スクロールで表示中の行だけ更新
    const rows = document.querySelectorAll('.entry-row .rel[data-ts]');
    rows.forEach(el => { el.textContent = relTime(el.dataset.ts || ''); });
}

/* ===== フィード取得 ===== */
function fetchFeed(f) {
    setDot(f.key, 'loading');
    fetch(f.url, { cache: 'no-store' })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
        .then(text => { setDot(f.key, 'ok'); mergeFeed(text, f); })
        .catch(err => { console.error(`[JMA] ${f.key}:`, err); setDot(f.key, 'err'); });
}

function setDot(key, state) {
    const el = $(`fst-${key}`);
    if (el) el.querySelector('.dot').className = `dot ${state}`;
}

/* ===== フィード パース & マージ ===== */
function mergeFeed(text, f) {
    const doc = domParser.parseFromString(text, 'application/xml');
    if (doc.querySelector('parsererror')) return;

    const entries = doc.getElementsByTagNameNS('*', 'entry');
    const len = entries.length;
    let newCount = 0;

    for (let i = 0; i < len; i++) {
        const e = entries[i];
        const id = getT(e, 'id');
        if (!id || seenIds.has(id)) continue;
        seenIds.add(id);
        newCount++;

        const title = getT(e, 'title');
        const updated = getT(e, 'updated');
        const published = getT(e, 'published');
        const author = getT(e, 'name') || getT(e, 'author');
        let link = '';
        const links = e.getElementsByTagNameNS('*', 'link');
        for (let j = 0; j < links.length; j++) {
            const rel = links[j].getAttribute('rel') || 'alternate';
            if (!link || rel === 'alternate') { link = links[j].getAttribute('href') || ''; }
            if (rel === 'alternate') break;
        }
        allEntries.push({ id, title, updated, published, author, link, feedKey: f.key });
    }

    if (newCount > 0) {
        // ソートはタイムスタンプ数値比較のみ (Date.parse → 整数)
        allEntries.sort((a, b) => {
            const ta = Date.parse(a.published || a.updated || '0');
            const tb = Date.parse(b.published || b.updated || '0');
            return tb - ta;
        });
        $('st-total').textContent = `エントリ: ${allEntries.length}件`;
        $('st-last').textContent = `最終更新: ${new Date().toLocaleTimeString('ja-JP')}`;
        scheduleRender();
    }
}

/* ===== 描画スケジューリング (rAF デバウンス) ===== */
function scheduleRender() {
    if (renderScheduled) return;
    renderScheduled = true;
    requestAnimationFrame(() => {
        renderScheduled = false;
        applyFilter();
    });
}

/* ===== フィルタ ===== */
function applyFilter() {
    const q = $('filter-input').value.trim();
    filteredEntries = q
        ? allEntries.filter(e => (e.title || '').includes(q))
        : allEntries.slice();

    const cnt = $('entry-count');
    cnt.textContent = filteredEntries.length === allEntries.length
        ? `${allEntries.length}件`
        : `${filteredEntries.length}/${allEntries.length}件`;

    renderVirtualList(true);

    // 初回自動選択
    if (!currentEntryUrl && filteredEntries.length > 0) {
        selectEntry(filteredEntries[0].link);
    }
}

window.filterEntries = function () { scheduleRender(); };
window.forceRefreshAll = function () {
    FEEDS.forEach(f => { fetchFeed(f); nextRefreshAt[f.key] = Date.now() + f.interval * 1000; });
};

/* ===================================================
   仮想スクロール
   =================================================== */
let vsScrollTop = 0;
let vsContainerH = 0;
let vsRenderedStart = -1;
let vsRenderedEnd = -1;

function initVirtualScroll() {
    const el = $('entry-list');
    el.addEventListener('scroll', onVsScroll, { passive: true });
    const ro = new ResizeObserver(() => {
        vsContainerH = el.clientHeight;
        renderVirtualList(false);
    });
    ro.observe(el);
    vsContainerH = el.clientHeight;
}

function onVsScroll(e) {
    vsScrollTop = e.target.scrollTop;
    requestAnimationFrame(() => renderVirtualList(false));
}

function renderVirtualList(reset) {
    const el = $('entry-list');
    const total = filteredEntries.length;

    if (!total) {
        el.innerHTML = '<div class="sidebar-msg">エントリなし</div>';
        vsRenderedStart = vsRenderedEnd = -1;
        return;
    }

    if (reset) {
        vsScrollTop = el.scrollTop = 0;
        vsRenderedStart = vsRenderedEnd = -1;
    } else {
        vsScrollTop = el.scrollTop;
    }

    const totalH = total * ITEM_H;
    const start = Math.max(0, Math.floor(vsScrollTop / ITEM_H) - OVERSCAN);
    const end = Math.min(total, Math.ceil((vsScrollTop + vsContainerH) / ITEM_H) + OVERSCAN);

    // 変化なければスキップ
    if (start === vsRenderedStart && end === vsRenderedEnd) return;
    vsRenderedStart = start;
    vsRenderedEnd = end;

    const frag = document.createDocumentFragment();

    // 上スペーサー
    const topSpacer = document.createElement('div');
    topSpacer.className = 'vscroll-spacer';
    topSpacer.style.height = `${start * ITEM_H}px`;
    frag.appendChild(topSpacer);

    // 表示行
    for (let i = start; i < end; i++) {
        frag.appendChild(buildEntryRow(filteredEntries[i]));
    }

    // 下スペーサー
    const botSpacer = document.createElement('div');
    botSpacer.className = 'vscroll-spacer';
    botSpacer.style.height = `${(total - end) * ITEM_H}px`;
    frag.appendChild(botSpacer);

    // DOM差し替え (スクロール位置を保持)
    const saved = el.scrollTop;
    el.innerHTML = '';
    el.appendChild(frag);
    el.scrollTop = saved;
}

function buildEntryRow(e) {
    const div = document.createElement('div');
    div.className = 'entry-row' + (e.link === currentEntryUrl ? ' active' : '');
    div.style.height = `${ITEM_H}px`;

    const date = e.published || e.updated || '';
    const titleEl = document.createElement('div');
    titleEl.className = 'et';
    titleEl.textContent = e.title || '(タイトルなし)';

    const metaEl = document.createElement('div');
    metaEl.className = 'em';

    const timeSpan = document.createElement('span');
    timeSpan.textContent = date ? fmt(date) + ' ' : '';
    const relSpan = document.createElement('span');
    relSpan.className = 'rel';
    relSpan.dataset.ts = date;
    relSpan.textContent = date ? relTime(date) : '';
    timeSpan.appendChild(relSpan);
    metaEl.appendChild(timeSpan);

    if (e.author) {
        const authSpan = document.createElement('span');
        authSpan.textContent = e.author;
        metaEl.appendChild(authSpan);
    }

    div.appendChild(titleEl);
    div.appendChild(metaEl);
    div.addEventListener('click', () => selectEntry(e.link), { passive: true });
    return div;
}

/* ===== エントリ選択 ===== */
function selectEntry(link) {
    if (!link) { showRight('err', 'リンクURLがありません'); return; }
    currentEntryUrl = link;
    contentReady = false;

    // アクティブ行更新（仮想スクロール内の DOM だけ）
    document.querySelectorAll('.entry-row').forEach(r => r.classList.remove('active'));
    document.querySelectorAll('.entry-row').forEach(r => {
        if (r.querySelector('.et')?.textContent ===
            (filteredEntries.find(e => e.link === link)?.title || '')) r.classList.add('active');
    });
    // 確実にアクティブを付けるため再描画
    renderVirtualList(false);

    $('url-disp').textContent = link;
    showRight('ld');

    // スマホ: ボトムシートを開く
    openSheet();

    // 前の取得をキャンセル
    if (entryAbort) entryAbort.abort();
    entryAbort = new AbortController();

    fetch(link, { signal: entryAbort.signal })
        .then(r => { if (!r.ok) throw new Error(`HTTP ${r.status}`); return r.text(); })
        .then(text => {
            $('st-sz').textContent = `${(text.length / 1024).toFixed(1)} KB`;
            renderDetail(text);
        })
        .catch(err => {
            if (err.name === 'AbortError') return;
            showRight('err', `${err.message}\n\n${link}`);
        });
}

window.openExternal = function () { if (currentEntryUrl) window.open(currentEntryUrl, '_blank'); };

/* ===== 詳細描画 ===== */
function renderDetail(text) {
    const doc = domParser.parseFromString(text, 'application/xml');

    // --- KV ペア収集 ---
    const kvPairs = [];
    const walkStack = [{ el: doc.documentElement, path: '' }];
    while (walkStack.length) {
        const { el, path } = walkStack.pop();
        if (!el.localName) continue;
        const fullPath = path ? `${path} > ${el.localName}` : el.localName;
        const attrs = el.hasAttributes()
            ? [...el.attributes].map(a => `${a.name}="${a.value}"`).join(' ')
            : '';
        let directText = '';
        const children = el.childNodes;
        const childEls = [];
        for (let i = 0; i < children.length; i++) {
            const c = children[i];
            if (c.nodeType === 3) directText += c.textContent;
            else if (c.nodeType === 1) childEls.push(c);
        }
        directText = directText.trim();
        if (directText) kvPairs.push([fullPath + (attrs ? ` [${attrs}]` : ''), directText]);
        // 逆順でスタックに追加 (元の順序を保持)
        for (let i = childEls.length - 1; i >= 0; i--) {
            walkStack.push({ el: childEls[i], path: fullPath });
        }
    }

    const entry = allEntries.find(e => e.link === currentEntryUrl) || {};

    // --- INFO パネル ---
    const infoEl = $('panel-info');
    infoEl.innerHTML = '';
    const titleDiv = document.createElement('div');
    titleDiv.className = 'info-title';
    titleDiv.textContent = entry.title || '';
    infoEl.appendChild(titleDiv);

    const tbl = document.createElement('table');
    tbl.className = 'info-table';
    const rows = [
        ['タイトル', entry.title],
        ['発表時刻', entry.published ? fmt(entry.published) : '—'],
        ['更新時刻', entry.updated ? fmt(entry.updated) : '—'],
        ['発表機関', entry.author || '—'],
        ['URL', currentEntryUrl],
    ];
    tbl.innerHTML = rows.map(([l, v]) =>
        `<tr><td>${esc(l)}</td><td>${esc(v || '')}</td></tr>`).join('');
    infoEl.appendChild(tbl);

    // --- RAW パネル ---
    const rawEl = $('panel-raw');
    rawEl.innerHTML = '';

    const kvTitle = document.createElement('div');
    kvTitle.className = 'xml-section-title';
    kvTitle.textContent = 'XML 全フィールド';
    rawEl.appendChild(kvTitle);

    const kvBox = document.createElement('div');
    kvBox.className = 'xml-kv';
    const kvTbl = document.createElement('table');
    // DocumentFragment でまとめて追加
    const kvFrag = document.createDocumentFragment();
    for (const [k, v] of kvPairs) {
        const tr = document.createElement('tr');
        tr.innerHTML = `<td>${esc(k)}</td><td>${esc(v)}</td>`;
        kvFrag.appendChild(tr);
    }
    kvTbl.appendChild(kvFrag);
    kvBox.appendChild(kvTbl);
    rawEl.appendChild(kvBox);

    const rawTitle = document.createElement('div');
    rawTitle.className = 'xml-section-title';
    rawTitle.textContent = '生XML（RAW）';
    rawEl.appendChild(rawTitle);

    // XML ハイライト: idle 時に実行してブロッキングを避ける
    const rawBox = document.createElement('div');
    rawBox.className = 'raw-xml';
    rawEl.appendChild(rawBox);

    const applyHighlight = () => {
        rawBox.innerHTML = hlXml(esc(text));
    };
    if (typeof requestIdleCallback !== 'undefined') {
        requestIdleCallback(applyHighlight, { timeout: 1000 });
    } else {
        setTimeout(applyHighlight, 0);
    }

    contentReady = true;
    showRight('content');
}

/* ===== 表示制御 ===== */
function showRight(state, msg) {
    $('ph').style.display = state === 'ph' ? 'flex' : 'none';
    $('ld').style.display = state === 'ld' ? 'flex' : 'none';
    $('eb').style.display = state === 'err' ? 'block' : 'none';
    $('panel-raw').style.display = (state === 'content' && currentView === 'raw') ? 'block' : 'none';
    $('panel-info').style.display = (state === 'content' && currentView === 'info') ? 'block' : 'none';
    if (state === 'err' && msg) $('eb').textContent = msg;
}

window.setView = function (v) {
    currentView = v;
    $('btn-raw').classList.toggle('active', v === 'raw');
    $('btn-info').classList.toggle('active', v === 'info');
    if (contentReady) showRight('content');
};

/* ===== ボトムシート制御 ===== */
function openSheet() {
    if (window.innerWidth > 768) return;
    $('main-panel').classList.add('open');
    $('sheet-overlay').classList.add('show');
    document.body.style.overflow = 'hidden';
}
function closeSheet() {
    $('main-panel').classList.remove('open');
    $('sheet-overlay').classList.remove('show');
    document.body.style.overflow = '';
}
window.closeSheet = closeSheet;

/* ===== スワイプで閉じる ===== */
function initSwipe() {
    const panel = $('main-panel');
    let startY = 0, isDragging = false, startTranslate = 0;

    const handle = panel.querySelector('.sheet-handle');
    if (!handle) return;

    handle.addEventListener('touchstart', e => {
        if (window.innerWidth > 768) return;
        startY = e.touches[0].clientY;
        isDragging = true;
        startTranslate = 0;
        panel.style.transition = 'none';
    }, { passive: true });

    handle.addEventListener('touchmove', e => {
        if (!isDragging) return;
        const dy = e.touches[0].clientY - startY;
        if (dy < 0) return;
        panel.style.transform = `translateY(${dy}px)`;
    }, { passive: true });

    handle.addEventListener('touchend', e => {
        if (!isDragging) return;
        isDragging = false;
        panel.style.transition = '';
        const dy = e.changedTouches[0].clientY - startY;
        if (dy > 100) {
            closeSheet();
            panel.style.transform = '';
        } else {
            panel.style.transform = '';
        }
    }, { passive: true });
}

/* ===== ユーティリティ ===== */
function getT(el, tag) {
    if (!el) return '';
    const n = el.getElementsByTagNameNS('*', tag);
    return n.length ? n[0].textContent.trim() : '';
}
function fmt(s) {
    try {
        const d = new Date(s);
        return isNaN(d) ? s : d.toLocaleString('ja-JP', { timeZone: 'Asia/Tokyo' });
    } catch { return s; }
}
function esc(s) {
    return String(s || '')
        .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function hlXml(e) {
    return e
        .replace(/(&lt;!--[\s\S]*?--&gt;)/g, '<span class="xc">$1</span>')
        .replace(/(&lt;\/?[\w:\-]+)((?:\s+[\w:\-]+=&quot;[^"]*?&quot;)*)(\/?)(&gt;)/g,
            (_, tag, attrs, sl, end) =>
                `<span class="xt">${tag}${attrs.replace(/([\w:\-]+)=(&quot;[^"]*?&quot;)/g,
                    '<span class="xa">$1</span>=<span class="xv">$2</span>')}${sl}${end}</span>`)
        .replace(/(&lt;\/?[\w:\-]+\s*\/?\s*&gt;)/g, '<span class="xt">$1</span>');
}