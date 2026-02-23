# Chrome Extension Manifest V3 翻译扩展技术研究报告

## 一、Manifest V3 项目结构与核心规范

### 1.1 manifest.json 核心结构

```json
{
  "manifest_version": 3,
  "name": "Translator Extension",
  "version": "1.0.0",
  "description": "AI-powered bilingual translation extension",
  "icons": {
    "16": "icons/icon16.png",
    "48": "icons/icon48.png",
    "128": "icons/icon128.png"
  },
  "permissions": [
    "storage",
    "activeTab",
    "scripting",
    "tabs"
  ],
  "host_permissions": [
    "https://www.youtube.com/*",
    "https://api.openai.com/*",
    "<all_urls>"
  ],
  "background": {
    "service_worker": "background.js",
    "type": "module"
  },
  "action": {
    "default_popup": "popup.html",
    "default_icon": {
      "16": "icons/icon16.png",
      "48": "icons/icon48.png"
    }
  },
  "options_page": "options.html",
  "content_scripts": [
    {
      "matches": ["<all_urls>"],
      "js": ["content-script.js"],
      "css": ["content-style.css"],
      "run_at": "document_idle"
    },
    {
      "matches": ["https://www.youtube.com/*"],
      "js": ["youtube-content.js"],
      "run_at": "document_start"
    }
  ],
  "web_accessible_resources": [
    {
      "resources": ["injected.js", "*.html"],
      "matches": ["<all_urls>"]
    }
  ]
}
```

### 1.2 推荐目录结构

```
extension/
├── manifest.json
├── background.js              # Service Worker（MV3 核心）
├── content-script.js          # 通用网页内容脚本
├── youtube-content.js         # YouTube 专用内容脚本
├── injected.js                # 注入到页面上下文的脚本（用于拦截 XHR）
├── popup.html / popup.js      # 弹出窗口
├── options.html / options.js  # 配置页面
├── content-style.css          # 注入样式
├── icons/
│   ├── icon16.png
│   ├── icon48.png
│   └── icon128.png
└── lib/
    └── openai-stream.js       # OpenAI 流式调用封装
```

### 1.3 MV3 关键变化与限制

| 特性 | MV2 | MV3 |
|------|-----|-----|
| 后台运行 | 持久背景页 (background page) | Service Worker（按需唤醒，空闲后终止） |
| 网络请求拦截 | `chrome.webRequest` (可修改) | `declarativeNetRequest` (声明式，策略安装扩展除外) |
| 远程代码 | 允许 | **禁止**（不能执行远程 JS） |
| CSP | 宽松 | **严格**（不能 inline script, 不能 eval） |
| XHR | 支持 | Service Worker 中**不支持**，必须用 `fetch()` |
| DOM 访问 | 背景页可用 | Service Worker **无 DOM 访问**，需用 offscreen document |

### 1.4 Service Worker 最佳实践

```javascript
// background.js (Service Worker)

// ❌ 错误：使用全局变量保存状态（Service Worker 会被终止）
let cachedData = {};

// ✅ 正确：使用 chrome.storage 持久化状态
async function getState(key) {
  const result = await chrome.storage.local.get(key);
  return result[key];
}

async function setState(key, value) {
  await chrome.storage.local.set({ [key]: value });
}

// ✅ 使用 chrome.alarms 替代 setInterval 做定时任务
chrome.alarms.create('periodicTask', { periodInMinutes: 5 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'periodicTask') {
    // 执行定时任务
  }
});
```

---

## 二、Popup / Options 页面与配置管理

### 2.1 Options 页面（用户配置 API Key、端点等）

Options 页面有两种类型：
- **全页面**：使用 `"options_page"` 字段，在新标签页打开
- **嵌入式**：使用 `"options_ui"` + `"open_in_tab": false`，嵌入扩展管理页

**推荐使用 `chrome.storage.sync`** 来存储配置，可跨设备同步：

```javascript
// options.js - 保存配置
document.getElementById('saveBtn').addEventListener('click', async () => {
  const config = {
    apiKey: document.getElementById('apiKey').value,
    apiEndpoint: document.getElementById('endpoint').value || 'https://api.openai.com/v1',
    model: document.getElementById('model').value || 'gpt-4o-mini',
    targetLang: document.getElementById('targetLang').value || 'zh-CN',
    enableYouTube: document.getElementById('enableYT').checked,
    enableWebpage: document.getElementById('enableWeb').checked,
  };
  
  await chrome.storage.sync.set({ translatorConfig: config });
  showStatus('配置已保存');
});

// options.js - 加载配置（带默认值）
async function loadConfig() {
  const { translatorConfig } = await chrome.storage.sync.get({
    translatorConfig: {
      apiKey: '',
      apiEndpoint: 'https://api.openai.com/v1',
      model: 'gpt-4o-mini',
      targetLang: 'zh-CN',
      enableYouTube: true,
      enableWebpage: true,
    }
  });
  return translatorConfig;
}
```

