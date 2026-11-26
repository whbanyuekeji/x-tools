---
inclusion: fileMatch
fileMatchPattern: ['inject.js', 'content.js', 'test/**']
---

# X 网页的数据与 DOM（会随改版变化）

## 旁听的接口

- `/i/api/graphql/<hash>/<操作名>`：操作名 `Following`、`Followers`（及以 `Followers` 结尾的变体）、`UserByScreenName` 等。列表条目的 `entryId` 以 `user-` 开头，用户在 `content.itemContent.user_results.result`。
- `/i/api/1.1/friendships/create.json`、`destroy.json`：用户自己点了关注 / 取关，用来记录精确时间。
- 429 返回带 `x-rate-limit-reset`（秒级时间戳）；没有就按 15 分钟处理。

## 用户对象的两种结构

| 字段 | 旧结构 | 新结构 |
|---|---|---|
| 用户名 / 昵称 | `legacy.screen_name` / `legacy.name` | `core.screen_name` / `core.name` |
| 头像 | `legacy.profile_image_url_https` | `avatar.image_url` |
| 粉丝 / 关注数 | `legacy.followers_count` / `friends_count` | `relationship_counts.followers` / `.following` |
| 关系 | `legacy.following` / `followed_by` | `relationship_perspectives.following` / `followed_by` |

`normGql` 两种都兼容，最后用 `findField` 兜底（不进入嵌套的其它 User）。新增字段时先在 `test/inject.test.js` 里补对应结构的用例。

## DOM 选择器

- 当前用户 ID：cookie `twid=u%3D<id>`
- 主页按钮：`[data-testid="<id>-follow"]`、`[data-testid="<id>-unfollow"]`、`[data-testid="<id>-cancel"]`
- 取关确认：`[data-testid="confirmationSheetConfirm"]`
- 主栏：`[data-testid="primaryColumn"]`；错误页通过“Retry / 重试”按钮识别

只读取和高亮这些元素，**不调用 `.click()`**。
