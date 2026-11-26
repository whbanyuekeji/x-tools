// 用模拟的 X 返回测试 inject.js 的解析：node test/inject.test.js
const fs = require('fs');
const path = require('path');
const vm = require('vm');
const assert = require('assert');

const posted = [];
const listeners = {};
const responses = {};
function FakeXHR() {}
FakeXHR.prototype.open = function () {};
FakeXHR.prototype.send = function () {};
FakeXHR.prototype.addEventListener = function () {};
const win = {
  location: { origin: 'https://x.com', pathname: '/' },
  postMessage: (d) => posted.push(d),
  addEventListener: (t, f) => { listeners[t] = f; },
  XMLHttpRequest: FakeXHR,
  fetch: async (url) => {
    const body = responses[url];
    const status = body && body.__status ? body.__status : 200;
    return {
      ok: status >= 200 && status < 300,
      status,
      headers: { get: (h) => (h === 'x-rate-limit-reset' && body && body.__reset ? String(body.__reset) : null) },
      clone: () => ({ text: async () => JSON.stringify(body) }),
    };
  },
};
win.window = win;
const ctx = vm.createContext({ ...win, window: win, URL, URLSearchParams, JSON, console });
ctx.window = ctx;
ctx.fetch = win.fetch;
vm.runInContext(fs.readFileSync(path.join(__dirname, '..', 'inject.js'), 'utf8'), ctx);

const user = (id, sn, fans, followedBy, newShape) =>
  newShape
    ? { __typename: 'User', rest_id: id, core: { screen_name: sn, name: sn.toUpperCase() }, legacy: { followers_count: fans, friends_count: 5 }, relationship_perspectives: { following: true, ...(followedBy ? { followed_by: true } : {}) }, avatar: { image_url: 'a.jpg' } }
    : { __typename: 'User', rest_id: id, legacy: { screen_name: sn, name: sn, followers_count: fans, following: true, ...(followedBy ? { followed_by: true } : {}) } };

const following = {
  data: { user: { result: { timeline: { timeline: { instructions: [{ type: 'TimelineAddEntries', entries: [
    { entryId: 'user-1', content: { itemContent: { user_results: { result: user('1', 'alice', 150, true, true) } } } },
    { entryId: 'user-2', content: { itemContent: { user_results: { result: user('2', 'bob', 250, false, false) } } } },
    // 粉丝数不在 legacy 下（X 改结构后的情况），并且带一个嵌套的其它用户，不能拿错
    { entryId: 'user-6', content: { itemContent: { user_results: { result: {
      __typename: 'User', rest_id: '6', core: { screen_name: 'frank', name: 'Frank' },
      profile_stats: { followers_count: 777, friends_count: 12 },
      affiliate: { __typename: 'User', rest_id: '7', legacy: { followers_count: 99999 } },
    } } } } },
    // 用户发来的真实诊断数据（2026-11）：粉丝数在 relationship_counts，没有 legacy
    {"content":{"__typename":"TimelineTimelineItem","entryType":"TimelineTimelineItem","itemContent":{"__typename":"TimelineUser","itemType":"TimelineUser","user_results":{"result":{"__typename":"User","avatar":{"image_url":"https://pbs.twimg.com/profile_images/2106740628499615744/osSyy1qR_normal.jpg"},"core":{"created_at":"Sat Nov 26 12:21:29 +0000 2011","name":"GQHCHN","screen_name":"GQHCHN"},"follow_request_sent":false,"id":"VXNlcjo0MjE4MTczMTE=","is_blue_verified":true,"privacy":{"protected":false},"relationship_counts":{"followers":1798,"following":1804},"relationship_perspectives":{"blocked_by":false,"blocking":false,"followed_by":true,"following":true,"live_following":false,"muting":false},"rest_id":"421817311","tweet_counts":{"media_tweets":7,"tweets":391}}}}},"entryId":"user-421817311","sortIndex":"2120472977626628047"},
    { entryId: 'cursor-bottom-1', content: { value: 'x' } },
  ] }] } } } } },
};
const vars = encodeURIComponent(JSON.stringify({ userId: '999', count: 20 }));
const url = `https://x.com/i/api/graphql/abc123/Following?variables=${vars}`;
responses[url] = following;

const create = 'https://x.com/i/api/1.1/friendships/create.json';
responses[create] = { id_str: '3', screen_name: 'carol', name: 'Carol', followers_count: 120, friends_count: 1 };
const bad = 'https://x.com/i/api/1.1/friendships/destroy.json';
responses[bad] = { errors: [{ code: 161 }] };

const limited = 'https://x.com/i/api/graphql/zzz/UserByScreenName?variables=%7B%7D';
responses[limited] = { __status: 429, __reset: 1800000000 };

(async () => {
  await ctx.fetch(url);
  await ctx.fetch(create, { body: 'user_id=3' });
  await ctx.fetch(bad, { body: 'user_id=4' });
  await ctx.fetch(limited);
  await new Promise((r) => setTimeout(r, 20));

  const u = posted.find((p) => p.kind === 'users');
  assert.ok(u, 'users message');
  assert.strictEqual(u.op, 'Following');
  assert.strictEqual(u.owner, '999');
  // vm 里创建的数组和这里的不是同一个 realm，先转成普通 JSON 再比较
  assert.deepStrictEqual(JSON.parse(JSON.stringify(u.list.map((x) => [x.id, x.handle, x.followers, x.followedBy ?? null]))), [['1', 'alice', 150, true], ['2', 'bob', 250, null], ['6', 'frank', 777, null], ['421817311', 'GQHCHN', 1798, true]]);
  const g = u.list.find((x) => x.id === '421817311');
  assert.strictEqual(g.friends, 1804);
  assert.strictEqual(g.following, true);
  assert.strictEqual(u.others.map((x) => x.id).join(','), '7');
  const s = posted.find((p) => p.kind === 'sample');
  assert.ok(s && s.raw.includes('alice'), '保存一条诊断数据');

  const a = posted.filter((p) => p.kind === 'action');
  assert.strictEqual(a.length, 1, '出错的返回不应记录');
  assert.strictEqual(a[0].type, 'follow');
  assert.strictEqual(a[0].user.id, '3');
  assert.strictEqual(a[0].user.followers, 120);

  const errs = posted.filter((p) => p.kind === 'apierr');
  const e429 = errs.find((e) => e.op === 'UserByScreenName');
  assert.ok(e429 && e429.status === 429 && e429.reset === 1800000000, '429 限流要报告解除时间');
  const eDestroy = errs.find((e) => e.op === 'friendships/destroy');
  assert.ok(eDestroy && eDestroy.code === 161, '取关失败（errors）要报告');
  console.log('inject.js OK');
})().catch((e) => { console.error(e); process.exit(1); });
