---
inclusion: always
---

# 项目结构

```
x-follow/
├── manifest.json      # MV3 清单：两个 content script 都在 document_start 注入
├── background.js      # 点扩展图标：在 X 页面切换面板，否则打开 x.com
├── inject.js          # MAIN world：包装 fetch / XHR，旁听 GraphQL 和 friendships 返回
├── content.js         # ISOLATED world：存储、筛选、面板 UI、手动取关引导、黑名单标记
├── icons/             # 16 / 32 / 48 / 128 图标
├── test/
│   ├── inject.test.js # Node 单测：vm 里跑 inject.js，喂模拟返回
│   └── ui.html        # 模拟数据的面板预览
└── README.md          # 中文使用说明
```

## content.js 分区（按代码顺序）

1. 存储：`ensureLoaded` / `save` / 名单同步 `collectLists` `applyLists` `saveLists`
2. 数据合并：`onUsers`（列表数据）、`onAction`（用户自己点的关注 / 取关）、`onApiErr`（429 限流等）
3. 工具函数：`fmt` `esc` `num` `fans` `navigate`
4. 筛选：`filtered`（关系、粉丝数、时间、搜索、排序、名单）
5. 扫描：`startScan` / `startAuto` / `stepAuto` / `finishScan`
6. 引导：`startGuide` → `tick` 找按钮 → `showHL` 高亮 → `stepDone` 下一个；支持跳过、暂停、结束
7. 黑名单标记：`markBlack` / `renderWarn`
8. UI：`CSS` / `buildUI` / `render` / `renderGuide` / `boot`

新功能放进对应分区，不要另起新文件，除非 content.js 的某个分区已经大到难以维护。
