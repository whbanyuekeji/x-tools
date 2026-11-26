// 运行在扩展环境（ISOLATED world）：接收 inject.js 旁听到的数据、保存、显示管理面板、引导你手动取关 / 关注。
// 这里不会替你点击 X 的任何按钮，也不会向 X 发请求；只做三件事：
//   1. 记录：网页已加载的关注列表 / 粉丝列表 / 主页数据
//   2. 筛选：未回关、粉丝数区间、关注时间
//   3. 引导：逐个打开选中的人的主页，把 X 自己的按钮高亮出来，由你亲手点
(() => {
  'use strict';
  if (window.__xfContent) return;
  window.__xfContent = true;

  const TOKEN = Math.random().toString(36).slice(2);
  const DAY = 86400000;
  const MAX_ROWS = 1000;
  const now = () => Date.now();

  const getMeId = () => {
    const m = document.cookie.match(/(?:^|;\s*)twid=u%3D(\d+)/);
    return m ? m[1] : null;
  };

  // ───────────────────────── 存储 ─────────────────────────
  // 每个登录账号单独一份：chrome.storage.local 的 key = xf_<你的用户ID>
  let meId = null;
  let key = null;
  let S = null;
  let loading = null;
  let saveTimer = null;
  const pending = [];

  const blank = () => ({
    v: 1,
    writer: TOKEN,
    me: {},
    meta: { installedAt: now(), firstScanDone: false, scan: null, lastScan: null },
    accounts: {},
    followers: {},
    queue: null,
    ui: null,
  });

  function ensureLoaded() {
    const id = getMeId();
    if (!id) return null;
    if (S && id === meId) return Promise.resolve(true);
    if (loading && id === meId) return loading;
    meId = id;
    key = 'xf_' + id;
    lkey = 'xfl_' + id;
    lastLists = { white: {}, black: {} };
    listsJson = '';
    S = null;
    loading = chrome.storage.local.get([key, lkey]).then((r) => {
      S = r[key] || blank();
      S.me = S.me || {};
      S.meta = S.meta || blank().meta;
      S.accounts = S.accounts || {};
      S.followers = S.followers || {};
      // 黑名单功能上线前就取关了的人：一次性放进黑名单
      if (!S.meta.blackInit) {
        for (const r of Object.values(S.accounts)) if (!r.following && !r.requestedAt && !r.black) r.black = r.unfollowedAt || now();
        S.meta.blackInit = true;
      }
      if (r[lkey]) {
        applyLists(r[lkey]);
        listsJson = JSON.stringify(collectLists());
      } else {
        // 名单单独存储之前的版本：从记录里取出来，存一份
        listsJson = '';
        saveLists();
      }
      if (S.ui) Object.assign(UI, S.ui);
      loading = null;
      pending.splice(0).forEach(handleMsg);
      render();
      return true;
    });
    return loading;
  }

  /** now = 立即写（引导进度变了用：紧接着可能整页刷新，延迟写会丢，刷新后又回到被跳过的人） */
  function save(immediate) {
    if (!S) return;
    saveLists();
    clearTimeout(saveTimer);
    const write = () => {
      S.writer = TOKEN;
      chrome.storage.local.set({ [key]: S }).catch(() => {});
    };
    if (immediate) write();
    else saveTimer = setTimeout(write, 400);
    scheduleRender();
  }

  // ── 白名单 / 黑名单单独存一个 key（xfl_<你的用户ID>），改了立即写。
  // 以前名单跟着整份数据一起存：开着多个 X 标签页时，别的标签页用它手里的旧数据整份覆盖，名单就丢了。
  // 现在只有名单真的变了的标签页才写名单；收到别的标签页的整份数据时，用最新名单覆盖回去。
  let lkey = null;
  let listsJson = '';
  let lastLists = { white: {}, black: {} };

  function collectLists() {
    const L = { white: {}, black: {} };
    // 别的标签页名单里有、这里还没有记录的人：原样保留
    const ids = new Set([...Object.keys(S.accounts), ...Object.keys(lastLists.white), ...Object.keys(lastLists.black)]);
    for (const id of Array.from(ids).sort()) {
      const r = S.accounts[id];
      const w = r ? r.white : lastLists.white[id];
      const b = r ? r.black : lastLists.black[id];
      if (w) L.white[id] = w;
      if (b) L.black[id] = b;
    }
    return L;
  }

  function applyLists(L) {
    const w = (L && L.white) || {};
    const b = (L && L.black) || {};
    lastLists = { white: w, black: b };
    for (const [id, r] of Object.entries(S.accounts)) {
      if (w[id]) r.white = w[id]; else delete r.white;
      if (b[id]) r.black = b[id]; else delete r.black;
    }
  }

  function saveLists() {
    if (!S || !lkey) return;
    const L = collectLists();
    const j = JSON.stringify(L);
    if (j === listsJson) return;
    listsJson = j;
    lastLists = L;
    chrome.storage.local.set({ [lkey]: { writer: TOKEN, ...L } }).catch(() => {});
  }

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area !== 'local' || !key) return;
    if (lkey && ch[lkey]) {
      const nv = ch[lkey].newValue;
      if (!nv && S) {
        applyLists(null);
        listsJson = JSON.stringify(collectLists());
        scheduleRender();
      } else if (nv && nv.writer !== TOKEN && S) {
        applyLists(nv);
        listsJson = JSON.stringify(collectLists());
        scheduleRender();
      }
    }
    if (!ch[key]) return;
    const nv = ch[key].newValue;
    if (!nv) {
      S = blank();
    } else if (nv.writer !== TOKEN) {
      // 别的标签页写入的：以它为准（引导队列只在发起的标签页里运行），名单以单独存的为准
      const q = S && S.queue;
      S = nv;
      S.accounts = S.accounts || {};
      applyLists(lastLists);
      if (q && G) S.queue = q;
    } else return;
    scheduleRender();
  });

  // ───────────────────────── 数据处理 ─────────────────────────
  const INFO_FIELDS = ['handle', 'name', 'avatar', 'followers', 'friends', 'verified', 'protected'];
  function mergeInfo(r, u, t) {
    for (const f of INFO_FIELDS) if (u[f] != null) r[f] = u[f];
    r.updatedAt = t;
  }

  // 白名单 r.white / 黑名单 r.black：记的是放进名单的时间。
  // 白名单：大 V 等不回关也正常的人，筛选结果里默认不显示。
  // 黑名单：你取关过的人，在 X 上再看到他们时把「关注」按钮标红提醒。
  /** 取关了：进黑名单。白名单不动：只有你自己点「移出名单」才会移出（X 偶尔返回错的关注状态，不能因此丢掉白名单） */
  function toBlack(r, t) {
    if (!r.black) r.black = t;
  }
  /** 又关注了（你自己决定的）：移出黑名单 */
  function offBlack(r) { delete r.black; }

  function newRecord(id, t) {
    const first = !S.meta.firstScanDone;
    return {
      id,
      following: true,
      followedBy: null,
      // 第一次完整扫描之前收集到的，都是安装插件前就关注的（时间未知）
      preInstall: first,
      firstSeenAt: first ? null : t,
      followedAt: null,
      unfollowedAt: null,
      requestedAt: null,
      lastSeenInList: null,
    };
  }

  function onUsers(d) {
    const t = now();
    let changed = false;
    const list = Array.isArray(d.list) ? d.list : [];
    const others = Array.isArray(d.others) ? d.others : [];
    const kind = d.op === 'Following' ? 'following' : /Followers$/.test(d.op || '') ? 'followers' : null;
    const mine = !!kind && d.owner === meId;

    for (const u of list.concat(others)) {
      if (u.id === meId) {
        S.me = { ...S.me, handle: u.handle ?? S.me.handle, name: u.name ?? S.me.name, followers: u.followers ?? S.me.followers, friends: u.friends ?? S.me.friends };
        changed = true;
      }
    }

    if (mine && kind === 'following') {
      for (const u of list) {
        if (u.id === meId) continue;
        let r = S.accounts[u.id];
        if (!r) {
          r = S.accounts[u.id] = newRecord(u.id, t);
        } else if (!r.following) {
          // 不是通过网页按钮关注的（比如手机上关注）：只知道“现在发现”
          r.following = true;
          r.followedAt = null;
          r.firstSeenAt = t;
          r.unfollowedAt = null;
          r.preInstall = false;
          offBlack(r);
        }
        mergeInfo(r, u, t);
        r.lastSeenInList = t;
        // 关注列表里对方没关注你时，这个字段可能不出现，按“没关注”算
        r.followedBy = u.followedBy != null ? !!u.followedBy : !!S.followers[u.id];
        changed = true;
      }
    }

    if (mine && kind === 'followers') {
      for (const u of list) {
        S.followers[u.id] = t;
        const r = S.accounts[u.id];
        if (r) { r.followedBy = true; mergeInfo(r, u, t); }
        changed = true;
      }
    }

    // 其它地方看到的用户：更新信息和关系（只认明确给出的 true / false）
    for (const u of mine ? others : list.concat(others)) {
      if (u.id === meId) continue;
      const r = S.accounts[u.id];
      if (r) {
        mergeInfo(r, u, t);
        if (u.followedBy != null) r.followedBy = !!u.followedBy;
        if (u.following === false && r.following) {
          r.following = false;
          r.unfollowedAt = t;
          toBlack(r, t);
        } else if (u.following === true && !r.following) {
          r.following = true;
          r.followedAt = null;
          r.firstSeenAt = t;
          r.unfollowedAt = null;
          r.preInstall = false;
          offBlack(r);
        }
        changed = true;
      } else if (u.following === true) {
        const n = (S.accounts[u.id] = newRecord(u.id, t));
        mergeInfo(n, u, t);
        n.followedBy = u.followedBy != null ? !!u.followedBy : null;
        changed = true;
      }
    }
    if (changed) save();
  }

  function onAction(d) {
    const u = d.user;
    if (!u || !u.id) return;
    const t = now();
    let r = S.accounts[u.id];
    if (!r) {
      r = S.accounts[u.id] = newRecord(u.id, t);
      r.preInstall = false;
      r.firstSeenAt = null;
    }
    mergeInfo(r, u, t);
    if (d.type === 'follow') {
      if (u.followRequestSent) {
        // 受保护账号：只是发了关注申请
        r.following = false;
        r.requestedAt = t;
      } else {
        r.following = true;
        r.followedAt = t;
        r.unfollowedAt = null;
        r.requestedAt = null;
        r.preInstall = false;
        offBlack(r);
      }
    } else {
      r.following = false;
      r.unfollowedAt = t;
      r.requestedAt = null;
      toBlack(r, t);
    }
    save();
  }

  /** 最近一次 X 返回的错误（显示在引导条 / 面板上） */
  let lastErr = null;
  const OP_NAME = {
    UserByScreenName: '打开主页',
    Following: '加载关注列表',
    Followers: '加载粉丝列表',
    'friendships/destroy': '取消关注',
    'friendships/create': '关注',
  };

  function onApiErr(d) {
    const t = now();
    const limited = d.status === 429;
    // x-rate-limit-reset 是秒级时间戳；没有就按 15 分钟算（X 的限流窗口）
    const until = limited ? (d.reset ? d.reset * 1000 : t + 15 * 60000) : null;
    lastErr = { ...d, at: t, until };
    const what = OP_NAME[d.op] || d.op;
    const msg = limited
      ? `X 暂时限制了「${what}」（HTTP 429 限流），${fmt(until).slice(11)} 后解除。这是 X 的频率限制，不是封号。`
      : `X 返回错误：「${what}」失败（HTTP ${d.status}${d.code ? `，错误码 ${d.code}` : ''}）`;
    const q = S.queue;
    if (q && G && !q.paused) {
      const unfollowFailed = d.op === 'friendships/destroy' || d.op === 'friendships/create';
      if (limited || unfollowFailed) {
        // 取关 / 关注被拒绝、或者主页被限流：暂停，限流的话到点自动继续
        pauseGuide(msg + (limited ? ' 到时间会自动继续。' : ' 已暂停，这一个没有成功。'), limited ? until + 5000 : null);
      }
    }
    if (auto && (d.op === 'Following' || /Followers$/.test(d.op)) && limited) {
      stopAuto(`${msg} 到 ${fmt(until).slice(11)} 以后再点「自动滚动到底」继续。`);
    }
    scheduleRender();
  }

  function handleMsg(d) {
    if (!S || getMeId() !== meId) {
      pending.push(d);
      if (pending.length > 500) pending.shift();
      ensureLoaded();
      return;
    }
    if (d.kind === 'users') onUsers(d);
    else if (d.kind === 'action') onAction(d);
    else if (d.kind === 'sample' && typeof d.raw === 'string') { S.meta.sample = { at: now(), raw: d.raw }; save(); }
    else if (d.kind === 'apierr') onApiErr(d);
  }

  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'xf-inject') return;
    handleMsg(e.data);
  });

  // ───────────────────────── 工具 ─────────────────────────
  const pad = (n) => String(n).padStart(2, '0');
  const fmt = (ms) => {
    if (!ms) return '';
    const d = new Date(ms);
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
  };
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = (n) => (n == null ? '-' : Number(n).toLocaleString());
  /** 粉丝数简写：1.2万 / 3,456 */
  const fans = (n) => (n >= 10000 ? `${(n / 10000).toFixed(n >= 100000 ? 0 : 1)}万` : Number(n).toLocaleString());
  /** 关注时间：通过网页按钮关注的是精确时间，其它是首次发现的时间，安装前的未知 */
  const timeOf = (r) => r.followedAt || r.firstSeenAt || null;

  // 每次跳转编号；兜底的整页跳转只对最新一次有效。
  // 以前点「跳过」后，上一个主页的兜底计时器还会触发，把页面又拉回被跳过的主页
  let navSeq = 0;
  let navTimer = null;
  function navigate(path) {
    const seq = ++navSeq;
    clearTimeout(navTimer);
    if (location.pathname.toLowerCase() === path.toLowerCase()) return;
    window.postMessage({ source: 'xf-content', kind: 'nav', path }, location.origin);
    const want = path.toLowerCase();
    navTimer = setTimeout(() => {
      if (seq === navSeq && location.pathname.toLowerCase() !== want) location.assign(path);
    }, 2500);
  }

  function myHandle() {
    if (S && S.me && S.me.handle) return S.me.handle;
    const a = document.querySelector('a[data-testid="AppTabBar_Profile_Link"]');
    const h = a && a.getAttribute('href');
    return h ? h.replace(/^\//, '').split('/')[0] : null;
  }

  // ───────────────────────── 筛选 ─────────────────────────
  const UI = {
    open: false,
    status: 'following', // following / unfollowed / all
    rel: 'all', // all / notback / mutual / unknown
    min: '',
    max: '',
    timeMode: 'any', // any / days / range
    days: '2',
    from: '',
    to: '',
    q: '',
    sort: 'time_desc',
    list: 'nowhite', // nowhite（不含白名单）/ all / white / black
  };
  const UI_KEYS = ['status', 'rel', 'min', 'max', 'timeMode', 'days', 'from', 'to', 'q', 'sort', 'list'];
  const sel = new Set();
  let flash = '';

  function filtered() {
    if (!S) return [];
    const q = UI.q.trim().toLowerCase().replace(/^@/, '');
    const min = UI.min === '' ? null : Number(UI.min);
    const max = UI.max === '' ? null : Number(UI.max);
    let tFrom = null;
    let tTo = null;
    if (UI.timeMode === 'days' && Number(UI.days) > 0) tFrom = now() - Number(UI.days) * DAY;
    if (UI.timeMode === 'range') {
      tFrom = UI.from ? new Date(UI.from).getTime() : null;
      tTo = UI.to ? new Date(UI.to).getTime() : null;
    }
    const out = Object.values(S.accounts).filter((r) => {
      if (UI.list === 'nowhite' && r.white) return false;
      if (UI.list === 'white' && !r.white) return false;
      if (UI.list === 'black' && !r.black) return false;
      if (UI.status === 'following' && !r.following) return false;
      if (UI.status === 'unfollowed' && r.following) return false;
      if (UI.rel === 'notback' && r.followedBy !== false) return false;
      if (UI.rel === 'mutual' && r.followedBy !== true) return false;
      if (UI.rel === 'unknown' && r.followedBy != null) return false;
      if (min != null && !Number.isNaN(min) && !(r.followers >= min)) return false;
      if (max != null && !Number.isNaN(max) && !(r.followers <= max)) return false;
      if (UI.timeMode !== 'any') {
        const t = timeOf(r);
        if (!t) return false;
        if (tFrom != null && t < tFrom) return false;
        if (tTo != null && t > tTo) return false;
      }
      if (q && !String(r.handle || '').toLowerCase().includes(q) && !String(r.name || '').toLowerCase().includes(q)) return false;
      return true;
    });
    const tKey = (r) => timeOf(r) || 0;
    const cmp = {
      time_desc: (a, b) => tKey(b) - tKey(a),
      time_asc: (a, b) => (tKey(a) || Infinity) - (tKey(b) || Infinity),
      fans_asc: (a, b) => (a.followers ?? Infinity) - (b.followers ?? Infinity),
      fans_desc: (a, b) => (b.followers ?? -1) - (a.followers ?? -1),
    }[UI.sort] || (() => 0);
    return out.sort(cmp);
  }

  // ───────────────────────── 扫描 ─────────────────────────
  function scanPath(type) {
    const h = myHandle();
    return h ? `/${h}/${type === 'following' ? 'following' : 'followers'}` : null;
  }

  function startScan(type) {
    const p = scanPath(type);
    if (!p) { alert('找不到你的用户名：请先打开一次自己的主页'); return; }
    S.meta.scan = { type, startedAt: now() };
    flash = '';
    save();
    navigate(p);
    // 打开列表后自动滚到底，一次扫描全部
    setTimeout(startAuto, 2500);
  }

  // ── 自动滚动：只是把页面滚到底，让 X 网页自己加载下一页（和你手动滚动发出的请求完全一样）。
  // 每次滚动之间随机等 1.5~3 秒，不点任何按钮；X 不再返回新数据（到底或被限流）时自动停下。
  let auto = null;
  const scanTotal = () => (S.meta.scan && S.meta.scan.type === 'followers' ? S.me.followers : S.me.friends);

  function startAuto() {
    if (!S || !S.meta.scan) return;
    stopAuto();
    auto = { timer: null, lastCount: scanSeen(), lastGrowAt: now(), msg: '自动滚动中…' };
    scheduleRender();
    stepAuto();
  }

  function stopAuto(msg) {
    if (auto && auto.timer) clearTimeout(auto.timer);
    auto = null;
    if (msg) flash = msg;
    scheduleRender();
  }

  function stepAuto() {
    if (!auto) return;
    if (!S || !S.meta.scan) return stopAuto();
    const next = (ms) => { auto.timer = setTimeout(stepAuto, ms); scheduleRender(); };
    const p = scanPath(S.meta.scan.type);
    if (p && location.pathname.toLowerCase() !== p.toLowerCase()) {
      auto.msg = '请停留在列表页面（已暂停自动滚动）';
      auto.lastGrowAt = now();
      return next(2000);
    }
    const c = scanSeen();
    if (c > auto.lastCount) { auto.lastCount = c; auto.lastGrowAt = now(); }
    const total = scanTotal();
    if (total && c >= total) {
      stopAuto();
      finishScan(true);
      return;
    }
    const stalled = now() - auto.lastGrowAt;
    if (stalled > 20000) {
      if (total && c >= total * 0.98) {
        stopAuto();
        finishScan(true);
      } else {
        stopAuto(
          `自动滚动已停在 ${num(c)}${total ? ` / ${num(total)}` : ''}：X 20 秒没有返回新数据。` +
          (total ? '可能被 X 暂时限流，等几分钟再点「自动滚动到底」继续；' : '') +
          '确认已经到底了就点「完成扫描」。',
        );
      }
      return;
    }
    auto.msg = `自动滚动中… 已收集 ${num(c)}${total ? ` / ${num(total)}` : ''}`;
    window.scrollTo(0, document.documentElement.scrollHeight);
    next(1500 + Math.random() * 1500);
  }

  function scanSeen() {
    const sc = S.meta.scan;
    if (!sc) return 0;
    if (sc.type === 'following') return Object.values(S.accounts).filter((r) => (r.lastSeenInList || 0) >= sc.startedAt).length;
    return Object.values(S.followers).filter((t) => t >= sc.startedAt).length;
  }

  /** silent = 自动滚动已经收集到总数的 98% 以上，不再弹窗确认 */
  function finishScan(silent) {
    const sc = S.meta.scan;
    if (!sc) return;
    if (!silent) stopAuto();
    const seen = scanSeen();
    const total = sc.type === 'following' ? S.me.friends : S.me.followers;
    if (sc.type === 'following') {
      const missing = Object.values(S.accounts).filter((r) => r.following && (r.lastSeenInList || 0) < sc.startedAt);
      if (missing.length && S.meta.firstScanDone) {
        const ok = silent || confirm(
          `本次收集到 ${seen} 个，你的关注总数 ${total ?? '未知'}。\n` +
          `有 ${missing.length} 个之前记录为“正在关注”，这次没看到。\n\n` +
          `已经滚到底了：点「确定」，把它们标记为已取关。\n还没滚到底：点「取消」，继续往下滚。`,
        );
        if (!ok) return;
        for (const r of missing) { r.following = false; r.unfollowedAt = r.unfollowedAt || null; toBlack(r, now()); }
      }
      if (seen > 0) S.meta.firstScanDone = true;
    } else {
      const ok = silent || confirm(
        `本次收集到 ${seen} 个粉丝，你的粉丝总数 ${total ?? '未知'}。\n\n` +
        `已经滚到底了：点「确定」，用这次结果更新“是否回关”（没出现在粉丝列表里的记为未回关）。\n还没滚到底：点「取消」，继续往下滚。`,
      );
      if (!ok) return;
      for (const r of Object.values(S.accounts)) r.followedBy = (S.followers[r.id] || 0) >= sc.startedAt;
    }
    S.meta.lastScan = { type: sc.type, at: now(), seen };
    S.meta.scan = null;
    flash = `扫描完成：${sc.type === 'following' ? '关注' : '粉丝'}列表收集到 ${num(seen)} 个`;
    save();
  }

  // ───────────────────────── 引导取关 / 关注 ─────────────────────────
  // 运行时状态（不保存）：当前这一步打开主页的时间、是否已经看到目标按钮
  let G = null;
  let guideTimer = null;

  const current = () => {
    const q = S && S.queue;
    if (!q || q.index >= q.ids.length) return null;
    return S.accounts[q.ids[q.index]] || { id: q.ids[q.index], handle: null };
  };

  function startGuide(type) {
    const rows = filtered().filter((r) => sel.has(r.id) && (type === 'unfollow' ? r.following : !r.following));
    if (!rows.length) {
      alert(type === 'unfollow' ? '选中的人里没有“正在关注”的' : '选中的人里没有“未关注”的（状态选「已取关」可以看到之前取关的人）');
      return;
    }
    if (type === 'follow') {
      const nb = rows.filter((r) => r.black).length;
      if (nb && !confirm(`选中的人里有 ${nb} 个在黑名单里（你取关过）。\n确定要重新关注他们吗？关注后会移出黑名单。`)) return;
    }
    S.queue = { type, ids: rows.map((r) => r.id), index: 0, done: 0, skipped: 0, paused: false, startedAt: now() };
    flash = '';
    UI.open = false;
    save();
    stepStart();
  }

  function stepStart() {
    const q = S && S.queue;
    if (!q) return;
    clearStepTimer();
    const r = current();
    if (!r) return finishGuide();
    G = { navAt: now(), seenTarget: false, finished: false, scrolled: false, hint: '正在打开主页…' };
    if (!r.handle) { G.hint = '没有这个人的用户名，点「跳过」'; renderGuide(); return; }
    navigate('/' + r.handle);
    if (!guideTimer) guideTimer = setInterval(tick, 250);
    renderGuide();
  }

  /** X 的出错页：主栏里只有「Something went wrong」和 Retry 按钮 */
  function errorPageShown() {
    const col = document.querySelector('[data-testid="primaryColumn"]');
    if (!col) return false;
    const btn = Array.from(col.querySelectorAll('button, [role="button"]')).some((b) => /^(Retry|重试)$/i.test((b.textContent || '').trim()));
    return btn && /Something went wrong|出错了|发生错误/i.test(col.textContent || '');
  }

  const visible = (el) => el && el.getClientRects().length > 0;
  const findBtn = (selector) => Array.from(document.querySelectorAll(selector)).find(visible) || null;

  function tick() {
    const q = S && S.queue;
    if (!q) { stopTimer(); hideHL(); return; }
    if (q.paused || !G || G.finished) { hideHL(); return; }
    const r = current();
    if (!r) return finishGuide();
    const id = r.id;
    const unf = findBtn(`[data-testid="${id}-unfollow"]`);
    const fol = findBtn(`[data-testid="${id}-follow"]`);
    const cancel = findBtn(`[data-testid="${id}-cancel"]`);
    const confirmBtn = findBtn('[data-testid="confirmationSheetConfirm"]');
    let target = null;
    let hint = '';
    if (q.type === 'unfollow') {
      if (confirmBtn && G.seenTarget) { target = confirmBtn; hint = '点高亮的「取消关注」确认'; }
      else if (unf) { target = unf; G.seenTarget = true; hint = '点高亮的「正在关注」按钮'; }
      else if (fol || cancel) return stepDone(G.seenTarget);
    } else {
      if (unf || cancel) return stepDone(G.seenTarget);
      if (fol) { target = fol; G.seenTarget = true; hint = '点高亮的「关注」按钮'; }
    }
    if (!target && errorPageShown()) {
      // X 显示了「Something went wrong. Try reloading.」：不点它的 Retry，自己整页刷新一次；
      // 刷新后还是这样，就暂停让你决定（多半是被限流，过一会儿再继续）
      if (lastErr && lastErr.status === 429 && now() - lastErr.at < 60000) return; // onApiErr 已经处理（暂停 + 到点继续）
      if (q.reloadedFor !== id) {
        q.reloadedFor = id;
        save();
        G.finished = true;
        const g = G;
        stepTimer = setTimeout(() => { if (G === g) location.reload(); }, 800);
        G.hint = 'X 页面出错，正在刷新重试…';
        renderGuide();
        return;
      }
      pauseGuide(
        'X 打不开这个主页（刷新后仍显示 Something went wrong）。' +
          (lastErr ? `最近一次错误：${OP_NAME[lastErr.op] || lastErr.op} HTTP ${lastErr.status}。` : '') +
          '多半是短时间打开主页太多被 X 限流，等 10~15 分钟点「继续」，或点「跳过」。',
        null,
      );
      return;
    }
    if (!target) hint = now() - G.navAt > 10000 ? '找不到按钮：账号可能已注销、被封或改了用户名。点「跳过」' : '正在打开主页…';
    if (target && !G.scrolled) {
      const b = target.getBoundingClientRect();
      if (b.top < 0 || b.bottom > innerHeight) target.scrollIntoView({ block: 'center' });
      G.scrolled = true;
    }
    showHL(target);
    if (hint !== G.hint) { G.hint = hint; renderGuide(); }
  }

  /** acted = 这一步你点了按钮；false = 打开时已经是目标状态 */
  function stepDone(acted) {
    const q = S.queue;
    const r = S.accounts[current().id];
    G.finished = true;
    hideHL();
    const t = now();
    if (r) {
      if (q.type === 'unfollow' && r.following) {
        r.following = false;
        r.unfollowedAt = acted ? t : r.unfollowedAt || null;
        toBlack(r, t);
      }
      if (q.type === 'follow' && !r.following) {
        r.following = true;
        r.unfollowedAt = null;
        r.preInstall = false;
        offBlack(r);
        // 正常情况下 inject.js 已经按 X 的返回记了精确时间；这里是兜底
        if (acted && (!r.followedAt || t - r.followedAt > 60000)) r.followedAt = t;
      }
    }
    q.done++;
    q.index++;
    if (r) sel.delete(r.id);
    save(true);
    const g = G;
    g.advanced = true;
    clearStepTimer();
    stepTimer = setTimeout(() => { if (G === g && S && S.queue === q && !q.paused) stepStart(); }, acted ? 600 : 150);
  }

  /** 当前这一步挂着的计时器（完成后跳下一个 / 出错刷新）；换步、跳过、暂停、结束时取消 */
  let stepTimer = null;
  function clearStepTimer() {
    clearTimeout(stepTimer);
    stepTimer = null;
  }
  /** 暂停 / 结束：取消待跳下一个、待刷新、跳转兜底，免得停下后页面还自己跳走 */
  function cancelPending() {
    clearStepTimer();
    navSeq++;
    clearTimeout(navTimer);
  }

  function skipStep() {
    const q = S && S.queue;
    if (!q) return;
    // 这一步已经完成、正在等着跳下一个：下标已经加过了，「跳过」就是立刻去下一个，不能再加一次
    if (G && G.advanced && stepTimer) {
      stepStart();
      return;
    }
    q.skipped++;
    q.index++;
    save(true);
    stepStart();
  }

  let resumeTimer = null;
  /** 暂停引导；resumeAt 给了就到时间自动继续（被限流时） */
  function pauseGuide(reason, resumeAt) {
    const q = S && S.queue;
    if (!q) return;
    q.paused = true;
    q.pauseReason = reason;
    q.resumeAt = resumeAt || null;
    clearTimeout(resumeTimer);
    cancelPending();
    if (resumeAt) resumeTimer = setTimeout(() => { if (S && S.queue === q && q.paused) togglePause(); }, Math.max(1000, resumeAt - now()));
    hideHL();
    save();
    renderGuide();
  }

  function togglePause() {
    const q = S && S.queue;
    if (!q) return;
    if (q.paused) {
      q.paused = false;
      q.pauseReason = null;
      q.resumeAt = null;
      q.reloadedFor = null;
      clearTimeout(resumeTimer);
      save();
      stepStart();
    } else {
      pauseGuide('已暂停', null);
    }
  }

  function stopTimer() {
    if (guideTimer) clearInterval(guideTimer);
    guideTimer = null;
  }

  function finishGuide(stopped) {
    const q = S && S.queue;
    if (q) flash = `${stopped ? '已结束' : '全部完成'}：${q.type === 'unfollow' ? '取关' : '关注'} ${q.done} 个，跳过 ${q.skipped} 个${stopped ? `，剩 ${q.ids.length - q.index} 个没处理` : ''}`;
    S.queue = null;
    G = null;
    cancelPending();
    stopTimer();
    hideHL();
    UI.open = true;
    save();
  }

  // ── 高亮层：画在 X 页面最上层，不拦截点击 ──
  let hlEl = null;
  let hlTarget = null;
  let hlRaf = null;
  function showHL(t) {
    hlTarget = t;
    if (!t) { if (hlEl) hlEl.style.display = 'none'; return; }
    if (!hlEl) {
      hlEl = document.createElement('div');
      Object.assign(hlEl.style, {
        position: 'fixed',
        zIndex: '2147483646',
        pointerEvents: 'none',
        border: '3px solid #f97316',
        borderRadius: '9999px',
        boxShadow: '0 0 0 4px rgba(249,115,22,.35), 0 0 22px rgba(249,115,22,.9)',
        display: 'none',
      });
      document.documentElement.appendChild(hlEl);
    }
    if (hlRaf == null) loopHL();
  }
  function loopHL() {
    hlRaf = requestAnimationFrame(() => {
      hlRaf = null;
      if (!hlTarget || !hlTarget.isConnected) { if (hlEl) hlEl.style.display = 'none'; return; }
      const b = hlTarget.getBoundingClientRect();
      Object.assign(hlEl.style, { display: 'block', left: `${b.left - 6}px`, top: `${b.top - 6}px`, width: `${b.width + 12}px`, height: `${b.height + 12}px` });
      loopHL();
    });
  }
  function hideHL() { showHL(null); }

  // ── 黑名单提醒：X 页面上任何地方出现黑名单里的人的「关注」按钮（主页、推荐关注、悬浮卡片、列表），
  // 给按钮加红框；打开他们的主页时顶部显示红色提示。只改样式，不点按钮。
  const MARK = 'data-xf-black';
  let warnFor = null;
  function markBlack() {
    if (!S || !root) return;
    for (const el of document.querySelectorAll('[data-testid$="-follow"]')) {
      const m = /^(\d+)-follow$/.exec(el.getAttribute('data-testid') || '');
      const r = m && S.accounts[m[1]];
      if (r && r.black) {
        if (!el.hasAttribute(MARK)) {
          el.setAttribute(MARK, '1');
          el.style.outline = '3px solid #f4212e';
          el.style.outlineOffset = '2px';
          el.title = `黑名单：你 ${r.unfollowedAt ? fmt(r.unfollowedAt) + ' ' : ''}取关过 @${r.handle || r.id}`;
        }
      } else if (el.hasAttribute(MARK)) {
        el.removeAttribute(MARK);
        el.style.outline = '';
        el.style.outlineOffset = '';
        el.title = '';
      }
    }
    // 当前页面是不是黑名单里某人的主页
    const seg = location.pathname.split('/')[1];
    const h = seg ? seg.toLowerCase() : '';
    let hit = null;
    if (h) for (const r of Object.values(S.accounts)) if (r.black && r.handle && r.handle.toLowerCase() === h) { hit = r; break; }
    if ((hit && hit.id) !== (warnFor && warnFor.id)) { warnFor = hit; renderWarn(); }
  }

  function renderWarn() {
    if (!root) return;
    const el = root.getElementById('warn');
    const r = warnFor;
    if (!r) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.innerHTML =
      `<b>黑名单</b>：@${esc(r.handle || r.id)} 你${r.unfollowedAt ? ` ${esc(fmt(r.unfollowedAt))} ` : '之前'}取关过，别再关注。` +
      ` <button class="b" data-a="unblack">移出黑名单</button>`;
  }

  // ───────────────────────── 界面 ─────────────────────────
  let root = null;
  let renderQueued = false;
  const scheduleRender = () => {
    if (renderQueued) return;
    renderQueued = true;
    requestAnimationFrame(() => { renderQueued = false; render(); });
  };

  const CSS = `
  :host { all: initial; }
  * { box-sizing: border-box; font-family: -apple-system, "Segoe UI", "PingFang SC", "Microsoft YaHei", sans-serif; }
  .fab { position: fixed; right: 0; top: 42%; z-index: 2147483645; writing-mode: vertical-rl; padding: 12px 6px; background: #1d9bf0; color: #fff; font-size: 13px; border-radius: 8px 0 0 8px; cursor: pointer; box-shadow: 0 2px 8px rgba(0,0,0,.2); user-select: none; }
  .fab:hover { background: #1a8cd8; }
  .panel { position: fixed; right: 12px; top: 12px; bottom: 12px; width: 560px; max-width: calc(100vw - 24px); z-index: 2147483645; background: #fff; color: #0f1419; border: 1px solid #cfd9de; border-radius: 14px; box-shadow: 0 8px 32px rgba(0,0,0,.18); display: flex; flex-direction: column; font-size: 13px; overflow: hidden; }
  .hidden { display: none !important; }
  .hd { display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid #eff3f4; }
  .hd b { font-size: 15px; }
  .x { cursor: pointer; border: 0; background: none; font-size: 18px; color: #536471; }
  .sec { padding: 8px 14px; border-bottom: 1px solid #eff3f4; }
  .muted { color: #536471; font-size: 12px; }
  .row { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; margin: 4px 0; }
  .row label { display: flex; align-items: center; gap: 4px; }
  select, input[type=text], input[type=number], input[type=datetime-local] { border: 1px solid #cfd9de; border-radius: 6px; padding: 3px 6px; font-size: 12px; color: #0f1419; background: #fff; }
  input[type=number] { width: 84px; }
  button.b { border: 1px solid #cfd9de; background: #fff; border-radius: 9999px; padding: 4px 12px; font-size: 12px; cursor: pointer; color: #0f1419; }
  button.b:hover { background: #f7f9f9; }
  button.p { background: #0f1419; color: #fff; border-color: #0f1419; }
  button.p:hover { background: #272c30; }
  button.r { background: #f4212e; color: #fff; border-color: #f4212e; }
  button.r:hover { background: #dc1e29; }
  button:disabled { opacity: .45; cursor: default; }
  .stats span { margin-right: 10px; }
  .flash { background: #e8f5fd; color: #0f1419; padding: 6px 10px; border-radius: 8px; margin-top: 4px; }
  .list { flex: 1; overflow: auto; }
  table { width: 100%; border-collapse: collapse; }
  th { position: sticky; top: 0; background: #f7f9f9; text-align: left; font-weight: 600; font-size: 12px; padding: 6px; border-bottom: 1px solid #eff3f4; z-index: 1; }
  td { padding: 5px 6px; border-bottom: 1px solid #eff3f4; vertical-align: middle; font-size: 12px; }
  tr.it { cursor: pointer; }
  tr.it:hover td { background: #f7f9f9; }
  tr.on td { background: #e8f5fd; }
  .u { display: flex; align-items: center; gap: 8px; min-width: 0; }
  .u img { width: 28px; height: 28px; border-radius: 50%; flex: none; background: #eff3f4; }
  .u .n { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 170px; }
  .u a { color: #536471; text-decoration: none; }
  .u a:hover { text-decoration: underline; }
  .u .fans { color: #0f1419; font-weight: 600; }
  .tag { display: inline-block; padding: 1px 6px; border-radius: 4px; font-size: 11px; }
  .t-no { background: #fdecee; color: #c0141f; }
  .t-yes { background: #e6f6ec; color: #067d38; }
  .t-unk { background: #eff3f4; color: #536471; }
  .num { text-align: right; font-variant-numeric: tabular-nums; }
  .guide { position: fixed; left: 50%; bottom: 20px; transform: translateX(-50%); z-index: 2147483647; background: #0f1419; color: #fff; border-radius: 14px; padding: 10px 14px; min-width: 460px; max-width: calc(100vw - 24px); box-shadow: 0 8px 28px rgba(0,0,0,.35); font-size: 13px; }
  .guide .who { font-weight: 600; }
  .guide .hint { color: #fbbf24; margin: 4px 0 8px; font-size: 14px; }
  .guide button.b { background: transparent; color: #fff; border-color: #536471; }
  .guide button.b:hover { background: #272c30; }
  .warn { position: fixed; left: 50%; top: 10px; transform: translateX(-50%); z-index: 2147483647; background: #f4212e; color: #fff; border-radius: 10px; padding: 8px 14px; font-size: 14px; box-shadow: 0 6px 20px rgba(0,0,0,.3); }
  .warn button.b { background: transparent; color: #fff; border-color: #fff; margin-left: 8px; }
  .warn button.b:hover { background: rgba(255,255,255,.15); }
  .t-white { background: #fff7e0; color: #8a5a00; }
  .t-black { background: #0f1419; color: #fff; }
  .bar { height: 4px; background: #333; border-radius: 2px; overflow: hidden; margin-top: 8px; }
  .bar i { display: block; height: 100%; background: #1d9bf0; }
  `;

  function buildUI() {
    if (root || !document.body) return;
    const host = document.createElement('div');
    host.id = 'xf-root';
    document.documentElement.appendChild(host);
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
      <style>${CSS}</style>
      <div class="fab" id="fab">关注管理</div>
      <div class="panel hidden" id="panel">
        <div class="hd"><b>X 关注管理</b><button class="x" id="close" title="关闭">×</button></div>
        <div class="sec">
          <div class="stats" id="stats"></div>
          <div class="muted" id="scanInfo" style="margin-top:4px"></div>
          <div class="row" id="scanBtns">
            <button class="b" id="scanFollowing">扫描关注列表</button>
            <button class="b" id="scanFollowers" title="可选：滚一遍粉丝列表，回关判断更准">扫描粉丝列表</button>
            <button class="b hidden" id="scanAuto">自动滚动到底</button>
            <button class="b p hidden" id="scanDone">完成扫描</button>
            <button class="b hidden" id="scanCancel">取消扫描</button>
          </div>
          <div id="flash"></div>
        </div>
        <div class="sec">
          <div class="row">
            <label>状态 <select id="f-status">
              <option value="following">正在关注</option>
              <option value="unfollowed">已取关</option>
              <option value="all">全部</option>
            </select></label>
            <label>关系 <select id="f-rel">
              <option value="all">全部</option>
              <option value="notback">没有回关我</option>
              <option value="mutual">互相关注</option>
              <option value="unknown">未知</option>
            </select></label>
            <label>排序 <select id="f-sort">
              <option value="time_desc">关注时间 新→旧</option>
              <option value="time_asc">关注时间 旧→新</option>
              <option value="fans_asc">粉丝数 少→多</option>
              <option value="fans_desc">粉丝数 多→少</option>
            </select></label>
            <label>名单 <select id="f-list">
              <option value="nowhite">不含白名单</option>
              <option value="all">全部</option>
              <option value="white">只看白名单</option>
              <option value="black">只看黑名单</option>
            </select></label>
          </div>
          <div class="row">
            <label>粉丝数 <input type="number" id="f-min" min="0" placeholder="最少"> ~ <input type="number" id="f-max" min="0" placeholder="最多"></label>
            <label>搜索 <input type="text" id="f-q" placeholder="名字或 @用户名" style="width:130px"></label>
          </div>
          <div class="row">
            <label>关注时间 <select id="f-time">
              <option value="any">不限</option>
              <option value="days">最近 N 天</option>
              <option value="range">自定义起止</option>
            </select></label>
            <span id="t-days"><input type="number" id="f-days" min="0" step="0.5" style="width:64px"> 天内</span>
            <span id="t-range"><input type="datetime-local" id="f-from"> ~ <input type="datetime-local" id="f-to"></span>
          </div>
          <div class="muted" id="timeNote"></div>
        </div>
        <div class="sec">
          <div class="row">
            <button class="b" id="selAll">全选</button>
            <button class="b" id="selNone">全不选</button>
            <span id="selInfo" class="muted"></span>
          </div>
          <div class="row">
            <button class="b" id="addWhite" title="大 V 等不回关也正常的人：以后筛选结果里不再显示">加入白名单</button>
            <button class="b" id="rmList" title="把选中的人移出白名单 / 黑名单">移出名单</button>
            <span style="flex:1"></span>
            <button class="b r" id="doUnfollow">逐个取关</button>
            <button class="b p" id="doFollow">逐个关注</button>
          </div>
        </div>
        <div class="list" id="list"></div>
        <div class="sec muted" style="display:flex;justify-content:space-between;border-bottom:0">
          <span>只读取你浏览时网页已加载的数据；取关 / 关注由你亲手点 X 的按钮</span>
          <span><a href="#" id="diag" style="color:#536471;margin-right:10px" title="粉丝数等显示不出来时，复制一条关注列表的原始数据发给开发者">复制诊断数据</a><a href="#" id="clear" style="color:#f4212e">清空数据</a></span>
        </div>
      </div>
      <div class="guide hidden" id="guide"></div>
      <div class="warn hidden" id="warn"></div>
    `;
    const $ = (id) => root.getElementById(id);
    $('fab').onclick = () => { UI.open = !UI.open; render(); };
    $('close').onclick = () => { UI.open = false; render(); };
    $('scanFollowing').onclick = () => S && startScan('following');
    $('scanFollowers').onclick = () => S && startScan('followers');
    $('scanDone').onclick = () => S && finishScan();
    $('scanCancel').onclick = () => { stopAuto(); if (S) { S.meta.scan = null; save(); } };
    $('scanAuto').onclick = () => {
      if (!S || !S.meta.scan) return;
      if (auto) { stopAuto('已停止自动滚动'); return; }
      flash = '';
      const p = scanPath(S.meta.scan.type);
      if (p && location.pathname.toLowerCase() !== p.toLowerCase()) { navigate(p); setTimeout(startAuto, 2500); }
      else startAuto();
    };
    const bind = (id, k) => {
      const el = $(id);
      const on = () => {
        UI[k] = el.value;
        if (S) { S.ui = Object.fromEntries(UI_KEYS.map((x) => [x, UI[x]])); save(); }
        render();
      };
      el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', on);
    };
    bind('f-status', 'status');
    bind('f-rel', 'rel');
    bind('f-sort', 'sort');
    bind('f-list', 'list');
    bind('f-min', 'min');
    bind('f-max', 'max');
    bind('f-q', 'q');
    bind('f-time', 'timeMode');
    bind('f-days', 'days');
    bind('f-from', 'from');
    bind('f-to', 'to');
    $('selAll').onclick = () => { filtered().forEach((r) => sel.add(r.id)); render(); };
    $('selNone').onclick = () => { sel.clear(); render(); };
    $('doUnfollow').onclick = () => S && startGuide('unfollow');
    $('doFollow').onclick = () => S && startGuide('follow');
    const selected = () => filtered().filter((r) => sel.has(r.id));
    $('addWhite').onclick = () => {
      if (!S) return;
      const rows = selected().filter((r) => !r.white);
      if (!rows.length) return;
      const t = now();
      for (const r of rows) { r.white = t; sel.delete(r.id); }
      flash = `已把 ${rows.length} 个加入白名单，以后筛选结果里不再显示（名单选「只看白名单」可以找回）`;
      save();
    };
    $('rmList').onclick = () => {
      if (!S) return;
      const rows = selected().filter((r) => r.white || r.black);
      if (!rows.length) return;
      for (const r of rows) { delete r.white; delete r.black; sel.delete(r.id); }
      flash = `已把 ${rows.length} 个移出白名单 / 黑名单`;
      save();
    };
    $('warn').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b || b.dataset.a !== 'unblack' || !warnFor) return;
      const r = S && S.accounts[warnFor.id];
      if (r) { delete r.black; save(); }
      warnFor = null;
      markBlack();
      renderWarn();
    });
    $('diag').onclick = async (e) => {
      e.preventDefault();
      const s = S && S.meta.sample;
      if (!s) { alert('还没有诊断数据：先打开一次自己的关注列表'); return; }
      try {
        await navigator.clipboard.writeText(s.raw);
        flash = `已复制关注列表里一个账号的原始数据（${fmt(s.at)}），可以粘贴发给开发者`;
      } catch (_) {
        flash = '复制失败：请先点一下页面再试';
      }
      render();
    };
    $('clear').onclick = (e) => {
      e.preventDefault();
      if (!S || !confirm('清空这个账号的全部记录（包括关注时间）？清空后不能恢复。')) return;
      chrome.storage.local.remove([key, lkey]);
      S = blank();
      lastLists = { white: {}, black: {} };
      listsJson = JSON.stringify(lastLists);
      sel.clear();
      render();
    };
    $('list').addEventListener('click', (e) => {
      if (e.target.closest('a')) return;
      const tr = e.target.closest('tr');
      if (!tr) return;
      if (tr.dataset.all) {
        const rows = filtered();
        const allOn = rows.length > 0 && rows.every((r) => sel.has(r.id));
        rows.forEach((r) => (allOn ? sel.delete(r.id) : sel.add(r.id)));
      } else if (tr.dataset.id) {
        const id = tr.dataset.id;
        if (sel.has(id)) sel.delete(id); else sel.add(id);
      }
      render();
    });
    $('guide').addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.a === 'skip') skipStep();
      else if (b.dataset.a === 'pause') togglePause();
      else if (b.dataset.a === 'stop') finishGuide(true);
      else if (b.dataset.a === 'panel') { UI.open = !UI.open; render(); }
    });
  }

  function timeCell(r) {
    if (r.followedAt) return esc(fmt(r.followedAt));
    if (r.firstSeenAt) return `${esc(fmt(r.firstSeenAt))}<br><span class="muted">首次发现</span>`;
    if (r.preInstall) return '<span class="muted">安装前已关注</span>';
    return '<span class="muted">未知</span>';
  }

  function render() {
    buildUI();
    if (!root) return;
    const $ = (id) => root.getElementById(id);
    const panel = $('panel');
    panel.classList.toggle('hidden', !UI.open);
    renderGuide();
    if (!UI.open) return;

    if (!S) {
      $('stats').textContent = getMeId() ? '加载中…' : '请先登录 X';
      $('list').innerHTML = '';
      return;
    }

    for (const [id, k] of [['f-status', 'status'], ['f-rel', 'rel'], ['f-sort', 'sort'], ['f-list', 'list'], ['f-min', 'min'], ['f-max', 'max'], ['f-q', 'q'], ['f-time', 'timeMode'], ['f-days', 'days'], ['f-from', 'from'], ['f-to', 'to']]) {
      const el = $(id);
      if (root.activeElement !== el && el.value !== UI[k]) el.value = UI[k];
    }
    $('t-days').classList.toggle('hidden', UI.timeMode !== 'days');
    $('t-range').classList.toggle('hidden', UI.timeMode !== 'range');
    $('timeNote').textContent = UI.timeMode === 'any' ? '' : '按关注时间筛选时，“安装前已关注”的人（时间未知）不会出现';

    const all = Object.values(S.accounts);
    const fing = all.filter((r) => r.following);
    $('stats').innerHTML =
      `<span>正在关注 <b>${num(fing.length)}</b>${S.me.friends != null ? ` / ${num(S.me.friends)}` : ''}</span>` +
      `<span title="不含白名单">没回关 <b style="color:#c0141f">${num(fing.filter((r) => r.followedBy === false && !r.white).length)}</b></span>` +
      `<span>互关 <b>${num(fing.filter((r) => r.followedBy === true).length)}</b></span>` +
      `<span>已取关 ${num(all.length - fing.length)}</span>` +
      `<span>白名单 ${num(all.filter((r) => r.white).length)}</span>` +
      `<span>黑名单 ${num(all.filter((r) => r.black).length)}</span>`;

    const sc = S.meta.scan;
    if (sc) {
      const total = sc.type === 'following' ? S.me.friends : S.me.followers;
      $('scanInfo').innerHTML =
        `正在扫描${sc.type === 'following' ? '关注' : '粉丝'}列表：已收集 <b>${num(scanSeen())}</b>${total != null ? ` / ${num(total)}` : ''}。` +
        (auto ? `<br><b>${esc(auto.msg)}</b>（收集到全部后自动完成）` : '自动滚动没在运行：点「自动滚动到底」，或者自己往下滚，到底后点「完成扫描」。');
    } else if (!S.meta.firstScanDone) {
      $('scanInfo').textContent = '第一次使用：点「扫描关注列表」，把关注列表滚到底。之后新关注的人会自动记录时间。';
    } else {
      const ls = S.meta.lastScan;
      $('scanInfo').textContent = ls ? `上次扫描：${fmt(ls.at)}（${ls.type === 'following' ? '关注' : '粉丝'}列表 ${num(ls.seen)} 个）` : '';
    }
    $('scanFollowing').classList.toggle('hidden', !!sc);
    $('scanFollowers').classList.toggle('hidden', !!sc);
    $('scanDone').classList.toggle('hidden', !sc);
    $('scanAuto').classList.toggle('hidden', !sc);
    $('scanAuto').textContent = auto ? '停止自动滚动' : '自动滚动到底';
    $('scanCancel').classList.toggle('hidden', !sc);
    $('flash').innerHTML = flash ? `<div class="flash">${esc(flash)}</div>` : '';

    const rows = filtered();
    for (const id of Array.from(sel)) if (!S.accounts[id]) sel.delete(id);
    const selRows = rows.filter((r) => sel.has(r.id));
    const nUnf = selRows.filter((r) => r.following).length;
    const nFol = selRows.filter((r) => !r.following).length;
    $('selInfo').textContent = `筛选出 ${num(rows.length)} 个，已选 ${num(selRows.length)} 个`;
    $('doUnfollow').textContent = `逐个取关 (${nUnf})`;
    $('doFollow').textContent = `逐个关注 (${nFol})`;
    $('doUnfollow').disabled = !nUnf || !!S.queue;
    $('doFollow').disabled = !nFol || !!S.queue;
    const nWhite = selRows.filter((r) => !r.white).length;
    const nList = selRows.filter((r) => r.white || r.black).length;
    $('addWhite').textContent = `加入白名单 (${nWhite})`;
    $('addWhite').disabled = !nWhite;
    $('rmList').textContent = `移出名单 (${nList})`;
    $('rmList').classList.toggle('hidden', !nList);

    const allOn = rows.length > 0 && rows.every((r) => sel.has(r.id));
    const shown = rows.slice(0, MAX_ROWS);
    const rel = (r) => (r.followedBy === true ? '<span class="tag t-yes">互关</span>' : r.followedBy === false ? '<span class="tag t-no">没回关</span>' : '<span class="tag t-unk">未知</span>');
    const status = (r) => (r.following ? '' : `<br><span class="muted">${r.requestedAt ? '已申请关注' : '已取关'}${r.unfollowedAt ? ' ' + esc(fmt(r.unfollowedAt)) : ''}</span>`);
    $('list').innerHTML =
      `<table><thead><tr data-all="1" class="it"><th style="width:28px"><input type="checkbox" ${allOn ? 'checked' : ''}></th><th>账号</th><th class="num">粉丝数</th><th>回关</th><th>关注时间</th></tr></thead><tbody>` +
      shown
        .map(
          (r) =>
            `<tr class="it${sel.has(r.id) ? ' on' : ''}" data-id="${esc(r.id)}">` +
            `<td><input type="checkbox" ${sel.has(r.id) ? 'checked' : ''}></td>` +
            `<td><div class="u">${r.avatar ? `<img src="${esc(r.avatar)}" loading="lazy">` : '<img>'}<div style="min-width:0"><div class="n">${esc(r.name || '')}` +
            `${r.white ? ' <span class="tag t-white">白名单</span>' : ''}${r.black ? ' <span class="tag t-black">黑名单</span>' : ''}</div>` +
            `<a href="https://x.com/${esc(r.handle || '')}" target="_blank" rel="noopener">@${esc(r.handle || r.id)}</a>` +
            `<span class="fans"> · ${r.followers != null ? `${esc(fans(r.followers))} 粉丝` : '粉丝数未知'}</span>${status(r)}</div></div></td>` +
            `<td class="num">${num(r.followers)}</td><td>${rel(r)}</td><td>${timeCell(r)}</td></tr>`,
        )
        .join('') +
      `</tbody></table>` +
      (rows.length > MAX_ROWS ? `<div class="sec muted">只显示前 ${MAX_ROWS} 个，可以缩小筛选范围；「全选」会选中全部 ${num(rows.length)} 个。</div>` : '') +
      (!rows.length ? `<div class="sec muted">${all.length ? '没有符合条件的账号' : '还没有数据：先点上面的「扫描关注列表」'}</div>` : '');
  }

  function renderGuide() {
    if (!root) return;
    const el = root.getElementById('guide');
    const q = S && S.queue;
    if (!q) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    const r = current();
    const verb = q.type === 'unfollow' ? '取关' : '关注';
    const pct = q.ids.length ? Math.round((q.index / q.ids.length) * 100) : 0;
    el.innerHTML =
      `<div>${verb} 第 <b>${Math.min(q.index + 1, q.ids.length)}</b> / ${q.ids.length} 个 · ` +
      `<span class="who">${esc(r && r.name ? r.name : '')} @${esc(r && r.handle ? r.handle : '')}</span> · 粉丝 ${num(r && r.followers)}</div>` +
      `<div class="hint">${q.paused ? esc(q.pauseReason || '已暂停') : esc((G && G.hint) || '')}</div>` +
      `<div class="row">` +
      `<button class="b" data-a="skip">跳过</button>` +
      `<button class="b" data-a="pause">${q.paused ? '继续' : '暂停'}</button>` +
      `<button class="b" data-a="stop">结束</button>` +
      `<span style="flex:1"></span>` +
      `<button class="b" data-a="panel">${UI.open ? '收起面板' : '打开面板'}</button>` +
      `</div><div class="bar"><i style="width:${pct}%"></i></div>`;
  }

  // ───────────────────────── 启动 ─────────────────────────
  chrome.runtime.onMessage.addListener((m) => {
    if (m && m.type === 'xf-toggle') { UI.open = !UI.open; render(); }
  });

  let blackTimer = null;
  function boot() {
    buildUI();
    if (!blackTimer) blackTimer = setInterval(markBlack, 1000);
    const p = ensureLoaded();
    if (p) {
      p.then(() => {
        // 页面刷新后接着引导（站内跳转失败时会整页刷新）
        const q = S && S.queue;
        if (q && !q.paused) setTimeout(stepStart, 1200);
        // 限流暂停中刷新了页面：到时间照样自动继续
        else if (q && q.paused && q.resumeAt) {
          resumeTimer = setTimeout(() => { if (S && S.queue === q && q.paused) togglePause(); }, Math.max(1000, q.resumeAt - now()));
          renderGuide();
        } else if (q) renderGuide();
      });
    } else {
      // 未登录或 cookie 还没写好：稍后再试
      setTimeout(boot, 3000);
    }
    render();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
