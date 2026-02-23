import { DEFAULT_SUBTITLE_BATCH_SIZE, PAGE_BRIDGE_SOURCE } from "@shared/constants";
import {
  createRequestId,
  createTranslationPort,
  onPortMessage,
  postBatchTranslation
} from "@shared/messaging";
import { getSitePreference, getUserConfig, setSitePreference, toSiteKey } from "@shared/storage";
import type {
  BatchTranslationItem,
  PageTranslationStatus,
  RuntimeRequestMessage,
  RuntimeResponseMessage,
  SubtitleCue,
  TranslationPortOutgoingMessage,
  YouTubeCaptionTrack
} from "@shared/types";
import {
  parseCapturedSubtitlePayload,
  extractTracksFromDOM,
  fetchSubtitleCues,
  fetchTracksForVideoId,
  selectPreferredTrack,
  type CapturedSubtitlePayload,
  type TrackDiscoveryResult
} from "@youtube/subtitle-fetcher";
import { SubtitleRenderer } from "@youtube/subtitle-renderer";

const LOG_PREFIX = "[AI Translator]";

interface BridgeTracksPayload {
  videoId?: string;
  tracks?: YouTubeCaptionTrack[];
}

interface BridgeSubtitlePayload extends CapturedSubtitlePayload {}

type BridgeRequestType = "tracks:get" | "subtitle:get";
type BridgeResultType = "tracks:result" | "subtitle:result";

interface PendingBridgeRequest {
  expectedType: BridgeResultType;
  timeoutId: number;
  resolve: (payload: unknown) => void;
  reject: (error: Error) => void;
}

interface PendingBatch {
  resolve: (translations: Record<string, string>) => void;
  reject: (error: Error) => void;
}

class YouTubeSubtitleToggleButton {
  private host: HTMLDivElement | null = null;

  private button: HTMLButtonElement | null = null;

  private observer: MutationObserver | null = null;

  private mountedTo: HTMLElement | null = null;

  private mountMode: "below" | "floating" | null = null;

  private syncing = false;

  constructor(private readonly translator: YouTubeSubtitleTranslator) {}

  start(): void {
    if (this.observer) {
      return;
    }
    const root = document.body ?? document.documentElement;
    if (!root) {
      return;
    }

    this.observer = new MutationObserver(() => this.scheduleSync());
    this.observer.observe(root, { childList: true, subtree: true });
    window.addEventListener("yt-navigate-finish", this.onNavigateFinish, {
      passive: true
    });
    this.scheduleSync();
  }

  stop(): void {
    this.observer?.disconnect();
    this.observer = null;
    window.removeEventListener("yt-navigate-finish", this.onNavigateFinish);
    this.host?.remove();
    this.host = null;
    this.button = null;
    this.mountedTo = null;
    this.mountMode = null;
  }

  sync(): void {
    this.scheduleSync();
  }

  private readonly onNavigateFinish = () => {
    this.scheduleSync();
  };

  private scheduleSync(): void {
    if (this.syncing) {
      return;
    }
    this.syncing = true;
    window.requestAnimationFrame(() => {
      this.syncing = false;
      this.ensureMounted();
      this.render();
    });
  }

  private findMountPoint():
    | { element: HTMLElement; mode: "below" | "floating" }
    | null {
    // 优先挂在播放器下方信息区域（用户可见且不会被视频层覆盖）
    const belowCandidates = [
      document.querySelector<HTMLElement>("#below"),
      document.querySelector<HTMLElement>("#meta-contents"),
      document.querySelector<HTMLElement>("#info-contents"),
      document.querySelector<HTMLElement>("ytd-watch-metadata")
    ];
    for (const candidate of belowCandidates) {
      if (candidate) {
        return { element: candidate, mode: "below" };
      }
    }

    // 回退：挂在播放器内部右下角，确保按钮至少可操作
    const player = document.querySelector<HTMLElement>("#movie_player");
    if (player) {
      return { element: player, mode: "floating" };
    }
    return null;
  }

