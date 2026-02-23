import { PROVIDER_PRESETS, TRANSLATION_PORT_NAME } from "@shared/constants";
import {
  cleanupTranslationCache,
  getCachedTranslation,
  getSitePreference,
  getUserConfig,
  setCachedTranslation,
  setSitePreference,
  updateUserConfig
} from "@shared/storage";
import type {
  BatchTranslationItem,
  BatchTranslationPayload,
  ConfigTestRequest,
  ModelProvider,
  ResegmentPayload,
  RuntimeRequestMessage,
  RuntimeResponseMessage,
  TranslationPortIncomingMessage,
  TranslationRequestPayload
} from "@shared/types";

interface ChatMessage {
  role: "system" | "user";
  content: string;
}

interface OpenAICompatibleResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
}

interface OpenAIStreamChunk {
  choices?: Array<{
    delta?: { content?: string };
  }>;
}

interface GeminiGenerateResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{ text?: string }>;
    };
  }>;
}

interface ProviderApiConfig {
  provider: ModelProvider;
  apiKey: string;
  baseURL: string;
  model: string;
}

function normalizeOpenAICompletionsEndpoint(baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/, "");
  if (/\/chat\/completions$/i.test(trimmed)) {
    return trimmed;
  }
  return `${trimmed}/chat/completions`;
}

function normalizeGeminiBaseURL(baseURL: string): string {
  const trimmed = baseURL.trim().replace(/\/+$/, "");
  return trimmed.replace(/\/models$/i, "");
}

