import {
  CACHE_MAX_ENTRIES,
  CACHE_TTL_MS,
  DEFAULT_USER_CONFIG,
  PROVIDER_PRESETS,
  STORAGE_KEYS
} from "@shared/constants";
import type {
  ModelProvider,
  SitePreference,
  TranslationCacheRecord,
  TranslationStyle,
  UserConfig
} from "@shared/types";

type SitePreferenceMap = Record<string, SitePreference>;
type TranslationCacheMap = Record<string, TranslationCacheRecord>;

function getSyncValue<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.sync.get([key], (result) => {
      resolve(result[key] as T | undefined);
    });
  });
}

function setSyncValue<T>(key: string, value: T): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.sync.set({ [key]: value }, () => resolve());
  });
}

function getLocalValue<T>(key: string): Promise<T | undefined> {
  return new Promise((resolve) => {
    chrome.storage.local.get([key], (result) => {
      resolve(result[key] as T | undefined);
    });
  });
}

function setLocalValue<T>(key: string, value: T): Promise<void> {
  return new Promise((resolve) => {
    chrome.storage.local.set({ [key]: value }, () => resolve());
  });
}

function normalizeStyle(input?: Partial<TranslationStyle>): TranslationStyle {
  return {
    ...DEFAULT_USER_CONFIG.translationStyle,
    ...(input ?? {})
  };
}

function normalizeBaseURL(baseURL: string): string {
  return baseURL.trim().replace(/\/+$/, "");
}

function normalizeProvider(provider: unknown): ModelProvider {
  if (provider === "openai") {
    return "openai";
  }
  if (provider === "gemini") {
    return "gemini";
  }
  if (provider === "minimax") {
    return "minimax";
  }
  if (provider === "kimi") {
    return "kimi";
  }
  return DEFAULT_USER_CONFIG.provider;
}

function normalizeConfig(input?: Partial<UserConfig>): UserConfig {
  const merged = {
    ...DEFAULT_USER_CONFIG,
    ...(input ?? {})
  };
  const provider = normalizeProvider(merged.provider);
  const preset = PROVIDER_PRESETS[provider];
  const normalizedBaseURL = normalizeBaseURL(merged.baseURL || preset.baseURL);
  const normalizedModel = (merged.model || preset.model).trim();

  return {
    ...merged,
    provider,
    baseURL: normalizedBaseURL || preset.baseURL,
    model: normalizedModel || preset.model,
    translationStyle: normalizeStyle(merged.translationStyle)
  };
}

export async function getUserConfig(): Promise<UserConfig> {
  const saved = await getSyncValue<Partial<UserConfig>>(STORAGE_KEYS.config);
  return normalizeConfig(saved);
}

export async function updateUserConfig(
  patch: Partial<UserConfig>
): Promise<UserConfig> {
  const current = await getUserConfig();
  const next = normalizeConfig({
    ...current,
    ...patch,
    translationStyle: {
      ...current.translationStyle,
      ...(patch.translationStyle ?? {})
    }
  });
  await setSyncValue(STORAGE_KEYS.config, next);
  return next;
}

export function toSiteKey(url: string): string {
  try {
    const parsed = new URL(url);
    return parsed.hostname;
  } catch (_error) {
    return url;
  }
}

async function getSitePreferenceMap(): Promise<SitePreferenceMap> {
  return (await getLocalValue<SitePreferenceMap>(STORAGE_KEYS.sitePreferences)) ?? {};
}

export async function getSitePreference(
  siteKey: string
): Promise<SitePreference | null> {
  const map = await getSitePreferenceMap();
  return map[siteKey] ?? null;
}

export async function setSitePreference(
  siteKey: string,
  enabled: boolean
): Promise<SitePreference> {
  const map = await getSitePreferenceMap();
  const value: SitePreference = {
    enabled,
    updatedAt: Date.now()
  };
  map[siteKey] = value;
  await setLocalValue(STORAGE_KEYS.sitePreferences, map);
  return value;
}

function hashText(input: string): string {
  let hash = 5381;
  for (let index = 0; index < input.length; index += 1) {
    hash = (hash * 33) ^ input.charCodeAt(index);
  }
  return (hash >>> 0).toString(36);
}

function buildCacheKey(scope: string, text: string, targetLang: string): string {
  return `${scope}::${targetLang}::${hashText(text.trim())}`;
}

async function getCacheMap(): Promise<TranslationCacheMap> {
  return (
    (await getLocalValue<TranslationCacheMap>(STORAGE_KEYS.translationCache)) ?? {}
  );
}

function isExpired(record: TranslationCacheRecord): boolean {
  return Date.now() - record.timestamp > CACHE_TTL_MS;
}

export async function getCachedTranslation(
  scope: string,
  text: string,
  targetLang: string
): Promise<string | null> {
  if (!text.trim()) {
    return "";
  }
  const map = await getCacheMap();
  const cacheKey = buildCacheKey(scope, text, targetLang);
  const record = map[cacheKey];
  if (!record) {
    return null;
  }
  if (isExpired(record)) {
    delete map[cacheKey];
    await setLocalValue(STORAGE_KEYS.translationCache, map);
    return null;
  }
  return record.translation;
}

function pruneCache(
  map: TranslationCacheMap,
  maxEntries: number
): TranslationCacheMap {
  const entries = Object.entries(map).filter(([, value]) => !isExpired(value));
  if (entries.length <= maxEntries) {
    return Object.fromEntries(entries);
  }

  entries.sort((left, right) => right[1].timestamp - left[1].timestamp);
  return Object.fromEntries(entries.slice(0, maxEntries));
}

export async function setCachedTranslation(
  scope: string,
  text: string,
  targetLang: string,
  translation: string
): Promise<void> {
  if (!text.trim()) {
    return;
  }
  const map = await getCacheMap();
  const cacheKey = buildCacheKey(scope, text, targetLang);
  map[cacheKey] = {
    translation,
    timestamp: Date.now()
  };
  const pruned = pruneCache(map, CACHE_MAX_ENTRIES);
  await setLocalValue(STORAGE_KEYS.translationCache, pruned);
}

export async function cleanupTranslationCache(): Promise<void> {
  const map = await getCacheMap();
  const pruned = pruneCache(map, CACHE_MAX_ENTRIES);
  await setLocalValue(STORAGE_KEYS.translationCache, pruned);
}
