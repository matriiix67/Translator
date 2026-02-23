import {
  DEFAULT_SUBTITLE_BATCH_SIZE,
  PAGE_BRIDGE_SOURCE,
  RESEGMENT_BATCH_SIZE
} from "@shared/constants";
import {
  createRequestId,
  createTranslationPort,
  onPortMessage,
  postBatchTranslation,
  postResegment
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
import {
  buildStageWindowsByPlayback,
  mapSentencesToRangesOrFallback,
  type CueSentenceRange
} from "@youtube/asr-resegment";
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

interface PendingResegment {
  resolve: (sentences: string[]) => void;
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

  private readonly pendingResegments = new Map<string, PendingResegment>();

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

  private pendingHint = "翻译中...";

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
    this.pendingResegments.clear();
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

    const maxAttempts = 4;
    let result: TrackDiscoveryResult = {
      videoId,
      tracks: [],
      source: "none"
    };
    const isUsableResult = (candidate: TrackDiscoveryResult | null): candidate is TrackDiscoveryResult =>
      Boolean(
        candidate &&
          candidate.tracks.length > 0 &&
          (!candidate.videoId || candidate.videoId === videoId)
      );

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      const fromMainWorld = await this.requestTracksFromMainWorld(videoId);
      if (fromMainWorld) {
        console.log(
          LOG_PREFIX,
          `[tracks] attempt ${attempt}/${maxAttempts} main-world:`,
          fromMainWorld.source,
          "tracks:",
          fromMainWorld.tracks.length,
          "videoId:",
          fromMainWorld.videoId
        );
      }
      if (isUsableResult(fromMainWorld)) {
        result = fromMainWorld;
        break;
      }

      const fromDom = extractTracksFromDOM();
      console.log(
        LOG_PREFIX,
        `[tracks] attempt ${attempt}/${maxAttempts} dom:`,
        fromDom.source,
        "tracks:",
        fromDom.tracks.length,
        "videoId:",
        fromDom.videoId
      );
      if (isUsableResult(fromDom)) {
        result = fromDom;
        break;
      }

      if (attempt === maxAttempts) {
        console.log(LOG_PREFIX, "DOM/main-world miss, fetching page HTML...");
        const fromFetch = await fetchTracksForVideoId(videoId);
        console.log(
          LOG_PREFIX,
          `[tracks] attempt ${attempt}/${maxAttempts} fetch:`,
          fromFetch.source,
          "tracks:",
          fromFetch.tracks.length,
          "videoId:",
          fromFetch.videoId
        );
        if (isUsableResult(fromFetch)) {
          result = fromFetch;
        }
      } else {
        await new Promise((resolve) => window.setTimeout(resolve, 220 * attempt));
      }
    }

    if (result.tracks.length === 0) {
      console.log(LOG_PREFIX, "No caption tracks found");
      this.lastError = "当前视频没有可用字幕轨道。";
      return;
    }

    console.log(
      LOG_PREFIX,
      "[phase:tracks_ok]",
      "source:",
      result.source,
      "tracks:",
      result.tracks.length
    );

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

    if (message.type === "translate:resegmentDone") {
      console.log(
        LOG_PREFIX,
        "Resegment done:",
        message.payload.requestId,
        "sentences:",
        message.payload.sentences.length
      );
      const pending = this.pendingResegments.get(message.payload.requestId);
      if (!pending) {
        return;
      }
      this.pendingResegments.delete(message.payload.requestId);
      pending.resolve(message.payload.sentences);
      return;
    }

    if (message.type === "translate:error") {
      console.error(
        LOG_PREFIX,
        "Translate pipeline error:",
        message.payload.requestId,
        message.payload.message
      );
      const pendingBatch = this.pendingBatches.get(message.payload.requestId);
      if (pendingBatch) {
        this.pendingBatches.delete(message.payload.requestId);
        pendingBatch.reject(new Error(message.payload.message));
        return;
      }

      const pendingResegment = this.pendingResegments.get(message.payload.requestId);
      if (!pendingResegment) {
        return;
      }
      this.pendingResegments.delete(message.payload.requestId);
      pendingResegment.reject(new Error(message.payload.message));
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

    const shouldResegment = preferredTrack.kind === "asr" && cues.length >= 5;
    if (shouldResegment) {
      console.log(
        LOG_PREFIX,
        "ASR track detected, processing by playback stages (resegment+translate)..."
      );
      this.cues.splice(0, this.cues.length, ...cues);
      this.translations.clear();
      this.lastError = undefined;
      this.progress.total = cues.length;
      this.progress.translated = 0;
      this.progress.inflight = 0;
      this.progress.pending = cues.length;
      this.pendingHint = "重排并翻译中...";
      this.startSync();
      void this.translateAsrCuesByPlaybackStages(payload.videoId);
      return;
    }

    console.log(LOG_PREFIX, "[phase:cues_ok]", "count:", cues.length);
    console.log(LOG_PREFIX, "Fetched", cues.length, "cues, starting translation...");
    this.cues.splice(0, this.cues.length, ...cues);
    this.lastError = undefined;
    this.progress.total = cues.length;
    this.progress.translated = 0;
    this.progress.inflight = 0;
    this.progress.pending = cues.length;
    this.translations.clear();
    this.pendingHint = "翻译中...";
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
    this.pendingHint = "翻译中...";
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

  private mapSentencesToRanges(
    sentences: string[],
    originalCues: SubtitleCue[]
  ): CueSentenceRange[] {
    return mapSentencesToRangesOrFallback(sentences, originalCues);
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

  private async sendResegment(requestId: string, texts: string[]): Promise<string[]> {
    if (!this.port) {
      throw new Error("翻译通道未建立。");
    }
    const promise = new Promise<string[]>((resolve, reject) => {
      this.pendingResegments.set(requestId, { resolve, reject });
    });

    postResegment(this.port, {
      requestId,
      texts
    });

    return promise;
  }

  private getCurrentCueIndex(): number {
    const video = document.querySelector<HTMLVideoElement>("video.html5-main-video");
    if (!video) {
      return 0;
    }
    const found = this.findCueByTime(video.currentTime);
    return found ? found.index : 0;
  }

  private buildResegmentStageItems(
    ranges: CueSentenceRange[],
    absoluteStageStart: number
  ): {
    items: BatchTranslationItem[];
    rangeByItemId: Map<string, { start: number; end: number }>;
  } {
    const items: BatchTranslationItem[] = [];
    const rangeByItemId = new Map<string, { start: number; end: number }>();
    for (let i = 0; i < ranges.length; i += 1) {
      const range = ranges[i];
      if (!range.text.trim()) {
        continue;
      }
      const absoluteStart = absoluteStageStart + range.startIndex;
      const absoluteEnd = absoluteStageStart + range.endIndex;
      const context = this.getContext(absoluteStart);
      const id = String(i);
      items.push({
        id,
        text: range.text,
        contextBefore: context.before,
        contextAfter: context.after
      });
      rangeByItemId.set(id, {
        start: absoluteStart,
        end: absoluteEnd
      });
    }
    return {
      items,
      rangeByItemId
    };
  }

  private async translateAsrCuesByPlaybackStages(videoId: string): Promise<void> {
    const total = this.cues.length;
    if (total === 0) {
      return;
    }

    const currentIndex = this.getCurrentCueIndex();
    const stages = buildStageWindowsByPlayback(total, RESEGMENT_BATCH_SIZE, currentIndex);
    console.log(
      LOG_PREFIX,
      "[phase:asr_stage_pipeline]",
      "currentIndex:",
      currentIndex,
      "stages:",
      stages.length
    );

    for (const stage of stages) {
      if (!this.enabled || this.currentVideoId !== videoId) {
        return;
      }

      const cueCount = stage.end - stage.start;
      if (cueCount <= 0) {
        continue;
      }

      const chunk = this.cues.slice(stage.start, stage.end);
      const texts = chunk
        .map((cue) => cue.text.replace(/\s+/g, " ").trim())
        .filter(Boolean);

      let ranges: CueSentenceRange[];
      if (texts.length === 0) {
        ranges = this.mapSentencesToRanges([], chunk);
      } else {
        const requestId = createRequestId("yt-resegment");
        try {
          const sentences = await this.sendResegment(requestId, texts);
          ranges = this.mapSentencesToRanges(sentences, chunk);
        } catch (error) {
          console.warn(
            LOG_PREFIX,
            "Resegment stage failed, fallback to raw chunk:",
            error instanceof Error ? error.message : String(error)
          );
          ranges = this.mapSentencesToRanges([], chunk);
        }
      }

      const { items, rangeByItemId } = this.buildResegmentStageItems(ranges, stage.start);
      if (items.length === 0) {
        continue;
      }

      this.progress.inflight += cueCount;
      this.progress.pending = Math.max(0, total - this.progress.translated - this.progress.inflight);

      try {
        for (let start = 0; start < items.length; start += DEFAULT_SUBTITLE_BATCH_SIZE) {
          if (!this.enabled || this.currentVideoId !== videoId) {
            return;
          }

          const end = Math.min(items.length, start + DEFAULT_SUBTITLE_BATCH_SIZE);
          const batchItems = items.slice(start, end);
          const requestId = createRequestId("yt-batch");
          const translated = await this.sendBatch(requestId, batchItems, videoId);

          for (const item of batchItems) {
            const value = translated[item.id] ?? item.text;
            const mapped = rangeByItemId.get(item.id);
            if (!mapped) {
              continue;
            }
            for (let index = mapped.start; index <= mapped.end; index += 1) {
              if (!this.translations.has(index)) {
                this.progress.translated += 1;
              }
              this.translations.set(index, value);
            }
          }
        }
      } catch (error) {
        this.lastError = error instanceof Error ? error.message : "字幕翻译失败。";
        console.error(LOG_PREFIX, "translateAsrCuesByPlaybackStages failed:", this.lastError);
        break;
      } finally {
        this.progress.inflight = Math.max(0, this.progress.inflight - cueCount);
        this.progress.pending = Math.max(
          0,
          total - this.progress.translated - this.progress.inflight
        );
      }
    }
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
    console.log(
      LOG_PREFIX,
      "[phase:sync_started]",
      "cues:",
      this.cues.length
    );
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
      (this.lastError ? `翻译失败：${this.lastError}` : this.pendingHint);
    this.renderer.setTranslation(translated);
  }
}

function bootstrapYouTubeTranslator(): void {
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
}

if (typeof chrome !== "undefined" && typeof window !== "undefined" && chrome.runtime?.onMessage) {
  bootstrapYouTubeTranslator();
}