function normalizeGeminiModel(model: string): string {
  return model.trim().replace(/^models\//i, "");
}

function isGeminiProvider(provider: ModelProvider): boolean {
  return provider === "gemini";
}

function extractGeminiText(data: GeminiGenerateResponse): string {
  return (
    data.candidates?.[0]?.content?.parts
      ?.map((part) => part.text ?? "")
      .join("")
      .trim() ?? ""
  );
}

function buildGeminiBody(messages: ChatMessage[]): {
  contents: Array<{
    role: "user";
    parts: Array<{ text: string }>;
  }>;
  systemInstruction?: {
    parts: Array<{ text: string }>;
  };
  generationConfig: {
    temperature: number;
  };
} {
  const systemText = messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n\n")
    .trim();

  const userText = messages
    .filter((message) => message.role === "user")
    .map((message) => message.content)
    .join("\n\n")
    .trim();

  return {
    contents: [
      {
        role: "user",
        parts: [{ text: userText }]
      }
    ],
    ...(systemText
      ? {
          systemInstruction: {
            parts: [{ text: systemText }]
          }
        }
      : {}),
    generationConfig: {
      temperature: 0.2
    }
  };
}

function buildGeminiEndpoint(
  baseURL: string,
  model: string,
  apiKey: string,
  stream: boolean
): string {
  const root = normalizeGeminiBaseURL(baseURL);
  const normalizedModel = normalizeGeminiModel(model);
  const action = stream ? ":streamGenerateContent" : ":generateContent";
  const url = new URL(`${root}/models/${normalizedModel}${action}`);
  if (stream) {
    url.searchParams.set("alt", "sse");
  }
  url.searchParams.set("key", apiKey);
  return url.toString();
}

function resolveApiConfig(config: ProviderApiConfig): ProviderApiConfig {
  const preset = PROVIDER_PRESETS[config.provider];
  return {
    provider: config.provider,
    apiKey: config.apiKey.trim(),
    baseURL: (config.baseURL || preset.baseURL).trim(),
    model: (config.model || preset.model).trim()
  };
}

function getCacheScope(payload: TranslationRequestPayload): string {
  if (payload.metadata.videoId) {
    return `youtube:${payload.metadata.videoId}`;
  }
  if (payload.metadata.siteKey) {
    return `site:${payload.metadata.siteKey}`;
  }
  if (payload.metadata.url) {
    return `url:${payload.metadata.url}`;
  }
  return `source:${payload.metadata.source}`;
}

function joinContext(lines: string[]): string {
  return lines
    .map((item) => item.trim())
    .filter(Boolean)
    .join("\n");
}

function buildSingleTranslationMessages(
  payload: TranslationRequestPayload,
  targetLang: string
): ChatMessage[] {
  const before = joinContext(payload.contextBefore);
  const after = joinContext(payload.contextAfter);
  const sourceLabel =
    payload.metadata.source === "youtube" ? "YouTube 字幕" : "网页内容";

  const systemPrompt =
    "你是一个专业翻译引擎。将英文翻译成目标语言，保持语气和术语一致。" +
    "仅输出译文，不要解释，不要额外补充。";

  const userPrompt = [
    `目标语言: ${targetLang}`,
    `内容来源: ${sourceLabel}`,
    before ? `前文上下文:\n${before}` : "前文上下文: 无",
    after ? `后文上下文:\n${after}` : "后文上下文: 无",
    "请翻译以下文本:",
    payload.text
  ].join("\n\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];
}

function buildBatchTranslationMessages(
  payload: BatchTranslationPayload,
  targetLang: string
): ChatMessage[] {
  const compactItems = payload.items.map((item) => ({
    id: item.id,
    text: item.text,
    contextBefore: item.contextBefore,
    contextAfter: item.contextAfter
  }));

  const systemPrompt =
    "你是一个专业翻译引擎。你会收到多条英文文本及其上下文，" +
    "请输出 JSON 对象，键为 id，值为对应译文。只输出合法 JSON。";

  const userPrompt = [
    `目标语言: ${targetLang}`,
    "输入数据(JSON数组):",
    JSON.stringify(compactItems),
    '输出格式示例: {"id1":"译文1","id2":"译文2"}',
    "请开始翻译。"
  ].join("\n\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];
}

function buildResegmentMessages(payload: ResegmentPayload): ChatMessage[] {
  const systemPrompt = [
    "你是一个字幕断句引擎。",
    "你会收到自动语音识别生成的字幕片段列表，片段断句不自然且不完整。",
    "请将片段重新组合为完整、自然的句子。",
    "严格遵守：",
    "1. 保留所有原始内容，不添加、不删除、不改写词语。",
    "2. 只重排断句，不翻译。",
    "3. 保持原始语言。",
    "4. 输出必须是合法 JSON 字符串数组。"
  ].join("\n");

  const userPrompt = [
    "输入片段(JSON数组):",
    JSON.stringify(payload.texts),
    '输出格式示例: ["完整句子1","完整句子2"]',
    "请开始重排断句。"
  ].join("\n\n");

  return [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];
}

async function nonStreamChatCompletion(
  config: ProviderApiConfig,
  messages: ChatMessage[]
): Promise<string> {
  const resolved = resolveApiConfig(config);

  if (isGeminiProvider(resolved.provider)) {
    const response = await fetch(
      buildGeminiEndpoint(
        resolved.baseURL,
        resolved.model,
        resolved.apiKey,
        false
      ),
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json"
        },
        body: JSON.stringify(buildGeminiBody(messages))
      }
    );

    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Gemini 请求失败(${response.status}): ${detail}`);
    }

    const data = (await response.json()) as GeminiGenerateResponse;
    const content = extractGeminiText(data);
    if (!content) {
      throw new Error("Gemini 返回了空内容。");
    }
    return content;
  }

  const response = await fetch(
    normalizeOpenAICompletionsEndpoint(resolved.baseURL),
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${resolved.apiKey}`
      },
      body: JSON.stringify({
        model: resolved.model,
        messages,
        temperature: 0.2,
        stream: false
      })
    }
  );

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`翻译请求失败(${response.status}): ${detail}`);
  }

  const data = (await response.json()) as OpenAICompatibleResponse;
  const content = data.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new Error("翻译接口返回了空内容。");
  }
  return content;
}

function extractJsonObject(text: string): Record<string, string> | null {
  const trimmed = text.trim().replace(/^```json/i, "").replace(/```$/i, "").trim();
  const first = trimmed.indexOf("{");
  const last = trimmed.lastIndexOf("}");
  if (first < 0 || last <= first) {
    return null;
  }
  const candidate = trimmed.slice(first, last + 1);
  try {
    return JSON.parse(candidate) as Record<string, string>;
  } catch (_error) {
    return null;
  }
}

