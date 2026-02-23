import { PAGE_BRIDGE_SOURCE } from "@shared/constants";
import type { YouTubeCaptionTrack } from "@shared/types";

interface PlayerTrackLike {
  languageCode?: string;
  kind?: string;
  baseUrl?: string;
  name?: {
    simpleText?: string;
    runs?: Array<{ text?: string }>;
  };
  displayName?: string;
  languageName?: string;
}

interface PlayerResponseLike {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: PlayerTrackLike[];
    };
  };
  videoDetails?: {
    videoId?: string;
  };
}

interface YouTubePlayerLike {
  loadModule?: (moduleName: string) => void;
  getOption?: (moduleName: string, optionName: string) => unknown;
  setOption?: (moduleName: string, optionName: string, value: unknown) => void;
}

interface InterceptedSubtitle {
  text: string;
  fmt: string;
  languageCode: string;
  kind?: string;
}

interface TracksResultPayload {
  videoId?: string;
  tracks: YouTubeCaptionTrack[];
}

interface SubtitleResultPayload {
  text: string;
  fmt: string;
  languageCode: string;
  kind?: string;
}

interface BridgeRequestTracksMessage {
  source: string;
  type: "tracks:get";
  requestId: string;
}

interface BridgeRequestSubtitleMessage {
  source: string;
  type: "subtitle:get";
  requestId: string;
  payload?: {
    languageCode?: string;
    kind?: string;
  };
}

type BridgeRequestMessage =
  | BridgeRequestTracksMessage
  | BridgeRequestSubtitleMessage;

declare global {
  interface Window {
    ytInitialPlayerResponse?: PlayerResponseLike;
    ytplayer?: {
      config?: {
        args?: {
          player_response?: string;
        };
      };
    };
    __aiTranslatorTimedtextHooked__?: boolean;
  }
}

const interceptedSubtitles = new Map<string, InterceptedSubtitle>();
const pendingByLang = new Map<
  string,
  Array<(subtitle: InterceptedSubtitle | null) => void>
>();

function normalizeLanguageCode(languageCode?: string): string {
  return (languageCode ?? "").trim().toLowerCase();
}

function normalizeKind(kind?: string): string {
  return (kind ?? "").trim().toLowerCase();
}

function subtitleKey(languageCode: string, kind?: string): string {
  return `${normalizeLanguageCode(languageCode)}:${normalizeKind(kind)}`;
}

function extractTrackName(track: PlayerTrackLike): string | undefined {
  const simple = track.name?.simpleText?.trim();
  if (simple) {
    return simple;
  }
  const fromRuns = track.name?.runs?.map((item) => item.text ?? "").join("").trim();
  if (fromRuns) {
    return fromRuns;
  }
  const displayName = track.displayName?.trim();
  if (displayName) {
    return displayName;
  }
  const languageName = track.languageName?.trim();
  if (languageName) {
    return languageName;
  }
  return undefined;
}

function getCurrentVideoId(): string | undefined {
  const fromUrl = new URL(window.location.href).searchParams.get("v");
  if (fromUrl) {
    return fromUrl;
  }
  return window.ytInitialPlayerResponse?.videoDetails?.videoId;
}

function readPlayerResponse(): PlayerResponseLike | null {
  if (window.ytInitialPlayerResponse) {
    return window.ytInitialPlayerResponse;
  }
  const rawResponse = window.ytplayer?.config?.args?.player_response;
  if (!rawResponse) {
    return null;
  }
  try {
    return JSON.parse(rawResponse) as PlayerResponseLike;
  } catch {
    return null;
  }
}

function getMoviePlayer(): YouTubePlayerLike | null {
  return document.querySelector("#movie_player") as unknown as YouTubePlayerLike | null;
}

function tracksFromPlayerResponse(): YouTubeCaptionTrack[] {
  const captionTracks =
    readPlayerResponse()?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return captionTracks
    .filter((track) => Boolean(track.baseUrl && track.languageCode))
    .map((track) => ({
      baseUrl: track.baseUrl as string,
      languageCode: track.languageCode as string,
      kind: track.kind,
      name: extractTrackName(track)
    }));
}

function tracksFromPlayerObject(): YouTubeCaptionTrack[] {
  const player = getMoviePlayer();
  if (!player?.getOption) {
    return [];
  }
  const tracklist = player.getOption("captions", "tracklist");
  if (!Array.isArray(tracklist)) {
    return [];
  }
  return (tracklist as PlayerTrackLike[])
    .filter((track) => Boolean(track.languageCode))
    .map((track) => ({
      // 轨道列表中的 baseUrl 不一定可用；后续会用 readPlayerResponse 结果补齐
      baseUrl: track.baseUrl ?? "",
      languageCode: track.languageCode as string,
      kind: track.kind,
      name: extractTrackName(track)
    }));
}

