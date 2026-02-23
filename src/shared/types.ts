export type TranslationSource = "webpage" | "youtube";
export type ModelProvider = "openai" | "gemini" | "minimax" | "kimi";

export interface TranslationStyle {
  fontSize: string;
  color: string;
  backgroundColor: string;
  borderColor: string;
}

export interface UserConfig {
  provider: ModelProvider;
  apiKey: string;
  baseURL: string;
  model: string;
  targetLang: string;
  contextWindow: number;
  subtitleContextWindow: number;
  autoTranslate: boolean;
  translationStyle: TranslationStyle;
}

export interface TranslationMetadata {
  source: TranslationSource;
  url?: string;
  siteKey?: string;
  elementPath?: string;
  videoId?: string;
}

export interface TranslationRequestPayload {
  requestId: string;
  text: string;
  contextBefore: string[];
  contextAfter: string[];
  targetLang?: string;
  stream?: boolean;
  metadata: TranslationMetadata;
}

export interface BatchTranslationItem {
  id: string;
  text: string;
  contextBefore: string[];
  contextAfter: string[];
}

export interface BatchTranslationPayload {
  requestId: string;
  source: TranslationSource;
  items: BatchTranslationItem[];
  targetLang?: string;
  metadata?: Omit<TranslationMetadata, "source">;
}

export interface TranslationChunkPayload {
  requestId: string;
  chunk: string;
}

export interface TranslationDonePayload {
  requestId: string;
  translation: string;
  cached?: boolean;
}

export interface BatchTranslationDonePayload {
  requestId: string;
  translations: Record<string, string>;
}

export interface ResegmentPayload {
  requestId: string;
  texts: string[];
}

export interface ResegmentDonePayload {
  requestId: string;
  sentences: string[];
}

export interface TranslationErrorPayload {
  requestId: string;
  message: string;
}

export type TranslationPortIncomingMessage =
  | { type: "translate:start"; payload: TranslationRequestPayload }
  | { type: "translate:batch"; payload: BatchTranslationPayload }
  | { type: "translate:resegment"; payload: ResegmentPayload };

export type TranslationPortOutgoingMessage =
  | { type: "translate:chunk"; payload: TranslationChunkPayload }
  | { type: "translate:done"; payload: TranslationDonePayload }
  | { type: "translate:batchDone"; payload: BatchTranslationDonePayload }
  | { type: "translate:resegmentDone"; payload: ResegmentDonePayload }
  | { type: "translate:error"; payload: TranslationErrorPayload };

export interface TranslationProgress {
  total: number;
  translated: number;
  inflight: number;
  pending: number;
}

export interface PageTranslationStatus {
  enabled: boolean;
  progress: TranslationProgress;
  lastError?: string;
}

export interface SitePreference {
  enabled: boolean;
  updatedAt: number;
}

export interface TranslationCacheRecord {
  translation: string;
  timestamp: number;
}

export interface ConfigTestRequest {
  provider: ModelProvider;
  apiKey: string;
  baseURL: string;
  model: string;
}

export type RuntimeRequestMessage =
  | { type: "config:get" }
  | { type: "config:update"; payload: Partial<UserConfig> }
  | { type: "config:test"; payload: ConfigTestRequest }
  | { type: "site:toggle"; payload: { siteKey: string; enabled: boolean } }
  | { type: "site:get"; payload: { siteKey: string } }
  | { type: "page:get-status" }
  | { type: "page:toggle"; payload: { enabled: boolean } };

export type RuntimeResponseMessage =
  | { ok: true; config: UserConfig }
  | { ok: true; site: SitePreference | null }
  | { ok: true; status: PageTranslationStatus }
  | { ok: true; message?: string }
  | { ok: false; error: string };

export interface YouTubeCaptionTrack {
  baseUrl: string;
  languageCode: string;
  name?: string;
  kind?: string;
}

export interface SubtitleCue {
  start: number;
  duration: number;
  end: number;
  text: string;
}
