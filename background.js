// 点击扩展图标：在 X 页面上打开 / 关闭管理面板；不在 X 页面时打开 x.com
chrome.action.onClicked.addListener((tab) => {
  if (tab.id != null && tab.url && /^https:\/\/(x|twitter)\.com\//.test(tab.url)) {
    chrome.tabs.sendMessage(tab.id, { type: 'xf-toggle' }).catch(() => {});
  } else {
    chrome.tabs.create({ url: 'https://x.com/home' });
  }
});