  private ensureMounted(): void {
    const target = this.findMountPoint();
    if (!target) {
      return;
    }
    const mountPoint = target.element;
    const mode = target.mode;

    const existing =
      this.host && this.host.isConnected ? this.host : null;
    if (existing && this.mountedTo === mountPoint && this.mountMode === mode) {
      return;
    }

    this.host?.remove();
    const host = document.createElement("div");
    host.className = "ai-translator-yt-toggle-host";
    host.style.pointerEvents = "auto";

    if (mode === "below") {
      host.style.display = "flex";
      host.style.justifyContent = "flex-end";
      host.style.marginTop = "8px";
      host.style.marginBottom = "8px";
      host.style.paddingRight = "8px";
      host.style.position = "relative";
      host.style.zIndex = "10";
    } else {
      const computed = window.getComputedStyle(mountPoint);
      if (computed.position === "static") {
        mountPoint.style.position = "relative";
      }
      host.style.position = "absolute";
      host.style.right = "12px";
      host.style.bottom = "64px";
      host.style.zIndex = "2147483600";
    }

    const button = document.createElement("button");
    button.type = "button";
    button.className = "ai-translator-yt-toggle-button";
    button.style.display = "inline-flex";
    button.style.alignItems = "center";
    button.style.gap = "8px";
    button.style.borderRadius = "999px";
    button.style.border = "1px solid rgba(148, 163, 184, 0.7)";
    button.style.background = "#374151";
    button.style.color = "#ffffff";
    button.style.padding = "8px 12px";
    button.style.fontSize = "13px";
    button.style.fontWeight = "600";
    button.style.cursor = "pointer";
    button.style.userSelect = "none";
    button.style.boxShadow = "0 4px 14px rgba(0, 0, 0, 0.25)";

    button.addEventListener("click", () => {
      void this.toggle();
    });

    host.appendChild(button);

    mountPoint.appendChild(host);
    this.host = host;
    this.button = button;
    this.mountedTo = mountPoint;
    this.mountMode = mode;
  }

  private async toggle(): Promise<void> {
    const status = this.translator.getStatus();
    const nextEnabled = !status.enabled;
    await setSitePreference(toSiteKey(window.location.href), nextEnabled);
    await this.translator.setEnabled(nextEnabled);
    this.render();
  }

  private render(): void {
    if (!this.button) {
      return;
    }
    const status = this.translator.getStatus();
    const enabled = status.enabled;
    this.button.setAttribute("aria-pressed", enabled ? "true" : "false");

    if (enabled) {
      this.button.textContent = "字幕翻译：开";
      this.button.style.background = "#4f46e5";
      this.button.style.border = "1px solid #6366f1";
      this.button.style.color = "#ffffff";
    } else {
      this.button.textContent = "字幕翻译：关";
      this.button.style.background = "#374151";
      this.button.style.border = "1px solid #4b5563";
      this.button.style.color = "#ffffff";
    }
  }
}

export class YouTubeSubtitleTranslator {
  private readonly siteKey = toSiteKey(window.location.href);

  private enabled = false;

  private targetLang = "zh-CN";

  private contextWindow = 8;

  private readonly renderer = new SubtitleRenderer();

  private readonly cues: SubtitleCue[] = [];

  private readonly translations = new Map<number, string>();

  private readonly pendingBatches = new Map<string, PendingBatch>();

  private readonly pendingBridgeRequests = new Map<string, PendingBridgeRequest>();

  private currentVideoId: string | undefined;

  private loadedTrackKey: string | null = null;

  private syncTimer: number | null = null;

  private port: chrome.runtime.Port | null = null;

  private unsubscribePort: (() => void) | null = null;

  private progress = {
    total: 0,
    translated: 0,
    inflight: 0,
    pending: 0
  };

  private lastError: string | undefined;