function mergeTracks(
  primary: YouTubeCaptionTrack[],
  secondary: YouTubeCaptionTrack[]
): YouTubeCaptionTrack[] {
  const byKey = new Map<string, YouTubeCaptionTrack>();
  for (const track of [...primary, ...secondary]) {
    const key = subtitleKey(track.languageCode, track.kind);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, track);
      continue;
    }
    if (!existing.baseUrl && track.baseUrl) {
      existing.baseUrl = track.baseUrl;
    }
    if (!existing.name && track.name) {
      existing.name = track.name;
    }
  }
  return Array.from(byKey.values());
}

function getAvailableTracks(): YouTubeCaptionTrack[] {
  return mergeTracks(tracksFromPlayerResponse(), tracksFromPlayerObject());
}

function parseTimedtextMeta(rawUrl: string): {
  languageCode: string;
  kind?: string;
  fmt: string;
} | null {
  try {
    const url = new URL(rawUrl, window.location.origin);
    if (!url.pathname.includes("/api/timedtext")) {
      return null;
    }
    const languageCode = normalizeLanguageCode(url.searchParams.get("lang") ?? undefined);
    if (!languageCode) {
      return null;
    }
    const kind = url.searchParams.get("kind") ?? undefined;
    const fmt = url.searchParams.get("fmt") ?? "xml";
    return { languageCode, kind, fmt };
  } catch {
    return null;
  }
}

function resolvePending(languageCode: string): void {
  const key = normalizeLanguageCode(languageCode);
  const resolvers = pendingByLang.get(key);
  if (!resolvers || resolvers.length === 0) {
    return;
  }
  pendingByLang.delete(key);
  const subtitle =
    interceptedSubtitles.get(`${key}:asr`) ??
    interceptedSubtitles.get(`${key}:`) ??
    null;
  for (const resolve of resolvers) {
    resolve(subtitle);
  }
}

function storeInterceptedSubtitle(rawUrl: string, text: string): void {
  const trimmed = text.trim();
  if (!trimmed) {
    return;
  }
  const meta = parseTimedtextMeta(rawUrl);
  if (!meta) {
    return;
  }
  const payload: InterceptedSubtitle = {
    text: trimmed,
    fmt: meta.fmt,
    languageCode: meta.languageCode,
    kind: meta.kind
  };
  interceptedSubtitles.set(subtitleKey(meta.languageCode, meta.kind), payload);
  interceptedSubtitles.set(subtitleKey(meta.languageCode), payload);
  resolvePending(meta.languageCode);
}

function installNetworkInterceptors(): void {
  if (window.__aiTranslatorTimedtextHooked__) {
    return;
  }
  window.__aiTranslatorTimedtextHooked__ = true;

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  XMLHttpRequest.prototype.open = function (
    method: string,
    url: string | URL,
    async?: boolean,
    username?: string | null,
    password?: string | null
  ): void {
    const xhr = this as XMLHttpRequest & { __aiTranslatorTimedtextURL?: string };
    xhr.__aiTranslatorTimedtextURL =
      typeof url === "string" ? url : url.toString();
    originalOpen.call(this, method, url, async ?? true, username, password);
  };
  XMLHttpRequest.prototype.send = function (body?: Document | XMLHttpRequestBodyInit | null): void {
    const xhr = this as XMLHttpRequest & { __aiTranslatorTimedtextURL?: string };
    const requestUrl = xhr.__aiTranslatorTimedtextURL ?? "";
    if (requestUrl.includes("/api/timedtext")) {
      xhr.addEventListener(
        "load",
        () => {
          try {
            if (typeof xhr.responseText === "string") {
              storeInterceptedSubtitle(requestUrl, xhr.responseText);
            }
          } catch {
            // ignore
          }
        },
        { once: true }
      );
    }
    originalSend.call(this, body);
  };

  const originalFetch = window.fetch.bind(window);
  window.fetch = (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const requestUrl =
      typeof input === "string"
        ? input
        : input instanceof Request
          ? input.url
          : input.toString();

    // 非字幕请求直接透传，避免把页面其他 CORS/广告请求栈定位到本桥接脚本。
    if (!requestUrl.includes("/api/timedtext")) {
      return originalFetch(input, init);
    }

    return originalFetch(input, init).then((response) => {
      try {
        const clone = response.clone();
        void clone
          .text()
          .then((text) => storeInterceptedSubtitle(requestUrl, text))
          .catch(() => {
            // ignore
          });
      } catch {
        // ignore
      }
      return response;
    });
  };
}

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

async function waitForTracklist(player: YouTubePlayerLike): Promise<PlayerTrackLike[]> {
  for (let i = 0; i < 16; i += 1) {
    const value = player.getOption?.("captions", "tracklist");
    if (Array.isArray(value) && value.length > 0) {
      return value as PlayerTrackLike[];
    }
    await wait(250);
  }
  return [];
}

function pickTrackForLanguage(
  tracks: PlayerTrackLike[],
  languageCode: string,
  kind?: string
): PlayerTrackLike | null {
  const lang = normalizeLanguageCode(languageCode);
  const normalizedKind = normalizeKind(kind);
  const exact = tracks.find(
    (track) =>
      normalizeLanguageCode(track.languageCode) === lang &&
      normalizeKind(track.kind) === normalizedKind
  );
  if (exact) {
    return exact;
  }
  const byLang = tracks.find(
    (track) => normalizeLanguageCode(track.languageCode) === lang
  );
  if (byLang) {
    return byLang;
  }
  return tracks[0] ?? null;
}

