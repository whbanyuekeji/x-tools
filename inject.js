// 运行在页面环境（MAIN world）。
// 只“旁听”X 网页自己已经发出的请求的返回结果，不发任何额外请求、不点击任何按钮。
//   - GraphQL 返回里的用户（关注列表、粉丝列表、主页、时间线）→ 用户信息和关系
//   - 1.1/friendships/create|destroy（你自己点了关注 / 取关）→ 记录操作时间
(() => {
  'use strict';
  if (window.__xfHooked) return;
  window.__xfHooked = true;

  let sampled = false;
  const API_RE = /\/i\/api\/(graphql\/[^/?]+\/[A-Za-z]+|1\.1\/friendships\/(create|destroy)\.json)/;

  const post = (d) => {
    try { window.postMessage({ source: 'xf-inject', ...d }, location.origin); } catch (_) { /* ignore */ }
  };

  /**
   * 在用户对象里找某个字段（X 改过几次结构，粉丝数不一定在 legacy 下）。
   * 不进入嵌套的其它用户对象，免得拿到别人的数字。
   */
  function findField(u, names) {
    const st = [u];
    while (st.length) {
      const o = st.shift();
      for (const n of names) {
        const v = o[n];
        if (typeof v === 'number') return v;
        if (typeof v === 'string' && /^\d+$/.test(v)) return Number(v);
      }
      for (const k in o) {
        const v = o[k];
        if (v && typeof v === 'object' && !Array.isArray(v) && !(v !== u && v.__typename === 'User')) st.push(v);
      }
    }
    return undefined;
  }

  /** GraphQL 用户对象 → 统一格式（兼容新旧两种结构：core / legacy、relationship_perspectives / legacy） */
  function normGql(u) {
    if (!u || typeof u !== 'object' || u.__typename !== 'User' || !u.rest_id) return null;
    const L = u.legacy || {};
    const C = u.core || {};
    const R = u.relationship_perspectives || {};
    // 2026 年的结构：粉丝数 / 关注数在 relationship_counts.followers / .following（数字），没有 legacy
    const RC = u.relationship_counts || {};
    const n = (v) => (typeof v === 'number' ? v : undefined);
    return {
      id: String(u.rest_id),
      handle: C.screen_name ?? L.screen_name,
      name: C.name ?? L.name,
      avatar: (u.avatar && u.avatar.image_url) ?? L.profile_image_url_https,
      followers: L.followers_count ?? n(RC.followers) ?? findField(u, ['followers_count', 'followersCount']),
      friends: L.friends_count ?? n(RC.following) ?? findField(u, ['friends_count', 'following_count', 'followingCount']),
      following: R.following ?? L.following,
      followedBy: R.followed_by ?? L.followed_by,
      verified: !!u.is_blue_verified || !!L.verified,
      protected: (u.privacy && u.privacy.protected) ?? L.protected,
    };
  }

  /** 1.1 接口的用户对象（关注 / 取关返回）→ 统一格式；不带关系字段 */
  function normV1(u) {
    if (!u || typeof u !== 'object' || !u.id_str) return null;
    return {
      id: String(u.id_str),
      handle: u.screen_name,
      name: u.name,
      avatar: u.profile_image_url_https,
      followers: u.followers_count,
      friends: u.friends_count,
      verified: !!u.verified,
      protected: !!u.protected,
      followRequestSent: !!u.follow_request_sent,
    };
  }

  function walk(root, fn) {
    const st = [root];
    while (st.length) {
      const o = st.pop();
      if (!o || typeof o !== 'object') continue;
      if (fn(o) === false) continue;
      // 倒序压栈，出栈时保持原来的顺序（关注列表按关注先后排列）
      const ks = Object.keys(o);
      for (let i = ks.length - 1; i >= 0; i--) {
        const v = o[ks[i]];
        if (v && typeof v === 'object') st.push(v);
      }
    }
  }

  /** list：列表本身的条目（entryId 以 user- 开头）；others：返回里出现的其它用户 */
  function extract(json) {
    const list = [];
    const seen = new Set();
    walk(json, (o) => {
      if (typeof o.entryId === 'string' && o.entryId.startsWith('user-')) {
        const r = o.content && o.content.itemContent && o.content.itemContent.user_results && o.content.itemContent.user_results.result;
        let n = normGql(r);
        if (!n) {
          walk(o, (x) => {
            if (n) return false;
            const m = normGql(x);
            if (m) { n = m; return false; }
          });
        }
        if (n && !seen.has(n.id)) { seen.add(n.id); list.push(n); }
        return false;
      }
    });
    const others = [];
    walk(json, (o) => {
      const n = normGql(o);
      if (n && !seen.has(n.id)) { seen.add(n.id); others.push(n); }
    });
    return { list, others };
  }

  function handle(url, text, body, jsonObj) {
    let data = jsonObj;
    if (!data) {
      if (typeof text !== 'string' || (text[0] !== '{' && text[0] !== '[')) return;
      try { data = JSON.parse(text); } catch (_) { return; }
    }
    // HTTP 200 但只有 errors、没有数据（X 有时这样返回限流 / 失败）
    if (data && Array.isArray(data.errors) && data.errors.length && !(data.data && Object.keys(data.data).length) && !data.id_str) {
      const code = data.errors[0] && data.errors[0].code;
      reportErr(url, code === 88 ? 429 : 200, null, code);
      return;
    }
    const g = url.match(/\/i\/api\/graphql\/[^/?]+\/([A-Za-z]+)/);
    if (g) {
      let vars = {};
      try {
        const u = new URL(url, location.origin);
        const v = u.searchParams.get('variables');
        if (v) vars = JSON.parse(v);
        else if (typeof body === 'string' && body[0] === '{') vars = JSON.parse(body).variables || {};
      } catch (_) { /* ignore */ }
      const { list, others } = extract(data);
      if (!list.length && !others.length) return;
      // 诊断用：保存一份关注列表里的原始用户数据（粉丝数等显示不出来时，可以在面板里复制给开发者看）
      if (g[1] === 'Following' && !sampled) {
        try {
          walk(data, (o) => {
            if (typeof o.entryId === 'string' && o.entryId.startsWith('user-')) {
              sampled = true;
              post({ kind: 'sample', op: g[1], raw: JSON.stringify(o).slice(0, 30000) });
              return false;
            }
            if (sampled) return false;
          });
        } catch (_) { /* ignore */ }
      }
      post({ kind: 'users', op: g[1], owner: vars.userId != null ? String(vars.userId) : null, list, others });
      return;
    }
    const f = url.match(/\/i\/api\/1\.1\/friendships\/(create|destroy)\.json/);
    if (f) {
      const user = normV1(data);
      if (!user) return; // 出错的返回（errors）不记录
      post({ kind: 'action', type: f[1] === 'create' ? 'follow' : 'unfollow', user });
    }
  }

  /** 请求名：GraphQL 的操作名（如 UserByScreenName / Following），或 friendships/destroy */
  const opOf = (url) => {
    const g = url.match(/\/i\/api\/graphql\/[^/?]+\/([A-Za-z]+)/);
    if (g) return g[1];
    const f = url.match(/\/i\/api\/1\.1\/(friendships\/(?:create|destroy))\.json/);
    return f ? f[1] : 'unknown';
  };

  /**
   * X 返回错误时告诉面板：429 = 被限流（x-rate-limit-reset 是解除时间，秒），其它 = 普通错误。
   * 用来区分“X 暂时不让看 / 不让取关”和“页面跳转出了问题”。
   */
  function reportErr(url, status, reset, code) {
    post({ kind: 'apierr', op: opOf(url), status, reset: reset ? Number(reset) : null, code: code ?? null });
  }

  // ── fetch ──
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    const wrapped = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = typeof input === 'string' ? input : (input && input.url) || String(input);
        if (API_RE.test(url)) {
          const body = init && init.body;
          p.then((res) => {
            if (!res.ok) {
              reportErr(url, res.status, res.headers.get('x-rate-limit-reset'));
              return;
            }
            return res.clone().text().then((t) => handle(url, t, body));
          }).catch(() => {});
        }
      } catch (_) { /* ignore */ }
      return p;
    };
    wrapped.toString = () => origFetch.toString();
    window.fetch = wrapped;
  }

  // ── XMLHttpRequest ──
  const XP = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XP) {
    const origOpen = XP.open;
    const origSend = XP.send;
    XP.open = function (method, url) {
      try { this.__xfUrl = String(url); } catch (_) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    XP.send = function (body) {
      try {
        const url = this.__xfUrl;
        if (url && API_RE.test(url)) {
          this.addEventListener('load', () => {
            try {
              if (this.status < 200 || this.status >= 300) {
                reportErr(url, this.status, this.getResponseHeader('x-rate-limit-reset'));
                return;
              }
              if (this.responseType === '' || this.responseType === 'text') handle(url, this.responseText, body);
              else if (this.responseType === 'json') handle(url, null, body, this.response);
            } catch (_) { /* ignore */ }
          });
        }
      } catch (_) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  }

  // ── 面板要求打开某个页面：用站内跳转（和点链接一样），不整页刷新 ──
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.source !== 'xf-content') return;
    if (e.data.kind === 'nav' && typeof e.data.path === 'string' && e.data.path.startsWith('/')) {
      try {
        history.pushState({}, '', e.data.path);
        window.dispatchEvent(new PopStateEvent('popstate', { state: {} }));
      } catch (_) { /* content 会兜底整页跳转 */ }
    }
  });
})();