  async initialize(): Promise<void> {
    const config = await getUserConfig();
    this.targetLang = config.targetLang;
    this.contextWindow = Math.max(2, config.subtitleContextWindow);
    const sitePreference = await getSitePreference(this.siteKey);
    this.enabled = sitePreference ? sitePreference.enabled : config.autoTranslate;
    console.log(LOG_PREFIX, "initialize: enabled =", this.enabled, "targetLang =", this.targetLang);
    this.connectPort();
    // 轨道发现已改为 DOM/HTML 解析，不再依赖向页面注入脚本（YouTube CSP 可能导致注入失败或噪音错误）。
    // 保留 bridge 监听以兼容旧逻辑/未来回退，但默认不注入 bridge。
    this.setupBridgeListener();

    window.addEventListener(
      "yt-navigate-finish",
      () => void this.onNavigateFinish(),
      { passive: true }
    );

    if (!this.enabled) {
      this.renderer.hide();
      return;
    }

    await this.discoverTracks();
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    this.lastError = undefined;
    console.log(LOG_PREFIX, "setEnabled:", enabled);
    if (!enabled) {
      this.stopSync();
      this.renderer.hide();
      this.progress.inflight = 0;
      this.progress.pending = 0;
      return;
    }
    this.connectPort();
    this.loadedTrackKey = null;
    await this.discoverTracks();
  }

  getStatus(): PageTranslationStatus {
    return {
      enabled: this.enabled,
      progress: { ...this.progress },
      lastError: this.lastError
    };
  }

  dispose(): void {
    this.stopSync();
    this.renderer.destroy();
    this.unsubscribePort?.();
    this.unsubscribePort = null;
    this.port?.disconnect();
    this.port = null;
    this.pendingBatches.clear();
    for (const pending of this.pendingBridgeRequests.values()) {
      window.clearTimeout(pending.timeoutId);
    }
    this.pendingBridgeRequests.clear();
  }

  private async onNavigateFinish(): Promise<void> {
    console.log(LOG_PREFIX, "yt-navigate-finish detected");
    if (!this.enabled) return;
    await new Promise((r) => setTimeout(r, 600));
    if (!this.enabled) return;
    await this.discoverTracks();
  }

  private requestBridge<TPayload>(
    type: BridgeRequestType,
    expectedType: BridgeResultType,
    payload?: Record<string, unknown>,
    timeoutMs = 12000
  ): Promise<TPayload> {
    const requestId = createRequestId("yt-bridge");
    return new Promise<TPayload>((resolve, reject) => {
      const timeoutId = window.setTimeout(() => {
        this.pendingBridgeRequests.delete(requestId);
        reject(new Error(`bridge timeout: ${type}`));
      }, timeoutMs);

      this.pendingBridgeRequests.set(requestId, {
        expectedType,
        timeoutId,
        resolve: (data) => resolve(data as TPayload),
        reject
      });

      window.postMessage(
        {
          source: PAGE_BRIDGE_SOURCE,
          type,
          requestId,
          ...(payload ? { payload } : {})
        },
        "*"
      );
    });
  }

  private async requestTracksFromMainWorld(
    currentVideoId: string
  ): Promise<TrackDiscoveryResult | null> {
    try {
      const payload = await this.requestBridge<BridgeTracksPayload>(
        "tracks:get",
        "tracks:result",
        undefined,
        9000
      );
      const tracks = Array.isArray(payload?.tracks)
        ? payload.tracks.filter((track) => Boolean(track?.languageCode))
        : [];
      if (tracks.length === 0) {
        return null;
      }
      return {
        videoId: payload.videoId ?? currentVideoId,
        tracks,
        source: "main-world"
      };
    } catch (error) {
      console.log(
        LOG_PREFIX,
        "Main-world track request failed:",
        error instanceof Error ? error.message : String(error)
      );
      return null;
    }
  }

  private async requestSubtitleCuesFromMainWorld(
    track: YouTubeCaptionTrack
  ): Promise<SubtitleCue[]> {
    try {
      const payload = await this.requestBridge<BridgeSubtitlePayload>(
        "subtitle:get",
        "subtitle:result",
        {
          languageCode: track.languageCode,
          kind: track.kind
        },
        13000
      );
      if (!payload?.text?.trim()) {
        return [];
      }
      const cues = parseCapturedSubtitlePayload(payload);
      if (cues.length > 0) {
        console.log(
          LOG_PREFIX,
          "Main-world subtitle payload parsed:",
          cues.length,
          "cues"
        );
      }
      return cues;
    } catch (error) {
      console.log(
        LOG_PREFIX,
        "Main-world subtitle request failed:",
        error instanceof Error ? error.message : String(error)
      );
      return [];
    }
  }

  private async loadCuesForTrack(track: YouTubeCaptionTrack): Promise<SubtitleCue[]> {
    const bridgeCues = await this.requestSubtitleCuesFromMainWorld(track);
    if (bridgeCues.length > 0) {
      return bridgeCues;
    }
    return fetchSubtitleCues(track);
  }