function extractJsonStringArray(text: string): string[] | null {
  const trimmed = text
    .trim()
    .replace(/^```(?:json)?/i, "")
    .replace(/```$/i, "")
    .trim();
  const first = trimmed.indexOf("[");
  const last = trimmed.lastIndexOf("]");
  if (first < 0 || last <= first) {
    return null;
  }
  try {
    const parsed = JSON.parse(trimmed.slice(first, last + 1)) as unknown;
    if (!Array.isArray(parsed)) {
      return null;
    }
    const normalized = parsed
      .map((item) => (typeof item === "string" ? item.trim() : ""))
      .filter(Boolean);
    return normalized.length > 0 ? normalized : null;
  } catch (_error) {
    return null;
  }
}

async function streamChatCompletion(
  config: ProviderApiConfig,
  messages: ChatMessage[],
  onChunk: (chunk: string) => void
): Promise<string> {
  const resolved = resolveApiConfig(config);

  const response = isGeminiProvider(resolved.provider)
    ? await fetch(
        buildGeminiEndpoint(
          resolved.baseURL,
          resolved.model,
          resolved.apiKey,
          true
        ),
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json"
          },
          body: JSON.stringify(buildGeminiBody(messages))
        }
      )
    : await fetch(normalizeOpenAICompletionsEndpoint(resolved.baseURL), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${resolved.apiKey}`
        },
        body: JSON.stringify({
          model: resolved.model,
          messages,
          temperature: 0.2,
          stream: true
        })
      });

  if (!response.ok) {
    const detail = await response.text();
    throw new Error(`流式翻译请求失败(${response.status}): ${detail}`);
  }

  if (!response.body) {
    throw new Error("流式翻译响应没有可读数据流。");
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let fullText = "";
  let geminiObserved = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) {
      break;
    }
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || !trimmed.startsWith("data:")) {
        continue;
      }
      const data = trimmed.slice(5).trim();
      if (data === "[DONE]") {
        continue;
      }
      try {
        if (isGeminiProvider(resolved.provider)) {
          const json = JSON.parse(data) as GeminiGenerateResponse;
          const piece = extractGeminiText(json);
          if (!piece) {
            continue;
          }
          let delta = piece;
          if (piece.startsWith(geminiObserved)) {
            delta = piece.slice(geminiObserved.length);
            geminiObserved = piece;
          } else {
            geminiObserved += piece;
          }
          if (!delta) {
            continue;
          }
          fullText += delta;
          onChunk(delta);
        } else {
          const json = JSON.parse(data) as OpenAIStreamChunk;
          const chunk = json.choices?.[0]?.delta?.content ?? "";
          if (chunk) {
            fullText += chunk;
            onChunk(chunk);
          }
        }
      } catch (_error) {
        // 忽略非 JSON 行
      }
    }
  }

  if (!fullText.trim()) {
    throw new Error("模型未返回可用译文。");
  }

  return fullText.trim();
}

function safePostMessage(port: chrome.runtime.Port, payload: unknown): void {
  try {
    port.postMessage(payload);
  } catch (_error) {
    // Port 已断开时忽略
  }
}

async function handleSingleTranslation(
  port: chrome.runtime.Port,
  payload: TranslationRequestPayload
): Promise<void> {
  const config = await getUserConfig();
  if (!config.apiKey.trim()) {
    safePostMessage(port, {
      type: "translate:error",
      payload: {
        requestId: payload.requestId,
        message: "请先在设置页填写 API Key。"
      }
    });
    return;
  }

  const targetLang = payload.targetLang ?? config.targetLang;
  const scope = getCacheScope(payload);
  const cached = await getCachedTranslation(scope, payload.text, targetLang);
  if (cached) {
    safePostMessage(port, {
      type: "translate:done",
      payload: {
        requestId: payload.requestId,
        translation: cached,
        cached: true
      }
    });
    return;
  }

  const messages = buildSingleTranslationMessages(payload, targetLang);
  const shouldStream = payload.stream !== false;
  const providerConfig: ProviderApiConfig = {
    provider: config.provider,
    apiKey: config.apiKey,
    baseURL: config.baseURL,
    model: config.model
  };
  try {
    const translation = shouldStream
      ? await streamChatCompletion(
          providerConfig,
          messages,
          (chunk) => {
            safePostMessage(port, {
              type: "translate:chunk",
              payload: {
                requestId: payload.requestId,
                chunk
              }
            });
          }
        )
      : await nonStreamChatCompletion(
          providerConfig,
          messages
        );

    await setCachedTranslation(scope, payload.text, targetLang, translation);
    safePostMessage(port, {
      type: "translate:done",
      payload: {
        requestId: payload.requestId,
        translation
      }
    });
  } catch (error) {
    safePostMessage(port, {
      type: "translate:error",
      payload: {
        requestId: payload.requestId,
        message: error instanceof Error ? error.message : "翻译失败。"
      }
    });
  }
}

async function fallbackBatchBySingle(
  config: Awaited<ReturnType<typeof getUserConfig>>,
  payload: BatchTranslationPayload,
  targetLang: string
): Promise<Record<string, string>> {
  const result: Record<string, string> = {};
  for (const item of payload.items) {
    const request: TranslationRequestPayload = {
      requestId: item.id,
      text: item.text,
      contextBefore: item.contextBefore,
      contextAfter: item.contextAfter,
      targetLang,
      stream: false,
      metadata: {
        source: payload.source,
        url: payload.metadata?.url,
        siteKey: payload.metadata?.siteKey,
        videoId: payload.metadata?.videoId
      }
    };
    const messages = buildSingleTranslationMessages(request, targetLang);
    const providerConfig: ProviderApiConfig = {
      provider: config.provider,
      apiKey: config.apiKey,
      baseURL: config.baseURL,
      model: config.model
    };
    const translated = await nonStreamChatCompletion(
      providerConfig,
      messages
    );
    result[item.id] = translated;
  }
  return result;
}

function makeBatchCacheScope(
  source: BatchTranslationPayload["source"],
  metadata: BatchTranslationPayload["metadata"]
): string {
  if (metadata?.videoId) {
    return `youtube:${metadata.videoId}`;
  }
  if (metadata?.siteKey) {
    return `site:${metadata.siteKey}`;
  }
  if (metadata?.url) {
    return `url:${metadata.url}`;
  }
  return `source:${source}`;
}

async function handleBatchTranslation(
  port: chrome.runtime.Port,
  payload: BatchTranslationPayload
): Promise<void> {
  const config = await getUserConfig();
  if (!config.apiKey.trim()) {
    safePostMessage(port, {
      type: "translate:error",
      payload: {
        requestId: payload.requestId,
        message: "请先在设置页填写 API Key。"
      }
    });
    return;
  }

  const targetLang = payload.targetLang ?? config.targetLang;
  const scope = makeBatchCacheScope(payload.source, payload.metadata);

  const finalResult: Record<string, string> = {};
  const uncachedItems: BatchTranslationItem[] = [];

  for (const item of payload.items) {
    const cached = await getCachedTranslation(scope, item.text, targetLang);
    if (cached) {
      finalResult[item.id] = cached;
    } else {
      uncachedItems.push(item);
    }
  }

  if (uncachedItems.length > 0) {
    try {
      const messages = buildBatchTranslationMessages(
        {
          ...payload,
          items: uncachedItems
        },
        targetLang
      );
      const responseText = await nonStreamChatCompletion(
        {
          provider: config.provider,
          apiKey: config.apiKey,
          baseURL: config.baseURL,
          model: config.model
        },
        messages
      );
      const parsed = extractJsonObject(responseText);
      let translated: Record<string, string>;

      if (!parsed) {
        translated = await fallbackBatchBySingle(
          config,
          {
            ...payload,
            items: uncachedItems
          },
          targetLang
        );
      } else {
        translated = parsed;
        const missingItems = uncachedItems.filter((item) => !translated[item.id]);
        if (missingItems.length > 0) {
          const fallback = await fallbackBatchBySingle(
            config,
            {
              ...payload,
              items: missingItems
            },
            targetLang
          );
          translated = { ...translated, ...fallback };
        }
      }

      for (const item of uncachedItems) {
        const value = translated[item.id];
        if (value) {
          finalResult[item.id] = value;
          await setCachedTranslation(scope, item.text, targetLang, value);
        }
      }
    } catch (error) {
      safePostMessage(port, {
        type: "translate:error",
        payload: {
          requestId: payload.requestId,
          message: error instanceof Error ? error.message : "批量翻译失败。"
        }
      });
      return;
    }
  }

  safePostMessage(port, {
    type: "translate:batchDone",
    payload: {
      requestId: payload.requestId,
      translations: finalResult
    }
  });
}

async function handleResegment(
  port: chrome.runtime.Port,
  payload: ResegmentPayload
): Promise<void> {
  const config = await getUserConfig();
  if (!config.apiKey.trim()) {
    safePostMessage(port, {
      type: "translate:error",
      payload: {
        requestId: payload.requestId,
        message: "请先在设置页填写 API Key。"
      }
    });
    return;
  }

  const texts = payload.texts
    .map((item) => item.replace(/\s+/g, " ").trim())
    .filter(Boolean);
  if (texts.length === 0) {
    safePostMessage(port, {
      type: "translate:resegmentDone",
      payload: {
        requestId: payload.requestId,
        sentences: []
      }
    });
    return;
  }

  try {
    const messages = buildResegmentMessages({
      requestId: payload.requestId,
      texts
    });
    const responseText = await nonStreamChatCompletion(
      {
        provider: config.provider,
        apiKey: config.apiKey,
        baseURL: config.baseURL,
        model: config.model
      },
      messages
    );
    const sentences = extractJsonStringArray(responseText);
    if (!sentences) {
      throw new Error("字幕重排结果解析失败。");
    }
    safePostMessage(port, {
      type: "translate:resegmentDone",
      payload: {
        requestId: payload.requestId,
        sentences
      }
    });
  } catch (error) {
    safePostMessage(port, {
      type: "translate:error",
      payload: {
        requestId: payload.requestId,
        message: error instanceof Error ? error.message : "字幕重排失败。"
      }
    });
  }
}

chrome.runtime.onConnect.addListener((port) => {
  if (!port.name.startsWith(TRANSLATION_PORT_NAME)) {
    return;
  }

  port.onMessage.addListener((raw: TranslationPortIncomingMessage) => {
    if (!raw || typeof raw !== "object") {
      return;
    }

    if (raw.type === "translate:start") {
      void handleSingleTranslation(port, raw.payload);
      return;
    }

    if (raw.type === "translate:batch") {
      void handleBatchTranslation(port, raw.payload);
      return;
    }

    if (raw.type === "translate:resegment") {
      void handleResegment(port, raw.payload);
    }
  });
});

async function testConnection(payload: ConfigTestRequest): Promise<void> {
  const probeMessages: ChatMessage[] = [
    { role: "system", content: "你是翻译助手。" },
    { role: "user", content: "Translate 'Hello world' into Chinese." }
  ];

  await nonStreamChatCompletion(
    {
      provider: payload.provider,
      apiKey: payload.apiKey,
      baseURL: payload.baseURL,
      model: payload.model
    },
    probeMessages
  );
}

chrome.runtime.onMessage.addListener(
  (
    message: RuntimeRequestMessage,
    _sender,
    sendResponse: (response: RuntimeResponseMessage) => void
  ) => {
    if (!message || typeof message !== "object") {
      return;
    }

    if (message.type === "config:get") {
      void (async () => {
        const config = await getUserConfig();
        sendResponse({ ok: true, config });
      })();
      return true;
    }

    if (message.type === "config:update") {
      void (async () => {
        try {
          const config = await updateUserConfig(message.payload);
          sendResponse({ ok: true, config });
        } catch (error) {
          sendResponse({
            ok: false,
            error: error instanceof Error ? error.message : "配置更新失败。"
          });
        }
      })();
      return true;
    }

    if (message.type === "config:test") {
      void (async () => {
        try {
          await testConnection(message.payload);
          sendResponse({ ok: true, message: "连接测试成功。" });
        } catch (error) {
          sendResponse({
            ok: false,
            error:
              error instanceof Error
                ? error.message
                : "连接测试失败，请检查端点或 API Key。"
          });
        }
      })();
      return true;
    }

    if (message.type === "site:get") {
      void (async () => {
        const site = await getSitePreference(message.payload.siteKey);
        sendResponse({ ok: true, site });
      })();
      return true;
    }

    if (message.type === "site:toggle") {
      void (async () => {
        const site = await setSitePreference(
          message.payload.siteKey,
          message.payload.enabled
        );
        sendResponse({ ok: true, site });
      })();
      return true;
    }
  }
);

void cleanupTranslationCache();