### 2.2 Popup 页面（快速操作入口）

```html
<!-- popup.html -->
<!DOCTYPE html>
<html>
<head>
  <style>
    body { width: 320px; padding: 16px; font-family: system-ui; }
    .toggle { display: flex; justify-content: space-between; align-items: center; margin: 8px 0; }
    button { width: 100%; padding: 8px; margin-top: 12px; cursor: pointer; }
  </style>
</head>
<body>
  <h3>翻译器</h3>
  <div class="toggle">
    <span>网页翻译</span>
    <input type="checkbox" id="webToggle" />
  </div>
  <div class="toggle">
    <span>YouTube 字幕</span>
    <input type="checkbox" id="ytToggle" />
  </div>
  <button id="translatePage">翻译当前页面</button>
  <button id="openOptions">设置</button>
  <script src="popup.js"></script>
</body>
</html>
```

```javascript
// popup.js
document.getElementById('translatePage').addEventListener('click', async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  chrome.tabs.sendMessage(tab.id, { action: 'translatePage' });
});

document.getElementById('openOptions').addEventListener('click', () => {
  chrome.runtime.openOptionsPage();
});
```

### 2.3 配置变更监听

```javascript
// 在 content script 或 service worker 中监听配置变更
chrome.storage.onChanged.addListener((changes, namespace) => {
  if (namespace === 'sync' && changes.translatorConfig) {
    const newConfig = changes.translatorConfig.newValue;
    // 响应配置变更
    updateTranslationSettings(newConfig);
  }
});
```

---

## 三、网页双语文本注入（类似沉浸式翻译）

### 3.1 核心思路

沉浸式翻译的核心技术：
1. **识别主内容区域**：定位页面的正文段落，忽略导航、菜单等非正文区域
2. **段落级翻译**：以段落 `<p>` 为最小翻译单元，保留上下文
3. **翻译文本注入**：在原文段落下方插入翻译后的文本
4. **使用 Shadow DOM 隔离样式**：防止页面 CSS 影响翻译元素

### 3.2 内容识别与段落提取

```javascript
// content-script.js

function getTranslatableElements() {
  const selectors = [
    'article p',
    'main p',
    '.content p',
    '.post-content p',
    '.article-body p',
    // 通用段落（排除导航等）
    'p',
    'h1', 'h2', 'h3', 'h4', 'h5', 'h6',
    'li',
    'blockquote',
    'figcaption',
    'td', 'th',
  ];
  
  const elements = new Set();
  for (const selector of selectors) {
    document.querySelectorAll(selector).forEach(el => {
      const text = el.textContent.trim();
      if (text.length > 5 && !isNavigationElement(el)) {
        elements.add(el);
      }
    });
  }
  return [...elements];
}

function isNavigationElement(el) {
  const navParents = ['nav', 'header', 'footer', 'aside'];
  let parent = el.parentElement;
  while (parent) {
    if (navParents.includes(parent.tagName.toLowerCase())) return true;
    if (parent.getAttribute('role') === 'navigation') return true;
    parent = parent.parentElement;
  }
  return false;
}
```

### 3.3 双语文本注入（Shadow DOM 隔离）

```javascript
// 使用 Shadow DOM 注入翻译文本，完全隔离样式
function injectTranslation(originalElement, translatedText) {
  // 检查是否已有翻译
  if (originalElement.nextElementSibling?.classList.contains('translator-wrapper')) {
    const shadow = originalElement.nextElementSibling.shadowRoot;
    if (shadow) {
      shadow.querySelector('.translated-text').textContent = translatedText;
    }
    return;
  }

  const wrapper = document.createElement('div');
  wrapper.classList.add('translator-wrapper');
  wrapper.setAttribute('data-translator', 'true');
  
  // 使用 closed Shadow DOM 防止页面 JS 访问
  const shadow = wrapper.attachShadow({ mode: 'closed' });

  shadow.innerHTML = `
    <style>
      :host {
        display: block;
        margin: 4px 0 12px 0;
        padding: 0;
      }
      .translated-text {
        color: #666;
        font-size: 0.92em;
        line-height: 1.6;
        border-left: 3px solid #4A90D9;
        padding-left: 10px;
        margin: 4px 0;
        font-family: system-ui, -apple-system, sans-serif;
      }
    </style>
    <div class="translated-text">${escapeHtml(translatedText)}</div>
  `;

  originalElement.insertAdjacentElement('afterend', wrapper);
}

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}
```