  private async discoverTracks(): Promise<void> {
    const videoId = new URL(window.location.href).searchParams.get("v");
    if (!videoId) {
      console.log(LOG_PREFIX, "No video ID in URL, skipping");
      return;
    }

    console.log(LOG_PREFIX, "Discovering tracks for:", videoId);

    let result = await this.requestTracksFromMainWorld(videoId);
    if (result) {
      console.log(
        LOG_PREFIX,
        "Main-world track result:",
        result.source,
        "tracks:",
        result.tracks.length,
        "videoId:",
        result.videoId
      );
    }

    if (!result || result.tracks.length === 0) {
      result = extractTracksFromDOM();
      console.log(
        LOG_PREFIX,
        "DOM extraction:",
        result.source,
        "tracks:",
        result.tracks.length,
        "videoId:",
        result.videoId
      );
    }

    if (
      result.tracks.length === 0 ||
      (result.videoId && result.videoId !== videoId)
    ) {
      console.log(LOG_PREFIX, "DOM miss or stale, fetching page HTML...");
      result = await fetchTracksForVideoId(videoId);
      console.log(
        LOG_PREFIX,
        "Fetch result:",
        result.source,
        "tracks:",
        result.tracks.length
      );
    }

    if (result.tracks.length === 0) {
      console.log(LOG_PREFIX, "No caption tracks found");
      this.lastError = "当前视频没有可用字幕轨道。";
      return;
    }

    await this.handleTrackPayload({
      videoId: result.videoId ?? videoId,
      tracks: result.tracks
    });
  }

  private connectPort(): void {
    if (this.port) {
      return;
    }
    this.port = createTranslationPort("youtube");
    this.unsubscribePort = onPortMessage(this.port, (message) =>
      this.handlePortMessage(message)
    );
    this.port.onDisconnect.addListener(() => {
      this.unsubscribePort?.();
      this.unsubscribePort = null;
      this.port = null;
      if (this.enabled) {
        window.setTimeout(() => this.connectPort(), 400);
      }
    });
  }

  private handlePortMessage(message: TranslationPortOutgoingMessage): void {
    if (message.type === "translate:batchDone") {
      console.log(
        LOG_PREFIX,
        "Batch done:",
        message.payload.requestId,
        "items:",
        Object.keys(message.payload.translations).length
      );
      const pending = this.pendingBatches.get(message.payload.requestId);
      if (!pending) {
        return;
      }
      this.pendingBatches.delete(message.payload.requestId);
      pending.resolve(message.payload.translations);
      return;
    }

    if (message.type === "translate:error") {
      console.error(
        LOG_PREFIX,
        "Batch translate error:",
        message.payload.requestId,
        message.payload.message
      );
      const pending = this.pendingBatches.get(message.payload.requestId);
      if (!pending) {
        return;
      }
      this.pendingBatches.delete(message.payload.requestId);
      pending.reject(new Error(message.payload.message));
    }
  }

  private setupBridgeListener(): void {
    window.addEventListener("message", (event: MessageEvent) => {
      if (event.source !== window) {
        return;
      }
      if (!event.data || typeof event.data !== "object") {
        return;
      }
      const data = event.data as {
        source?: unknown;
        type?: unknown;
        requestId?: unknown;
        ok?: unknown;
        payload?: unknown;
        error?: unknown;
      };
      if (data.source !== PAGE_BRIDGE_SOURCE) {
        return;
      }

      // 兼容旧版 page-bridge 的主动推送消息
      if (data.type === "tracks" && data.payload && typeof data.payload === "object") {
        void this.handleTrackPayload(data.payload as BridgeTracksPayload);
        return;
      }

      const requestId = typeof data.requestId === "string" ? data.requestId : null;
      if (!requestId) {
        return;
      }
      const pending = this.pendingBridgeRequests.get(requestId);
      if (!pending) {
        return;
      }
      const responseType = typeof data.type === "string" ? data.type : "";
      if (responseType !== pending.expectedType) {
        return;
      }

      this.pendingBridgeRequests.delete(requestId);
      window.clearTimeout(pending.timeoutId);
      const ok = data.ok !== false;
      if (!ok) {
        pending.reject(
          new Error(
            typeof data.error === "string" ? data.error : "bridge request failed"
          )
        );
        return;
      }
      pending.resolve(data.payload);
    });
  }