async function triggerCaptionLoad(languageCode: string, kind?: string): Promise<boolean> {
  const player = getMoviePlayer();
  if (!player?.setOption) {
    return false;
  }
  try {
    player.loadModule?.("captions");
  } catch {
    // ignore
  }
  let tracklist = await waitForTracklist(player);
  if (tracklist.length === 0) {
    const subtitleButton = document.querySelector<HTMLButtonElement>(
      "button.ytp-subtitles-button"
    );
    subtitleButton?.click();
    await wait(200);
    tracklist = await waitForTracklist(player);
  }
  const target = pickTrackForLanguage(tracklist, languageCode, kind);
  if (!target) {
    return false;
  }
  try {
    player.setOption("captions", "track", target);
    return true;
  } catch {
    return false;
  }
}

function getInterceptedSubtitle(
  languageCode: string,
  kind?: string
): InterceptedSubtitle | null {
  return (
    interceptedSubtitles.get(subtitleKey(languageCode, kind)) ??
    interceptedSubtitles.get(subtitleKey(languageCode)) ??
    null
  );
}

function waitForInterceptedSubtitle(
  languageCode: string,
  kind?: string,
  timeoutMs = 12000
): Promise<InterceptedSubtitle | null> {
  const existing = getInterceptedSubtitle(languageCode, kind);
  if (existing) {
    return Promise.resolve(existing);
  }
  const key = normalizeLanguageCode(languageCode);
  return new Promise((resolve) => {
    const timeoutId = window.setTimeout(() => {
      const list = pendingByLang.get(key) ?? [];
      const index = list.indexOf(resolver);
      if (index >= 0) {
        list.splice(index, 1);
      }
      if (list.length > 0) {
        pendingByLang.set(key, list);
      } else {
        pendingByLang.delete(key);
      }
      resolve(getInterceptedSubtitle(languageCode, kind));
    }, timeoutMs);

    const resolver = (_subtitle: InterceptedSubtitle | null): void => {
      window.clearTimeout(timeoutId);
      resolve(getInterceptedSubtitle(languageCode, kind));
    };

    const resolvers = pendingByLang.get(key) ?? [];
    resolvers.push(resolver);
    pendingByLang.set(key, resolvers);
  });
}

function postTracksResult(
  requestId: string,
  payload: TracksResultPayload,
  ok = true,
  error?: string
): void {
  window.postMessage(
    {
      source: PAGE_BRIDGE_SOURCE,
      type: "tracks:result",
      requestId,
      ok,
      payload,
      error
    },
    "*"
  );
}

function postSubtitleResult(
  requestId: string,
  payload: SubtitleResultPayload,
  ok = true,
  error?: string
): void {
  window.postMessage(
    {
      source: PAGE_BRIDGE_SOURCE,
      type: "subtitle:result",
      requestId,
      ok,
      payload,
      error
    },
    "*"
  );
}

async function handleTracksRequest(request: BridgeRequestTracksMessage): Promise<void> {
  const tracks = getAvailableTracks();
  postTracksResult(request.requestId, {
    videoId: getCurrentVideoId(),
    tracks
  });
}

async function handleSubtitleRequest(
  request: BridgeRequestSubtitleMessage
): Promise<void> {
  const languageCode = request.payload?.languageCode?.trim();
  const kind = request.payload?.kind;
  if (!languageCode) {
    postSubtitleResult(
      request.requestId,
      {
        text: "",
        fmt: "unknown",
        languageCode: "",
        kind
      },
      false,
      "missing languageCode"
    );
    return;
  }

  let subtitle = getInterceptedSubtitle(languageCode, kind);
  if (!subtitle) {
    await triggerCaptionLoad(languageCode, kind);
    subtitle = await waitForInterceptedSubtitle(languageCode, kind);
  }

  if (!subtitle) {
    postSubtitleResult(
      request.requestId,
      {
        text: "",
        fmt: "unknown",
        languageCode,
        kind
      },
      false,
      "subtitle not captured"
    );
    return;
  }

  postSubtitleResult(request.requestId, {
    text: subtitle.text,
    fmt: subtitle.fmt,
    languageCode: subtitle.languageCode,
    kind: subtitle.kind
  });
}

function setupBridgeMessageListener(): void {
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window) {
      return;
    }
    if (!event.data || typeof event.data !== "object") {
      return;
    }
    const message = event.data as BridgeRequestMessage;
    if (message.source !== PAGE_BRIDGE_SOURCE || typeof message.requestId !== "string") {
      return;
    }
    if (message.type === "tracks:get") {
      void handleTracksRequest(message);
      return;
    }
    if (message.type === "subtitle:get") {
      void handleSubtitleRequest(message);
    }
  });
}

installNetworkInterceptors();
setupBridgeMessageListener();
