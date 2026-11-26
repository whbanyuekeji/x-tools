---
inclusion: always
---

# 技术栈与约定

- Chrome 扩展 **Manifest V3**，权限只有 `storage`、`unlimitedStorage`、`activeTab`。新增权限前先说明理由。
- 原生 JavaScript，**零依赖、无构建步骤**。不要引入 npm 包、打包工具或框架。
- 每个脚本都包在 IIFE 里并开启 `'use strict'`，用 `window.__xfHooked` / `window.__xfContent` 防止重复注入。
- 注释、界面文案、错误提示一律用中文。
- 面板 UI 挂在 Shadow DOM 里，样式写在 `content.js` 的 `CSS` 常量中，不污染 X 页面。
- 插入 HTML 的用户数据必须经过 `esc()` 转义。

## 脚本间通信

- `inject.js`（MAIN world）→ `content.js`（ISOLATED world）：`window.postMessage({ source: 'xf-inject', ... }, location.origin)`，接收方必须校验 `source` 和 `origin`。
- `background.js` → `content.js`：`chrome.tabs.sendMessage({ type: 'xf-toggle' })`。

## 存储

- `xf_<用户ID>`：账号记录、粉丝集合、扫描状态、引导队列、面板 UI 状态（结构见 `content.js` 的 `blank()`，带版本号 `v`）。
- `xfl_<用户ID>`：白名单 / 黑名单，单独存，多个标签页通过 `chrome.storage.onChanged` + `writer` token 同步。
- 改存储结构时要兼容旧数据，必要时升 `v` 并写迁移。

## 测试

- `node test/inject.test.js`：用模拟的 X 返回测试 `inject.js` 的解析，改 `inject.js` 后必须跑。
- 浏览器打开 `test/ui.html`：用模拟数据检查面板界面。
- 真机验证：在 `chrome://extensions` 加载已解压的扩展，刷新 x.com。
