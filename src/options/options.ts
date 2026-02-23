import { sendRuntimeMessage } from "@shared/messaging";
import { PROVIDER_PRESETS } from "@shared/constants";
import type { ModelProvider, UserConfig } from "@shared/types";

function queryElement<T extends HTMLElement>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (!element) {
    throw new Error(`Options 缺少节点: ${selector}`);
  }
  return element;
}

const form = queryElement<HTMLFormElement>("#config-form");
const statusText = queryElement<HTMLSpanElement>("#status-text");
const providerSelect = queryElement<HTMLSelectElement>("#provider");
const apiKeyInput = queryElement<HTMLInputElement>("#apiKey");
const baseURLInput = queryElement<HTMLInputElement>("#baseURL");
const modelInput = queryElement<HTMLInputElement>("#model");
const targetLangSelect = queryElement<HTMLSelectElement>("#targetLang");
const contextWindowInput = queryElement<HTMLInputElement>("#contextWindow");
const subtitleContextWindowInput = queryElement<HTMLInputElement>(
  "#subtitleContextWindow"
);
const autoTranslateInput = queryElement<HTMLInputElement>("#autoTranslate");
const fontSizeInput = queryElement<HTMLInputElement>("#fontSize");
const fontColorInput = queryElement<HTMLInputElement>("#fontColor");
const backgroundColorInput = queryElement<HTMLInputElement>("#backgroundColor");
const borderColorInput = queryElement<HTMLInputElement>("#borderColor");
const testConnectionButton = queryElement<HTMLButtonElement>("#test-connection");
let previousProvider: ModelProvider = "openai";

function setStatus(text: string, isError = false): void {
  statusText.textContent = text;
  statusText.style.color = isError ? "#b91c1c" : "#334155";
}

function fillForm(config: UserConfig): void {
  providerSelect.value = config.provider;
  apiKeyInput.value = config.apiKey;
  baseURLInput.value = config.baseURL;
  modelInput.value = config.model;
  targetLangSelect.value = config.targetLang;
  contextWindowInput.value = String(config.contextWindow);
  subtitleContextWindowInput.value = String(config.subtitleContextWindow);
  autoTranslateInput.checked = config.autoTranslate;
  fontSizeInput.value = config.translationStyle.fontSize;
  fontColorInput.value = config.translationStyle.color;
  backgroundColorInput.value = config.translationStyle.backgroundColor;
  borderColorInput.value = config.translationStyle.borderColor;
  previousProvider = config.provider;
  apiKeyInput.placeholder = PROVIDER_PRESETS[config.provider].apiKeyPlaceholder;
}

function clampNumber(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function collectPatch(): Partial<UserConfig> {
  const provider = providerSelect.value as ModelProvider;
  const contextWindow = clampNumber(Number(contextWindowInput.value || 3), 1, 8);
  const subtitleContextWindow = clampNumber(
    Number(subtitleContextWindowInput.value || 8),
    2,
    20
  );

  return {
    provider,
    apiKey: apiKeyInput.value.trim(),
    baseURL: baseURLInput.value.trim(),
    model: modelInput.value.trim(),
    targetLang: targetLangSelect.value,
    contextWindow,
    subtitleContextWindow,
    autoTranslate: autoTranslateInput.checked,
    translationStyle: {
      fontSize: fontSizeInput.value.trim() || "0.92em",
      color: fontColorInput.value,
      backgroundColor: backgroundColorInput.value,
      borderColor: borderColorInput.value
    }
  };
}

function applyProviderPreset(nextProvider: ModelProvider): void {
  const nextPreset = PROVIDER_PRESETS[nextProvider];
  const previousPreset = PROVIDER_PRESETS[previousProvider];

  const currentBaseURL = baseURLInput.value.trim();
  if (!currentBaseURL || currentBaseURL === previousPreset.baseURL) {
    baseURLInput.value = nextPreset.baseURL;
  }

  const currentModel = modelInput.value.trim();
  if (!currentModel || currentModel === previousPreset.model) {
    modelInput.value = nextPreset.model;
  }

  apiKeyInput.placeholder = nextPreset.apiKeyPlaceholder;
  previousProvider = nextProvider;
}

async function loadConfig(): Promise<void> {
  const response = await sendRuntimeMessage({ type: "config:get" });
  if (!response.ok || !("config" in response)) {
    setStatus("配置读取失败，请检查扩展状态。", true);
    return;
  }
  fillForm(response.config);
  setStatus("配置已加载");
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  void (async () => {
    const patch = collectPatch();
    const response = await sendRuntimeMessage({
      type: "config:update",
      payload: patch
    });
    if (!response.ok) {
      setStatus(`保存失败: ${response.error}`, true);
      return;
    }
    if ("config" in response) {
      fillForm(response.config);
    }
    setStatus("配置已保存");
  })();
});

testConnectionButton.addEventListener("click", () => {
  void (async () => {
    setStatus("正在测试连接...");
    const response = await sendRuntimeMessage({
      type: "config:test",
      payload: {
        provider: providerSelect.value as ModelProvider,
        apiKey: apiKeyInput.value.trim(),
        baseURL: baseURLInput.value.trim(),
        model: modelInput.value.trim()
      }
    });
    if (!response.ok) {
      setStatus(`连接失败: ${response.error}`, true);
      return;
    }
    setStatus("连接测试成功");
  })();
});

providerSelect.addEventListener("change", () => {
  applyProviderPreset(providerSelect.value as ModelProvider);
  setStatus("已切换服务商默认配置，请检查后保存");
});

void loadConfig();
