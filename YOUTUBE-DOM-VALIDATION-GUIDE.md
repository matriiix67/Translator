# YouTube 字幕 DOM 结构验证指南

## 执行日期
2026-02-23

## 验证目标
验证 YouTube 当前字幕 DOM 结构，确认以下选择器/对象是否存在及稳定性：

1. `.html5-video-player`
2. `.ytp-caption-window-container`
3. `.ytp-caption-segment`
4. `window.ytInitialPlayerResponse.captions.playerCaptionsTracklistRenderer.captionTracks`

---

## 手动验证步骤

### 第 1 步：打开 YouTube 视频
1. 访问：https://www.youtube.com/watch?v=jNQXAC9IVRw （"Me at the zoo" - 第一个 YouTube 视频，英文带字幕）
2. 或使用任何带有 CC 字幕的英文视频

### 第 2 步：处理 Cookie 弹窗
- 如果出现 Cookie/Consent 弹窗，点击"Accept all"或"Reject all"
- 确保视频播放器可见

###第 3 步：开启字幕
1. 点击播放器右下角的 CC（字幕）按钮
2. 确保字幕显示在视频下方
3. 播放视频几秒钟，确认字幕文本在变化

###第 4 步：打开开发者工具
1. 按 `Cmd+Option+I` (Mac) 或 `F12` (Windows/Linux)
2. 切换到 Console 标签

### 第 5 步：验证 DOM 选择器

#### 5.1 验证 `.html5-video-player`
在 Console 中执行：
```javascript
const player = document.querySelector('.html5-video-player');
console.log('Player found:', !!player);
console.log('Player classes:', player?.className);
```

**预期结果**：应该返回 `true` 和包含 `html5-video-player` 的类名列表

#### 5.2 验证 `.ytp-caption-window-container`
在 Console 中执行：
```javascript
const captionContainer = document.querySelector('.ytp-caption-window-container');
console.log('Caption container found:', !!captionContainer);
console.log('Container HTML:', captionContainer?.outerHTML.substring(0, 300));
```

**预期结果**：
- 如果字幕已开启，应该返回 `true`
- 应该显示包含字幕的 HTML 片段

#### 5.3 验证 `.ytp-caption-segment`
在 Console 中执行：
```javascript
const captionSegments = document.querySelectorAll('.ytp-caption-segment');
console.log('Caption segments found:', captionSegments.length);
console.log('First segment text:', captionSegments[0]?.textContent);
console.log('Segment structure:', captionSegments[0]?.outerHTML);
```

**预期结果**：
- 应该找到至少 1 个字幕片段
- 显示当前字幕文本

#### 5.4 验证 `window.ytInitialPlayerResponse`
在 Console 中执行：
```javascript
// 检查对象是否存在
console.log('ytInitialPlayerResponse exists:', !!window.ytInitialPlayerResponse);

// 检查字幕轨道路径
const captionData = window.ytInitialPlayerResponse?.captions;
console.log('Captions object:', !!captionData);

const captionTracks = captionData?.playerCaptionsTracklistRenderer?.captionTracks;
console.log('Caption tracks found:', !!captionTracks);
console.log('Number of tracks:', captionTracks?.length);

// 显示第一个字幕轨道信息
if (captionTracks && captionTracks.length > 0) {
  console.log('First track:', {
    languageCode: captionTracks[0].languageCode,
    name: captionTracks[0].name?.simpleText,
    baseUrl: captionTracks[0].baseUrl?.substring(0, 80) + '...',
    isTranslatable: captionTracks[0].isTranslatable
  });
}
```

**预期结果**：
- `ytInitialPlayerResponse` 应该存在
- 应该能找到 `captions.playerCaptionsTracklistRenderer.captionTracks`
- 至少显示一个可用的字幕轨道

### 第 6 步：测试字幕开关变化
1. 关闭字幕（点击 CC 按钮）
2. 重新执行第 5.2 和 5.3 步的代码
3. 记录字幕关闭时 DOM 的变化

在 Console 中执行：
```javascript
// 监控字幕容器的变化
const checkCaptions = () => {
  const container = document.querySelector('.ytp-caption-window-container');
  const segments = document.querySelectorAll('.ytp-caption-segment');
  console.log({
    timestamp: new Date().toISOString(),
    containerExists: !!container,
    containerVisible: container?.style.display !== 'none',
    segmentCount: segments.length
  });
};

// 立即检查
checkCaptions();

// 5 秒后再次检查（期间手动开关字幕）
console.log('请在 5 秒内开关字幕...');
setTimeout(checkCaptions, 5000);
```