### 3.4 使用 MutationObserver 处理动态内容

```javascript
// 监控 DOM 变化，处理 SPA 页面和动态加载内容
function observeDOMChanges() {
  const observer = new MutationObserver((mutations) => {
    const newNodes = [];
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType === Node.ELEMENT_NODE && 
            !node.hasAttribute('data-translator')) {
          const paragraphs = node.querySelectorAll?.('p, h1, h2, h3, h4, h5, h6');
          if (paragraphs) newNodes.push(...paragraphs);
          if (node.matches?.('p, h1, h2, h3, h4, h5, h6')) {
            newNodes.push(node);
          }
        }
      }
    }
    if (newNodes.length > 0) {
      // 批量翻译新出现的段落（防抖处理）
      debouncedTranslate(newNodes);
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
  });
  
  return observer;
}

function debounce(fn, delay = 500) {
  let timer;
  return (...args) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), delay);
  };
}

const debouncedTranslate = debounce((elements) => {
  translateElements(elements);
}, 300);
```

### 3.5 整页翻译流程

```javascript
// content-script.js 主逻辑
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'translatePage') {
    translatePage();
    sendResponse({ status: 'started' });
  }
});

async function translatePage() {
  const elements = getTranslatableElements();
  
  // 分批翻译，每批 5 个段落
  const batchSize = 5;
  for (let i = 0; i < elements.length; i += batchSize) {
    const batch = elements.slice(i, i + batchSize);
    const texts = batch.map(el => el.textContent.trim());
    
    // 发送给 Service Worker 调用 OpenAI API
    const response = await chrome.runtime.sendMessage({
      action: 'translate',
      texts: texts,
    });
    
    if (response.translations) {
      batch.forEach((el, idx) => {
        injectTranslation(el, response.translations[idx]);
      });
    }
  }
}
```

---

## 四、YouTube 字幕拦截与双语字幕

### 4.1 方案概述

获取 YouTube 字幕有三种主要方案：

| 方案 | 优点 | 缺点 |
|------|------|------|
| **A. 拦截 XHR/Fetch** | 实时获取、无额外请求 | 需注入页面上下文，时序敏感 |
| **B. Innertube API** | 可靠、可获取所有语言 | 需额外网络请求 |
| **C. ytInitialPlayerResponse** | 页面加载时即可获取 | 仅获取字幕列表，仍需请求内容 |

**推荐组合方案**：使用 **方案 C 获取字幕列表** + **Innertube API 获取字幕内容**，辅以 **方案 A 做实时监听**。

### 4.2 方案 A：拦截 XMLHttpRequest 获取字幕数据

YouTube 通过 XMLHttpRequest 请求 `timedtext` 端点获取字幕。通过拦截 XHR 可以实时捕获字幕数据。

**关键要点**：必须在 `document_start` 时注入，且需要注入到**页面上下文**（而非内容脚本的隔离环境）。

```javascript
// youtube-content.js - 在 document_start 运行
// 注入拦截脚本到页面上下文
const script = document.createElement('script');
script.src = chrome.runtime.getURL('injected.js');
script.onload = () => script.remove();
(document.head || document.documentElement).appendChild(script);

// 监听来自页面上下文的消息
window.addEventListener('message', (event) => {
  if (event.source !== window) return;
  if (event.data.type === 'SUBTITLE_DATA') {
    handleSubtitleData(event.data.payload);
  }
});
```

```javascript
// injected.js - 注入到页面上下文，拦截 XHR
(function() {
  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...args) {
    this._url = url;
    return originalOpen.apply(this, [method, url, ...args]);
  };

  XMLHttpRequest.prototype.send = function(...args) {
    if (this._url && this._url.includes('timedtext')) {
      this.addEventListener('load', function() {
        try {
          const data = JSON.parse(this.responseText);
          window.postMessage({
            type: 'SUBTITLE_DATA',
            payload: {
              url: this._url,
              data: data,
            }
          }, '*');
        } catch (e) {
          // 可能是 XML 格式
          window.postMessage({
            type: 'SUBTITLE_DATA',
            payload: {
              url: this._url,
              data: this.responseText,
            }
          }, '*');
        }
      });
    }
    return originalSend.apply(this, args);
  };
})();
```

### 4.3 方案 B：通过 Innertube API 获取字幕（推荐）