  private async handleTrackPayload(payload: BridgeTracksPayload): Promise<void> {
    if (!this.enabled) {
      console.log(LOG_PREFIX, "handleTrackPayload: skipped (disabled)");
      return;
    }

    const tracks = payload.tracks ?? [];
    if (!payload.videoId || tracks.length === 0) {
      console.log(LOG_PREFIX, "handleTrackPayload: no videoId or tracks");
      return;
    }

    if (this.currentVideoId !== payload.videoId) {
      this.resetForVideo(payload.videoId);
    }

    const preferredTrack = selectPreferredTrack(tracks);
    if (!preferredTrack) {
      this.lastError = "当前视频没有可用字幕轨道。";
      console.log(LOG_PREFIX, "No preferred track found");
      return;
    }

    console.log(
      LOG_PREFIX,
      "Selected track:", preferredTrack.languageCode,
      preferredTrack.kind ?? "",
      preferredTrack.name ?? ""
    );

    const trackKey = `${payload.videoId}:${preferredTrack.languageCode}:${preferredTrack.baseUrl}`;
    if (trackKey === this.loadedTrackKey && this.cues.length > 0) {
      console.log(LOG_PREFIX, "Track already loaded, skipping");
      return;
    }
    this.loadedTrackKey = trackKey;

    // 先试首选轨道，如果失败就逐一尝试所有轨道
    console.log(LOG_PREFIX, "Fetching subtitle cues...");
    let cues = await this.loadCuesForTrack(preferredTrack);
    if (!cues.length) {
      console.log(LOG_PREFIX, "Preferred track returned 0 cues, trying all tracks...");
      for (const fallbackTrack of tracks) {
        if (fallbackTrack.baseUrl === preferredTrack.baseUrl) continue;
        console.log(LOG_PREFIX, "Trying fallback track:", fallbackTrack.languageCode, fallbackTrack.kind ?? "");
        cues = await this.loadCuesForTrack(fallbackTrack);
        if (cues.length > 0) break;
      }
    }
    if (!cues.length) {
      this.lastError = "字幕获取失败或字幕为空。";
      console.log(LOG_PREFIX, "No cues fetched from any track");
      return;
    }

    console.log(LOG_PREFIX, "Fetched", cues.length, "cues, starting translation...");
    this.cues.splice(0, this.cues.length, ...cues);
    this.lastError = undefined;
    this.progress.total = cues.length;
    this.progress.translated = 0;
    this.progress.inflight = 0;
    this.progress.pending = cues.length;
    this.translations.clear();
    // 先开始按时间渲染，让用户立刻看到“翻译中...”，翻译在后台逐批完成。
    this.startSync();
    void this.translateAllCues(payload.videoId);
  }

  private resetForVideo(videoId: string): void {
    this.currentVideoId = videoId;
    this.loadedTrackKey = null;
    this.stopSync();
    this.cues.length = 0;
    this.translations.clear();
    this.progress.total = 0;
    this.progress.translated = 0;
    this.progress.inflight = 0;
    this.progress.pending = 0;
  }

  private getContext(index: number): { before: string[]; after: string[] } {
    const before: string[] = [];
    const after: string[] = [];

    for (let i = index - 1; i >= 0 && before.length < this.contextWindow; i -= 1) {
      before.unshift(this.cues[i].text);
    }
    for (
      let i = index + 1;
      i < this.cues.length && after.length < this.contextWindow;
      i += 1
    ) {
      after.push(this.cues[i].text);
    }

    return { before, after };
  }

  private buildBatchItems(start: number, end: number): BatchTranslationItem[] {
    const items: BatchTranslationItem[] = [];
    for (let index = start; index < end; index += 1) {
      const cue = this.cues[index];
      const context = this.getContext(index);
      items.push({
        id: String(index),
        text: cue.text,
        contextBefore: context.before,
        contextAfter: context.after
      });
    }
    return items;
  }