### 第 7 步：测试视频切换
1. 点击推荐视频切换到另一个视频
2. 重新执行第 5.4 步的代码
3. 确认 `ytInitialPlayerResponse` 是否更新

在 Console 中执行：
```javascript
// 记录当前视频 ID
const currentVideoId = new URL(location.href).searchParams.get('v');
console.log('Current video ID:', currentVideoId);

// 监听 URL 变化（YouTube 是 SPA）
let lastVideoId = currentVideoId;
const checkVideoChange = setInterval(() => {
  const newVideoId = new URL(location.href).searchParams.get('v');
  if (newVideoId !== lastVideoId) {
    console.log('Video changed:', lastVideoId, '->', newVideoId);
    console.log('ytInitialPlayerResponse updated:', 
      window.ytInitialPlayerResponse?.videoDetails?.videoId === newVideoId);
    lastVideoId = newVideoId;
  }
}, 1000);

// 30 秒后停止监听
setTimeout(() => {
  clearInterval(checkVideoChange);
  console.log('Monitoring stopped');
}, 30000);

console.log('监听已启动，请切换视频...');
```

---

## 验证检查清单

| 项目 | 是否存在 | 备注 |
|------|----------|------|
| `.html5-video-player` | [ ] 是 [ ] 否 | 实际类名: ____________ |
| `.ytp-caption-window-container` | [ ] 是 [ ] 否 | 字幕开启时存在: [ ] 是 [ ] 否 |
| `.ytp-caption-segment` | [ ] 是 [ ] 否 | 数量: _____ |
| `window.ytInitialPlayerResponse` | [ ] 是 [ ] 否 | 层级正确: [ ] 是 [ ] 否 |
| `captions.playerCaptionsTracklistRenderer` | [ ] 是 [ ] 否 | |
| `captionTracks` 数组 | [ ] 是 [ ] 否 | 轨道数量: _____ |

---

## 常见问题排查

### Q1: 找不到 `.ytp-caption-window-container`
**可能原因**：
- 字幕未开启
- YouTube 更新了 DOM 结构
- 视频没有可用字幕

**替代选择器建议**：
```javascript
// 尝试查找所有字幕相关的元素
const alternatives = [
  document.querySelector('.caption-window'),
  document.querySelector('[class*="caption"]'),
  document.querySelector('.ytp-caption-window-rollup'),
  document.querySelector('.captions-text')
];
console.log('Alternative selectors:', alternatives.map((el, i) => ({ 
  index: i, 
  found: !!el, 
  classes: el?.className 
})));
```

### Q2: `.ytp-caption-segment` 返回空数组
**可能原因**：
- 字幕刚开启，还未显示第一行
- DOM 结构已变化

**诊断代码**：
```javascript
// 找出所有字幕相关的元素
const captionElements = document.querySelectorAll('[class*="caption"]');
console.log('Found caption elements:', captionElements.length);
captionElements.forEach((el, i) => {
  console.log(`[${i}]`, el.className, el.textContent?.substring(0, 50));
});
```

### Q3: `window.ytInitialPlayerResponse` 不存在
**可能原因**：
- YouTube 改变了变量名
- 执行时机过早（页面未完全加载）

**替代方案**：
```javascript
// 搜索所有可能的 YouTube 数据对象
console.log('Window objects:', Object.keys(window).filter(k => k.includes('yt')));

// 检查常见的替代位置
console.log('Alternatives:', {
  ytInitialData: !!window.ytInitialData,
  ytInitialPlayerResponse: !!window.ytInitialPlayerResponse,
  ytcfg: !!window.ytcfg
});
```

---

## 潜在的"插件不生效"原因分析

### 原因 1：字幕 DOM 延迟加载
**问题描述**：
- Content Script 在 `document_start` 或 `document_idle` 注入
- 字幕 DOM 在视频播放后才动态生成
- `MutationObserver` 未正确配置，错过了字幕元素的插入