```javascript
// 在 Service Worker 中实现
async function getYouTubeTranscript(videoId, language = 'en') {
  // Step 1: 获取 Innertube API Key
  const videoUrl = `https://www.youtube.com/watch?v=${videoId}`;
  const pageHtml = await fetch(videoUrl).then(r => r.text());
  const apiKeyMatch = pageHtml.match(/"INNERTUBE_API_KEY":"([^"]+)"/);
  if (!apiKeyMatch) throw new Error('INNERTUBE_API_KEY not found');
  const apiKey = apiKeyMatch[1];

  // Step 2: 使用 Android 客户端身份调用 player API
  const playerResponse = await fetch(
    `https://www.youtube.com/youtubei/v1/player?key=${apiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        context: {
          client: {
            clientName: 'ANDROID',
            clientVersion: '20.10.38',
          },
        },
        videoId,
      }),
    }
  ).then(r => r.json());

  // Step 3: 提取字幕轨道
  const tracks = playerResponse?.captions
    ?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks) throw new Error('No caption tracks found');

  const track = tracks.find(t => t.languageCode === language);
  if (!track) throw new Error(`No captions for language: ${language}`);

  // Step 4: 获取字幕内容（使用 JSON 格式）
  const baseUrl = track.baseUrl.replace(/&fmt=\w+$/, '');
  const captionUrl = `${baseUrl}&fmt=json3`;
  const captionData = await fetch(captionUrl).then(r => r.json());
  
  // 解析 json3 格式的字幕
  return captionData.events
    .filter(e => e.segs) // 过滤掉没有文本的事件
    .map(event => ({
      text: event.segs.map(s => s.utf8).join(''),
      startMs: event.tStartMs,
      durationMs: event.dDurationMs,
    }));
}
```

### 4.4 方案 C：从页面数据提取字幕列表

```javascript
// youtube-content.js - 从 ytInitialPlayerResponse 获取字幕信息
function extractCaptionTracksFromPage() {
  // YouTube SPA 中可以从 window.ytInitialPlayerResponse 获取
  // 但在内容脚本中需要通过注入脚本到页面上下文
  const script = document.createElement('script');
  script.textContent = `
    window.postMessage({
      type: 'YT_CAPTION_TRACKS',
      payload: window.ytInitialPlayerResponse?.captions
        ?.playerCaptionsTracklistRenderer?.captionTracks || []
    }, '*');
  `;
  document.documentElement.appendChild(script);
  script.remove();
}
```

### 4.5 YouTube 双语字幕渲染

```javascript
// youtube-content.js - 在视频播放器中渲染双语字幕

function createBilingualSubtitleOverlay() {
  const player = document.querySelector('#movie_player');
  if (!player) return null;

  const overlay = document.createElement('div');
  overlay.id = 'bilingual-subtitle-overlay';
  overlay.style.cssText = `
    position: absolute;
    bottom: 60px;
    left: 50%;
    transform: translateX(-50%);
    z-index: 9999;
    text-align: center;
    pointer-events: none;
    max-width: 80%;
  `;
  player.appendChild(overlay);
  return overlay;
}

function updateBilingualSubtitle(overlay, originalText, translatedText) {
  overlay.innerHTML = `
    <div style="
      background: rgba(0,0,0,0.75);
      color: white;
      padding: 8px 16px;
      border-radius: 4px;
      font-size: 16px;
      line-height: 1.5;
      display: inline-block;
    ">
      <div style="color: #fff;">${escapeHtml(originalText)}</div>
      <div style="color: #FFD700; font-size: 14px; margin-top: 4px;">
        ${escapeHtml(translatedText)}
      </div>
    </div>
  `;
}

// 同步字幕与视频时间
function syncSubtitles(video, subtitles, translatedSubtitles, overlay) {
  let lastIndex = -1;
  
  function updateDisplay() {
    const currentTimeMs = video.currentTime * 1000;
    const index = subtitles.findIndex(sub => 
      currentTimeMs >= sub.startMs && 
      currentTimeMs < sub.startMs + sub.durationMs
    );

    if (index !== lastIndex) {
      lastIndex = index;
      if (index >= 0) {
        updateBilingualSubtitle(
          overlay,
          subtitles[index].text,
          translatedSubtitles[index]?.text || '...'
        );
      } else {
        overlay.innerHTML = '';
      }
    }
    requestAnimationFrame(updateDisplay);
  }
  
  requestAnimationFrame(updateDisplay);
}
```

### 4.6 处理 YouTube SPA 导航

```javascript
// YouTube 是 SPA，页面导航不会触发传统的页面加载
// 需要监听 URL 变化
let currentVideoId = null;

function observeYouTubeNavigation() {
  // 方法 1：监听 yt-navigate-finish 事件（YouTube 专用）
  document.addEventListener('yt-navigate-finish', () => {
    const videoId = new URL(location.href).searchParams.get('v');
    if (videoId && videoId !== currentVideoId) {
      currentVideoId = videoId;
      onVideoChanged(videoId);
    }
  });

  // 方法 2：备用 - 使用 MutationObserver 监听 title 变化
  const titleObserver = new MutationObserver(() => {
    const videoId = new URL(location.href).searchParams.get('v');
    if (videoId && videoId !== currentVideoId) {
      currentVideoId = videoId;
      onVideoChanged(videoId);
    }
  });
  
  titleObserver.observe(document.querySelector('title'), { childList: true });
}
```

---

## 五、OpenAI API 流式调用（在 Chrome 扩展中）

### 5.1 架构设计

```
┌─────────────────┐      消息传递       ┌──────────────────┐     fetch (SSE)     ┌──────────────┐
│  Content Script  │ ◄──────────────►  │  Service Worker   │ ◄────────────────► │  OpenAI API  │
│  (网页上下文)     │  chrome.runtime   │  (background.js)  │  stream: true     │              │
│                  │  port / message   │                    │                    │              │
└─────────────────┘                    └──────────────────┘                    └──────────────┘
```

### 5.2 Service Worker 中的流式 OpenAI 调用

```javascript
// background.js - Service Worker

async function callOpenAIStreaming(messages, config, onChunk) {
  const response = await fetch(`${config.apiEndpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model || 'gpt-4o-mini',
      messages: messages,
      stream: true,
    }),
  });

  if (!response.ok) {
    throw new Error(`OpenAI API error: ${response.status} ${response.statusText}`);
  }

  const reader = response.body
    .pipeThrough(new TextDecoderStream())
    .getReader();

  let fullText = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;

    // 解析 SSE 格式
    const lines = value.split('\n');
    for (const line of lines) {
      if (!line.startsWith('data: ')) continue;
      const data = line.slice(6).trim();
      if (data === '[DONE]') break;

      try {
        const parsed = JSON.parse(data);
        const delta = parsed.choices?.[0]?.delta?.content;
        if (delta) {
          fullText += delta;
          onChunk(delta, fullText);
        }
      } catch (e) {
        // 忽略解析错误（可能是不完整的 JSON）
      }
    }
  }

  return fullText;
}
```

### 5.3 方案 A：使用 chrome.runtime.Port 传输流式数据（推荐简单场景）

```javascript
// background.js - 使用 Port 进行流式消息传递
chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'translation-stream') return;

  port.onMessage.addListener(async (msg) => {
    if (msg.action === 'translateStream') {
      const config = await loadConfig();
      
      try {
        await callOpenAIStreaming(
          [
            { role: 'system', content: `Translate the following text to ${config.targetLang}. Return only the translation.` },
            { role: 'user', content: msg.text },
          ],
          config,
          (chunk, fullText) => {
            // 每收到一个 chunk 就通过 port 发送给 content script
            port.postMessage({ type: 'chunk', chunk, fullText });
          }
        );
        port.postMessage({ type: 'done' });
      } catch (error) {
        port.postMessage({ type: 'error', error: error.message });
      }
    }
  });
});
```

```javascript
// content-script.js - 接收流式翻译
function translateWithStreaming(text, element) {
  const port = chrome.runtime.connect({ name: 'translation-stream' });
  
  // 创建占位翻译元素
  const translationEl = injectTranslation(element, '翻译中...');
  
  port.onMessage.addListener((msg) => {
    switch (msg.type) {
      case 'chunk':
        // 实时更新翻译文本
        updateTranslationText(translationEl, msg.fullText);
        break;
      case 'done':
        port.disconnect();
        break;
      case 'error':
        updateTranslationText(translationEl, `[翻译错误: ${msg.error}]`);
        port.disconnect();
        break;
    }
  });

  port.postMessage({ action: 'translateStream', text });
}
```

### 5.4 方案 B：批量翻译（非流式，适合大量短文本）

```javascript
// background.js - 批量翻译多个段落
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg.action === 'translate') {
    handleBatchTranslation(msg.texts, sender.tab.id)
      .then(sendResponse)
      .catch(err => sendResponse({ error: err.message }));
    return true; // 异步响应
  }
});