  private async sendBatch(
    requestId: string,
    items: BatchTranslationItem[],
    videoId: string
  ): Promise<Record<string, string>> {
    if (!this.port) {
      throw new Error("翻译通道未建立。");
    }
    const promise = new Promise<Record<string, string>>((resolve, reject) => {
      this.pendingBatches.set(requestId, { resolve, reject });
    });

    postBatchTranslation(this.port, {
      requestId,
      source: "youtube",
      items,
      targetLang: this.targetLang,
      metadata: {
        videoId,
        siteKey: this.siteKey,
        url: window.location.href
      }
    });

    return promise;
  }

  private async translateAllCues(videoId: string): Promise<void> {
    const total = this.cues.length;
    if (total === 0) {
      return;
    }

    for (let start = 0; start < total; start += DEFAULT_SUBTITLE_BATCH_SIZE) {
      if (!this.enabled || this.currentVideoId !== videoId) {
        return;
      }
      const end = Math.min(total, start + DEFAULT_SUBTITLE_BATCH_SIZE);
      const items = this.buildBatchItems(start, end);
      const requestId = createRequestId("yt-batch");
      console.log(
        LOG_PREFIX,
        "Translating batch:",
        `${start}-${end - 1}`,
        "size:",
        items.length,
        "requestId:",
        requestId
      );
      this.progress.inflight += items.length;
      this.progress.pending = Math.max(0, total - this.progress.translated - this.progress.inflight);

      try {
        const translated = await this.sendBatch(requestId, items, videoId);
        for (const item of items) {
          const value = translated[item.id] ?? item.text;
          this.translations.set(Number(item.id), value);
          this.progress.translated += 1;
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : "字幕翻译失败。";
        console.error(LOG_PREFIX, "translateAllCues failed:", this.lastError);
        break;
      } finally {
        this.progress.inflight = Math.max(0, this.progress.inflight - items.length);
        this.progress.pending = Math.max(
          0,
          total - this.progress.translated - this.progress.inflight
        );
      }
    }
  }

  private startSync(): void {
    this.stopSync();
    this.syncTimer = window.setInterval(() => this.syncSubtitleByTime(), 140);
  }

  private stopSync(): void {
    if (this.syncTimer !== null) {
      window.clearInterval(this.syncTimer);
      this.syncTimer = null;
    }
  }

  private findCueByTime(currentTime: number): { index: number; cue: SubtitleCue } | null {
    let left = 0;
    let right = this.cues.length - 1;
    while (left <= right) {
      const mid = Math.floor((left + right) / 2);
      const cue = this.cues[mid];
      if (currentTime < cue.start) {
        right = mid - 1;
      } else if (currentTime > cue.end) {
        left = mid + 1;
      } else {
        return { index: mid, cue };
      }
    }
    return null;
  }

  private syncSubtitleByTime(): void {
    if (!this.enabled || this.cues.length === 0) {
      this.renderer.hide();
      return;
    }

    const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
    if (!video) {
      this.renderer.hide();
      return;
    }

    const found = this.findCueByTime(video.currentTime);
    if (!found) {
      this.renderer.hide();
      return;
    }

    const translated =
      this.translations.get(found.index) ??
      (this.lastError ? `翻译失败：${this.lastError}` : "翻译中...");
    this.renderer.setTranslation(translated);
  }
}

const translator = new YouTubeSubtitleTranslator();
void translator.initialize();
const toggleButton = new YouTubeSubtitleToggleButton(translator);
toggleButton.start();

chrome.runtime.onMessage.addListener(
  (
    message: RuntimeRequestMessage,
    _sender,
    sendResponse: (response: RuntimeResponseMessage) => void
  ) => {
    if (!message || typeof message !== "object") {
      return;
    }
    if (message.type === "page:get-status") {
      sendResponse({
        ok: true,
        status: translator.getStatus()
      });
      return;
    }
    if (message.type === "page:toggle") {
      void (async () => {
        await setSitePreference(toSiteKey(window.location.href), message.payload.enabled);
        await translator.setEnabled(message.payload.enabled);
        toggleButton.sync();
        sendResponse({
          ok: true,
          status: translator.getStatus()
        });
      })();
      return true;
    }
  }
);

window.addEventListener("beforeunload", () => {
  toggleButton.stop();
  translator.dispose();
});