**验证方法**：
```javascript
// 检查字幕容器的创建时机
const observer = new MutationObserver((mutations) => {
  mutations.forEach(mutation => {
    mutation.addedNodes.forEach(node => {
      if (node.classList?.contains('ytp-caption-window-container')) {
        console.log('Caption container added at:', new Date().toISOString());
        console.log('Segments at insertion:', 
          node.querySelectorAll('.ytp-caption-segment').length);
      }
    });
  });
});

observer.observe(document.body, { 
  childList: true, 
  subtree: true 
});
```

**解决建议**：
- 使用 `MutationObserver` 监听 `.html5-video-player` 的子树变化
- 监听 `run_at: "document_end"` 并轮询检查字幕容器
- 监听 YouTube 的自定义事件（如 `yt-navigate-finish`）

### 原因 2：YouTube SPA 导航未更新监听器
**问题描述**：
- YouTube 是单页应用 (SPA)
- 切换视频时不会重新加载页面
- Content Script 需要监听 SPA 路由变化

**验证方法**：
```javascript
// 监听 YouTube SPA 导航
document.addEventListener('yt-navigate-start', () => {
  console.log('YouTube navigation started');
});

document.addEventListener('yt-navigate-finish', () => {
  console.log('YouTube navigation finished');
  console.log('New video ID:', new URL(location.href).searchParams.get('v'));
});
```

**解决建议**：
- 监听 `yt-navigate-finish` 事件重新初始化字幕监听
- 使用 `history.pushState` 监听（需通过 injected script）
- 轮询检查 URL 变化

### 原因 3：`ytInitialPlayerResponse` 访问权限问题
**问题描述**：
- Content Script 运行在隔离的执行环境中
- 无法直接访问页面的 `window.ytInitialPlayerResponse`
- 需要通过 `injected.js` 注入到页面上下文

**验证方法**：
```javascript
// 在 Content Script 中尝试访问
console.log('From content script:', window.ytInitialPlayerResponse);
// 通常返回 undefined

// 需要通过 injected script
const script = document.createElement('script');
script.textContent = `
  window.postMessage({
    type: 'YT_PLAYER_RESPONSE',
    data: window.ytInitialPlayerResponse
  }, '*');
`;
document.documentElement.appendChild(script);
script.remove();

window.addEventListener('message', (event) => {
  if (event.data.type === 'YT_PLAYER_RESPONSE') {
    console.log('From page context:', event.data.data);
  }
});
```

**解决建议**：
- 使用 `web_accessible_resources` 和动态脚本注入
- 通过 `window.postMessage` 在 Content Script 和页面上下文间通信
- 参考研究文档中的 "四.3 YouTube 字幕数据获取" 章节

---

## 输出模板

完成验证后，请填写以下信息：

### 1. DOM 选择器验证结果
```
.html5-video-player: [存在/不存在]
  - 实际类名: ___________
  
.ytp-caption-window-container: [存在/不存在]
  - 字幕开启后出现: [是/否]
  - 替代选择器: ___________
  
.ytp-caption-segment: [存在/不存在]
  - 典型数量: _____
  - 替代选择器: ___________
```

### 2. JavaScript 对象验证结果
```
window.ytInitialPlayerResponse: [存在/不存在]
  
captions.playerCaptionsTracklistRenderer.captionTracks: [存在/不存在]
  - 典型轨道数: _____
  - 示例语言: _____
```

### 3. 最可能的插件失效原因（Top 2）
```
1. [原因标题]
   描述: ___________
   解决方向: ___________

2. [原因标题]
   描述: ___________
   解决方向: ___________
```

---

## 下一步行动

根据验证结果：

1. **如果所有选择器都存在**：
   - 检查 Content Script 的注入时机
   - 验证 MutationObserver 配置
   - 检查 CSS 选择器优先级

2. **如果选择器部分缺失**：
   - 更新代码中的选择器
   - 添加降级方案（fallback selectors）
   - 考虑使用更稳定的父级选择器

3. **如果 `ytInitialPlayerResponse` 无法访问**：
   - 实现 injected script 方案
   - 通过 `chrome.scripting.executeScript` 在页面上下文执行
   - 考虑使用字幕 API URL 直接请求

---

## 参考资料
- [Chrome Extension Manifest V3 文档](https://developer.chrome.com/docs/extensions/mv3/)
- [YouTube IFrame API 文档](https://developers.google.com/youtube/iframe_api_reference)
- 项目研究文档: `RESEARCH-Chrome-Extension-MV3-Translation.md`
