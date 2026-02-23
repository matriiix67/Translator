import type { ModelProvider, UserConfig } from "@shared/types";

export const TRANSLATION_PORT_NAME = "ai-translator-port";
export const PAGE_BRIDGE_EVENT = "ai-translator-youtube-tracks";
export const PAGE_BRIDGE_SOURCE = "ai-translator-bridge";

export const STORAGE_KEYS = {
  config: "userConfig",
  sitePreferences: "sitePreferences",
  translationCache: "translationCache"
} as const;

export interface ProviderPreset {
  label: string;
  baseURL: string;
  model: string;
  apiKeyPlaceholder: string;
}

export const PROVIDER_PRESETS: Record<ModelProvider, ProviderPreset> = {
  openai: {
    label: "OpenAI",
    baseURL: "https://api.openai.com/v1",
    model: "gpt-5-mini",
    apiKeyPlaceholder: "sk-..."
  },
  gemini: {
    label: "Google Gemini",
    baseURL: "https://generativelanguage.googleapis.com/v1beta",
    model: "gemini-2.5-flash",
    apiKeyPlaceholder: "AIza..."
  },
  minimax: {
    label: "MiniMax",
    baseURL: "https://api.minimax.chat/v1",
    model: "MiniMax-Text-01",
    apiKeyPlaceholder: "minimax-key..."
  },
  kimi: {
    label: "Kimi (Moonshot)",
    baseURL: "https://api.moonshot.cn/v1",
    model: "moonshot-v1-8k",
    apiKeyPlaceholder: "sk-..."
  }
};

export const DEFAULT_USER_CONFIG: UserConfig = {
  provider: "openai",
  apiKey: "",
  baseURL: PROVIDER_PRESETS.openai.baseURL,
  model: PROVIDER_PRESETS.openai.model,
  targetLang: "zh-CN",
  contextWindow: 3,
  subtitleContextWindow: 8,
  autoTranslate: false,
  translationStyle: {
    fontSize: "0.92em",
    color: "#2c3e50",
    backgroundColor: "#f6f8ff",
    borderColor: "#b9c4f5"
  }
};

export const CACHE_TTL_MS = 1000 * 60 * 60 * 24 * 7;
export const CACHE_MAX_ENTRIES = 5000;
export const DEFAULT_TRANSLATION_CONCURRENCY = 5;
export const DEFAULT_SUBTITLE_BATCH_SIZE = 24;

export const UI_SELECTORS = {
  popupApp: "#app",
  optionsApp: "#app"
} as const;