async function handleBatchTranslation(texts) {
  const config = await loadConfig();
  
  const prompt = texts.map((t, i) => `[${i}] ${t}`).join('\n---\n');
  const systemPrompt = `Translate each numbered text below to ${config.targetLang}. 
Preserve the numbering format [0], [1], etc. Return only translations.`;

  const response = await fetch(`${config.apiEndpoint}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.apiKey}`,
    },
    body: JSON.stringify({
      model: config.model,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: prompt },
      ],
    }),
  });

  const data = await response.json();
  const translationText = data.choices[0].message.content;
  
  // 解析编号翻译结果
  const translations = parseNumberedTranslations(translationText, texts.length);
  return { translations };
}
```

### 5.5 Service Worker 生命周期与 Keep-Alive

```javascript
// Service Worker 在空闲 30 秒后会被终止
// 处理长时间翻译任务时需要保持活跃

// 方法 1：在流式请求期间使用 chrome.runtime.Port 保持活跃
// Port 连接期间 Service Worker 不会被终止

// 方法 2：使用 chrome.offscreen 处理需要长时间运行的任务
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
  });
  
  if (existingContexts.length === 0) {
    await chrome.offscreen.createDocument({
      url: 'offscreen.html',
      reasons: ['DOM_SCRAPING'], // 使用合适的 reason
      justification: 'Handle streaming API responses',
    });
  }
}

