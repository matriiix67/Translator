import { sendRuntimeMessage } from "@shared/messaging";
import type {
  PageTranslationStatus,
  RuntimeRequestMessage,
  RuntimeResponseMessage
} from "@shared/types";

function queryElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Popup 缺少节点: ${selector}`);
  }
  return element;
}

const toggle = queryElement<HTMLInputElement>("#toggle-translation");
const progressText = queryElement<HTMLSpanElement>("#progress-text");
const progressBar = queryElement<HTMLDivElement>("#progress-bar");
const statusText = queryElement<HTMLParagraphElement>("#status-text");
const languageSelect = queryElement<HTMLSelectElement>("#quick-language");
const openOptionsButton = queryElement<HTMLButtonElement>("#open-options");

let activeTabId: number | null = null;
let pollTimer: number | null = null;

function setStatus(text: string): void {
  statusText.textContent = text;
}

async function getActiveTabId(): Promise<number | null> {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs[0]?.id ?? null;
}

async function sendMessageToTab(
  tabId: number,
  message: RuntimeRequestMessage
): Promise<RuntimeResponseMessage | null> {
  return new Promise((resolve) => {
    chrome.tabs.sendMessage(tabId, message, (response: RuntimeResponseMessage) => {
      if (chrome.runtime.lastError) {
        resolve(null);
        return;
      }
      resolve(response ?? null);
    });
  });
}

function renderStatus(status: PageTranslationStatus): void {
  const total = status.progress.total;
  const translated = status.progress.translated;
  const percent = total > 0 ? Math.min(100, Math.round((translated / total) * 100)) : 0;
  toggle.checked = status.enabled;
  progressText.textContent = `${translated} / ${total}`;
  progressBar.style.width = `${percent}%`;
  if (status.lastError) {
    setStatus(`错误: ${status.lastError}`);
    return;
  }
  if (!status.enabled) {
    setStatus("当前页面翻译已关闭");
    return;
  }
  if (translated >= total && total > 0) {
    setStatus("当前页面翻译完成");
    return;
  }
  setStatus("翻译进行中...");
}

async function refreshStatus(): Promise<void> {
  if (!activeTabId) {
    setStatus("未检测到可操作页面");
    return;
  }
  const response = await sendMessageToTab(activeTabId, { type: "page:get-status" });
  if (!response || !response.ok || !("status" in response)) {
    setStatus("该页面暂不支持翻译");
    return;
  }
  renderStatus(response.status);
}

async function loadConfig(): Promise<void> {
  const response = await sendRuntimeMessage({ type: "config:get" });
  if (!response.ok || !("config" in response)) {
    setStatus("无法读取配置，请检查扩展权限");
    return;
  }
  languageSelect.value = response.config.targetLang;
}

async function init(): Promise<void> {
  activeTabId = await getActiveTabId();
  await loadConfig();
  await refreshStatus();

  pollTimer = window.setInterval(() => {
    void refreshStatus();
  }, 1400);
}

toggle.addEventListener("change", () => {
  void (async () => {
    if (!activeTabId) {
      setStatus("未检测到可操作页面");
      return;
    }
    const response = await sendMessageToTab(activeTabId, {
      type: "page:toggle",
      payload: { enabled: toggle.checked }
    });
    if (!response || !response.ok || !("status" in response)) {
      setStatus("开关失败，请刷新页面后重试");
      return;
    }
    renderStatus(response.status);
  })();
});

languageSelect.addEventListener("change", () => {
  void (async () => {
    const response = await sendRuntimeMessage({
      type: "config:update",
      payload: {
        targetLang: languageSelect.value
      }
    });
    if (!response.ok) {
      setStatus(`保存语言失败: ${response.error}`);
      return;
    }
    setStatus("目标语言已更新");
    await refreshStatus();
  })();
});

openOptionsButton.addEventListener("click", () => {
  chrome.runtime.openOptionsPage();
});

window.addEventListener("unload", () => {
  if (pollTimer !== null) {
    window.clearInterval(pollTimer);
    pollTimer = null;
  }
});

void init();
