/** @vitest-environment jsdom */

import { describe, expect, test } from "vitest";

import type { SubtitleCue } from "../src/shared/types";
import { YouTubeSubtitleTranslator } from "../src/youtube/index";

function createTranslator(): any {
  const translator = new YouTubeSubtitleTranslator() as any;
  translator.enabled = true;
  translator.currentVideoId = "video-1";
  return translator;
}

describe("YouTubeSubtitleTranslator resegment flow", () => {
  test("prioritizes current playback stage for ASR resegment+translate", async () => {
    document.body.innerHTML = `<video class="html5-main-video"></video>`;
    const video = document.querySelector("video.html5-main-video") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", {
      value: 125.2,
      writable: true,
      configurable: true
    });

    const cues: SubtitleCue[] = Array.from({ length: 130 }, (_, index) => ({
      start: index,
      end: index + 0.8,
      duration: 0.8,
      text: `cue-${index}`
    }));
    const translator = createTranslator();
    translator.cues.splice(0, translator.cues.length, ...cues);
    translator.progress.total = cues.length;
    translator.progress.pending = cues.length;
    translator.progress.translated = 0;
    translator.progress.inflight = 0;
    translator.sendResegmentCalls = [];
    translator.sendBatchCalls = [];
    translator.sendResegment = async (_requestId: string, texts: string[]) => {
      translator.sendResegmentCalls.push(texts[0]);
      return [texts.join(" ")];
    };
    translator.sendBatch = async (_requestId: string, items: Array<{ id: string; text: string }>) => {
      translator.sendBatchCalls.push(items[0].text);
      const output: Record<string, string> = {};
      for (const item of items) {
        output[item.id] = `zh:${item.text}`;
      }
      return output;
    };

    await translator.translateAsrCuesByPlaybackStages("video-1");

    expect(translator.sendResegmentCalls[0]).toBe("cue-120");
    expect(translator.sendBatchCalls[0]).toContain("cue-120");
    expect(translator.progress.translated).toBe(cues.length);
  });

  test("continues translation with raw-cue fallback when resegment stage fails", async () => {
    document.body.innerHTML = `<video class="html5-main-video"></video>`;
    const video = document.querySelector("video.html5-main-video") as HTMLVideoElement;
    Object.defineProperty(video, "currentTime", {
      value: 1.5,
      writable: true,
      configurable: true
    });

    const cues: SubtitleCue[] = [
      { start: 0, end: 1, duration: 1, text: "a" },
      { start: 1, end: 2, duration: 1, text: "b" },
      { start: 2, end: 3, duration: 1, text: "c" },
      { start: 3, end: 4, duration: 1, text: "d" },
      { start: 4, end: 5, duration: 1, text: "e" }
    ];

    const translator = createTranslator();
    translator.cues.splice(0, translator.cues.length, ...cues);
    translator.progress.total = cues.length;
    translator.progress.pending = cues.length;
    translator.progress.translated = 0;
    translator.progress.inflight = 0;
    translator.sendBatchCalls = [];
    translator.sendResegment = async () => {
      throw new Error("mock resegment failed");
    };
    translator.sendBatch = async (_requestId: string, items: Array<{ id: string; text: string }>) => {
      translator.sendBatchCalls.push(...items.map((item) => item.text));
      const output: Record<string, string> = {};
      for (const item of items) {
        output[item.id] = `zh:${item.text}`;
      }
      return output;
    };

    await translator.translateAsrCuesByPlaybackStages("video-1");

    expect(translator.sendBatchCalls).toEqual(["a", "b", "c", "d", "e"]);
    expect(translator.progress.translated).toBe(cues.length);
  });
});