// 方法 3：Fetch 请求本身会保持 Service Worker 活跃，直到请求完成
// 因此流式 fetch 在数据传输期间不会被终止
```

### 5.6 重要警告：API Key 安全

```javascript
// ⚠️ 安全注意事项：

// ❌ 错误：在 content script 中直接调用 OpenAI API
// content script 中的代码可被网页 JS 访问到，API Key 可能泄露

// ✅ 正确：所有 API 调用都在 Service Worker 中进行
// Service Worker 的代码和网络请求对网页不可见

// ✅ 更安全的方案：使用中间代理服务器
// 用户配置代理服务器地址，API Key 存储在服务器端
// extension → proxy server → OpenAI API
```

---

## 六、进阶技巧与巧妙用法

### 6.1 翻译缓存策略

```javascript
// 使用 IndexedDB 缓存翻译结果，避免重复翻译
class TranslationCache {
  constructor() {
    this.dbPromise = this.openDB();
  }

  async openDB() {
    return new Promise((resolve, reject) => {
      const request = indexedDB.open('TranslationCache', 1);
      request.onupgradeneeded = (e) => {
        const db = e.target.result;
        if (!db.objectStoreNames.contains('translations')) {
          const store = db.createObjectStore('translations', { keyPath: 'hash' });
          store.createIndex('timestamp', 'timestamp');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
    });
  }

  async getHash(text) {
    const encoded = new TextEncoder().encode(text);
    const hashBuffer = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(hashBuffer))
      .map(b => b.toString(16).padStart(2, '0'))
      .join('');
  }

  async get(text, targetLang) {
    const hash = await this.getHash(`${targetLang}:${text}`);
    const db = await this.dbPromise;
    return new Promise((resolve) => {
      const tx = db.transaction('translations', 'readonly');
      const request = tx.objectStore('translations').get(hash);
      request.onsuccess = () => resolve(request.result?.translation);
      request.onerror = () => resolve(null);
    });
  }

  async set(text, targetLang, translation) {
    const hash = await this.getHash(`${targetLang}:${text}`);
    const db = await this.dbPromise;
    const tx = db.transaction('translations', 'readwrite');
    tx.objectStore('translations').put({
      hash,
      text,
      targetLang,
      translation,
      timestamp: Date.now(),
    });
  }
}
```

### 6.2 智能分段策略

```javascript
// 将长文本按语义分段，避免超过 token 限制
function segmentText(text, maxChars = 2000) {
  if (text.length <= maxChars) return [text];
  
  const segments = [];
  const sentences = text.split(/(?<=[.!?。！？\n])\s+/);
  let current = '';
  
  for (const sentence of sentences) {
    if ((current + sentence).length > maxChars && current.length > 0) {
      segments.push(current.trim());
      current = sentence;
    } else {
      current += (current ? ' ' : '') + sentence;
    }
  }
  if (current.trim()) segments.push(current.trim());
  
  return segments;
}
```

### 6.3 翻译质量优化 Prompt

```javascript
// 针对不同场景使用不同的翻译 prompt
const TRANSLATION_PROMPTS = {
  webpage: {
    system: `You are a professional translator. Translate the following text to {targetLang}.
Rules:
- Preserve all HTML tags, links, and formatting
- Maintain the original tone and style
- Translate naturally, not word-by-word
- Keep proper nouns, brand names, and technical terms as-is when appropriate
- Return ONLY the translation, no explanations`,
  },
  
  subtitle: {
    system: `You are a subtitle translator. Translate the following subtitle text to {targetLang}.
Rules:
- Keep translations concise (subtitles have limited display time)
- Preserve speaker tone and emotion
- Use colloquial language appropriate for spoken content
- Return ONLY the translation`,
  },

  batch: {
    system: `Translate each numbered paragraph below to {targetLang}.
Keep the [N] numbering format. Return ONLY the translations, one per line with their numbers.
Ensure natural, fluent translations that preserve the original meaning and tone.`,
  },
};
```

### 6.4 鼠标悬停翻译模式

```javascript
// 类似沉浸式翻译的 hover 翻译模式
function enableHoverTranslation() {
  let hoverTimeout;
  let currentElement = null;
  let tooltip = null;

  document.addEventListener('mouseover', (e) => {
    const target = e.target.closest('p, h1, h2, h3, h4, h5, h6, li, td, span');
    if (!target || target === currentElement) return;
    
    clearTimeout(hoverTimeout);
    removeTooltip();
    currentElement = target;
    
    hoverTimeout = setTimeout(async () => {
      const text = target.textContent.trim();
      if (text.length < 5) return;
      
      const translation = await translateText(text);
      showTooltip(target, translation);
    }, 800); // 800ms 延迟防误触
  });

  document.addEventListener('mouseout', (e) => {
    clearTimeout(hoverTimeout);
    // 延迟移除，允许鼠标移动到 tooltip 上
    setTimeout(() => {
      if (!tooltip?.matches(':hover')) removeTooltip();
    }, 300);
  });
}
```

---

## 七、注意事项与常见陷阱

### 7.1 Service Worker 生命周期

- **Service Worker 不是持久运行的**：空闲约 30 秒后会被终止
- **不能使用全局变量保存状态**：每次唤醒都是全新的执行环境
- **解决方案**：使用 `chrome.storage.local`、`chrome.storage.session`（MV3 新增）或 IndexedDB
- **Port 连接保活**：`chrome.runtime.Port` 连接期间 Service Worker 不会被终止
- **活跃的 `fetch()` 请求**也会阻止 Service Worker 终止

### 7.2 Content Security Policy 限制

- **不能使用 `eval()`、`new Function()` 等动态代码执行**
- **不能加载远程脚本**（所有 JS 必须打包在扩展中）
- **内联脚本被禁止**：不能在 HTML 中使用 `<script>inline code</script>`
- **解决方案**：所有脚本文件化，引用打包在扩展内的文件

### 7.3 Content Script 隔离世界

- Content Script 运行在**隔离的 JS 世界**中，与页面 JS 环境分离
- **不能直接访问** `window.ytInitialPlayerResponse` 等页面变量
- **解决方案**：通过 `web_accessible_resources` 注入脚本到页面上下文 (MAIN world)
- 或者使用 MV3 新增的 `chrome.scripting.executeScript({ world: 'MAIN' })` API

```javascript
// MV3 推荐方式：使用 scripting API 注入到 MAIN world
chrome.scripting.executeScript({
  target: { tabId: tabId },
  world: 'MAIN',
  func: () => {
    // 这里可以访问页面变量
    return window.ytInitialPlayerResponse?.captions;
  },
});
```

### 7.4 YouTube SPA 特殊处理

- YouTube 使用 SPA 架构，URL 变化不会触发传统页面加载事件
- Content Script 只在首次加载时注入，后续导航不会重新注入
- 必须监听 `yt-navigate-finish` 事件或使用 URL 变化观察
- `document_start` 只在首次页面加载时生效

### 7.5 性能注意事项

- **避免同时翻译整个页面**：分批处理，每批 3-5 个段落
- **使用 `requestIdleCallback`** 进行非紧急的 DOM 操作
- **缓存翻译结果**：相同文本不要重复调用 API
- **MutationObserver 防抖**：对频繁的 DOM 变化进行防抖处理
- **视口优先翻译**：先翻译可见区域，滚动时再翻译新内容

```javascript
// 视口优先翻译策略
function isInViewport(element) {
  const rect = element.getBoundingClientRect();
  return (
    rect.top < window.innerHeight &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.right > 0
  );
}

function translateVisibleFirst(elements) {
  const visible = elements.filter(isInViewport);
  const hidden = elements.filter(el => !isInViewport(el));
  
  // 先翻译可见元素
  translateBatch(visible).then(() => {
    // 然后翻译不可见元素（低优先级）
    requestIdleCallback(() => translateBatch(hidden));
  });
}
```

### 7.6 错误处理与重试

```javascript
async function translateWithRetry(text, maxRetries = 3) {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      return await callOpenAI(text);
    } catch (error) {
      if (error.status === 429) {
        // Rate limit，指数退避
        const delay = Math.pow(2, attempt) * 1000;
        await new Promise(r => setTimeout(r, delay));
        continue;
      }
      if (attempt === maxRetries) throw error;
    }
  }
}
```

---

## 八、真实代码参考项目

### 8.1 推荐参考的开源项目

| 项目 | GitHub 地址 | 特点 |
|------|------------|------|
| **SubtitleEasy** | github.com/veraposeidon/subtitleeasy | 视频双语字幕，MIT 许可 |
| **DualSubs/YouTube** | github.com/dualsubs/youtube | YouTube 双语字幕方案，522 stars |
| **thuan1412/bilingual** | github.com/thuan1412/bilingual | YouTube 双语字幕扩展，TypeScript 开发 |
| **Comet Translator** | github.com/feechkablum6/comet-translator | MV3 AI 翻译扩展，Shadow DOM 隔离 |
| **AiTranslator** | github.com/xPOURY4/AiTranslator-extension | 多 AI 提供者支持（OpenAI/Claude/Gemini） |
| **AI LangShift** | github.com/imaun/langshift | TypeScript + OpenAI GPT-4 翻译 |
| **WebExtensionMessageStream** | github.com/guest271314/WebExtensionMessageStream | MV3 流式消息传输参考实现 |

### 8.2 immersive-translate 技术架构（逆向分析）

沉浸式翻译的核心架构可归纳为：

```
┌────────────────────────────────────────────────────────────────┐
│                        Chrome Extension                        │
├──────────┬─────────────┬──────────────┬───────────────────────┤
│  Popup   │  Options    │  Background  │   Content Scripts      │
│  快速    │  详细配置   │  SW/API网关  │                        │
│  开关    │  API Key    │  翻译调度    │  ┌─────────────────┐   │
│          │  语言设置   │  缓存管理    │  │ 页面内容识别器   │   │
│          │  翻译引擎   │  消息路由    │  │ ↓               │   │
│          │             │              │  │ 段落提取器      │   │
│          │             │              │  │ ↓               │   │
│          │             │              │  │ 翻译注入器      │   │
│          │             │              │  │ (Shadow DOM)    │   │
│          │             │              │  └─────────────────┘   │
│          │             │              │  ┌─────────────────┐   │
│          │             │              │  │ YouTube 模块    │   │
│          │             │              │  │ 字幕拦截        │   │
│          │             │              │  │ 双语字幕渲染    │   │
│          │             │              │  └─────────────────┘   │
└──────────┴─────────────┴──────────────┴───────────────────────┘
```

---

## 九、引用来源

### 官方文档
1. [Chrome Extension Manifest V3 迁移指南](https://developer.chrome.com/docs/extensions/develop/migrate) - Google 官方
2. [Chrome Manifest 文件格式](https://developer.chrome.com/docs/extensions/mv3/manifest) - Google 官方
3. [chrome.storage API](https://developer.chrome.com/docs/extensions/mv2/reference/storage) - Google 官方
4. [Options 页面开发](https://developer.chrome.com/docs/extensions/develop/ui/options-page) - Google 官方
5. [Content Scripts 文档](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts) - Google 官方
6. [Service Worker 迁移](https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers) - Google 官方
7. [Offscreen Documents](https://developer.chrome.com/blog/Offscreen-Documents-in-Manifest-v3) - Google 官方
8. [Fetch Streaming Requests](https://developer.chrome.com/docs/capabilities/web-apis/fetch-streaming-requests) - Google 官方

### YouTube 字幕相关
9. [YouTube Data API - Captions](https://developers.google.com/youtube/v3/docs/captions) - Google 官方
10. [Innertube API 字幕提取指南 (2025)](https://medium.com/@aqib-2/extract-youtube-transcripts-using-innertube-api-2025-javascript-guide-dc417b762f49) - 社区
11. [MV3 中 document_start 时序问题](https://stackoverflow.com/questions/72605336/) - Stack Overflow

### 流式传输
12. [MV3 Web Extensions 流式消息传输](https://codereview.stackexchange.com/questions/299636/) - 社区
13. [WebExtensionMessageStream](https://github.com/guest271314/WebExtensionMessageStream) - 社区参考实现

### Shadow DOM 与样式隔离
14. [使用 Shadow DOM 隔离扩展注入组件](https://kaangenc.me/2024.05.18.using-shadow-dom-to-isolate-injected-browser-extension-compo/) - 社区
15. [Chrome Extension CSS 干扰解决方案](https://dev.to/developertom01/solving-css-and-javascript-interference-in-chrome-extensions) - 社区

### MV3 最佳实践
16. [Manifest V3 完整指南](https://codemyextension.com/resources/mv3-guide/) - 社区

### 开源项目
17. [SubtitleEasy](https://github.com/veraposeidon/subtitleeasy) - MIT
18. [DualSubs/YouTube](https://github.com/dualsubs/youtube) - Apache 2.0
19. [bilingual](https://github.com/thuan1412/bilingual) - YouTube 双语字幕
20. [Comet Translator](https://github.com/feechkablum6/comet-translator) - MIT
21. [AiTranslator](https://github.com/xPOURY4/AiTranslator-extension) - 多 AI 提供者
