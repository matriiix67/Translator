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
import { fetchSubtitleCues, selectPreferredTrack } from "@youtube/subtitle-fetcher";
import { SubtitleRenderer } from "@youtube/subtitle-renderer";

interface BridgeMessagePayload {
  videoId?: string;
  tracks?: YouTubeCaptionTrack[];
}

interface PendingBatch {
  resolve: (translations: Record<string, string>) => void;
  reject: (error: Error) => void;
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
    this.connectPort();
    this.injectBridgeScript();
    this.setupBridgeListener();
    if (!this.enabled) {
      this.renderer.hide();
    }
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    this.lastError = undefined;
    if (!enabled) {
      this.stopSync();
      this.renderer.hide();
      this.progress.inflight = 0;
      this.progress.pending = 0;
      return;
    }
    this.connectPort();
    this.injectBridgeScript();
    this.loadedTrackKey = null;
    window.dispatchEvent(new Event("yt-navigate-finish"));
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
      const pending = this.pendingBatches.get(message.payload.requestId);
      if (!pending) {
        return;
      }
      this.pendingBatches.delete(message.payload.requestId);
      pending.resolve(message.payload.translations);
      return;
    }

    if (message.type === "translate:error") {
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
      if (event.data.source !== PAGE_BRIDGE_SOURCE || event.data.type !== "tracks") {
        return;
      }
      const payload = event.data.payload as BridgeMessagePayload;
      void this.handleTrackPayload(payload);
    });
  }

  private injectBridgeScript(): void {
    if (document.querySelector('script[data-ai-translator-yt-bridge="1"]')) {
      return;
    }
    const script = document.createElement("script");
    script.src = chrome.runtime.getURL("youtube/page-bridge.js");
    script.dataset.aiTranslatorYtBridge = "1";
    script.async = false;
    (document.head || document.documentElement).appendChild(script);
  }

  private async handleTrackPayload(payload: BridgeMessagePayload): Promise<void> {
    if (!this.enabled) {
      return;
    }

    const tracks = payload.tracks ?? [];
    if (!payload.videoId || tracks.length === 0) {
      return;
    }

    if (this.currentVideoId !== payload.videoId) {
      this.resetForVideo(payload.videoId);
    }

    const preferredTrack = selectPreferredTrack(tracks);
    if (!preferredTrack) {
      this.lastError = "当前视频没有可用字幕轨道。";
      return;
    }

    const trackKey = `${payload.videoId}:${preferredTrack.languageCode}:${preferredTrack.baseUrl}`;
    if (trackKey === this.loadedTrackKey && this.cues.length > 0) {
      return;
    }
    this.loadedTrackKey = trackKey;

    const cues = await fetchSubtitleCues(preferredTrack);
    if (!cues.length) {
      this.lastError = "字幕获取失败或字幕为空。";
      return;
    }

    this.cues.splice(0, this.cues.length, ...cues);
    this.progress.total = cues.length;
    this.progress.translated = 0;
    this.progress.inflight = 0;
    this.progress.pending = cues.length;
    this.translations.clear();
    await this.translateAllCues(payload.videoId);
    this.startSync();
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

    const translated = this.translations.get(found.index) ?? "翻译中...";
    this.renderer.setLines(found.cue.text, translated);
  }
}

const translator = new YouTubeSubtitleTranslator();
void translator.initialize();

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
  translator.dispose();
});
