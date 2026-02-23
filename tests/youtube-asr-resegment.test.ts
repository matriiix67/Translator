import { describe, expect, test } from "vitest";

import type { SubtitleCue } from "../src/shared/types";
import {
  buildStageWindowsByPlayback,
  mapSentencesToCues,
  mapSentencesToCuesOrFallback
} from "../src/youtube/asr-resegment";

const baseCues: SubtitleCue[] = [
  { start: 0, end: 1.2, duration: 1.2, text: "so what we're" },
  { start: 1.2, end: 2.5, duration: 1.3, text: "going to do today" },
  { start: 2.5, end: 3.8, duration: 1.3, text: "is talk about the" },
  { start: 3.8, end: 5.1, duration: 1.3, text: "importance of" },
  { start: 5.1, end: 6.2, duration: 1.1, text: "machine learning" }
];

describe("mapSentencesToCues", () => {
  test("merges fragmented ASR cues into full sentences with correct timing", () => {
    const mapped = mapSentencesToCues(
      [
        "so what we're going to do today",
        "is talk about the importance of machine learning"
      ],
      baseCues
    );

    expect(mapped).toHaveLength(2);
    expect(mapped[0]).toMatchObject({
      start: 0,
      end: 2.5,
      duration: 2.5,
      text: "so what we're going to do today"
    });
    expect(mapped[1]).toMatchObject({
      start: 2.5,
      end: 6.2,
      duration: 3.7,
      text: "is talk about the importance of machine learning"
    });
  });

  test("keeps one-to-one mapping when sentence segmentation is unchanged", () => {
    const mapped = mapSentencesToCues(
      baseCues.map((cue) => cue.text),
      baseCues
    );

    expect(mapped).toHaveLength(baseCues.length);
    for (let i = 0; i < baseCues.length; i += 1) {
      expect(mapped[i].start).toBeCloseTo(baseCues[i].start, 6);
      expect(mapped[i].end).toBeCloseTo(baseCues[i].end, 6);
      expect(mapped[i].duration).toBeCloseTo(baseCues[i].duration, 6);
      expect(mapped[i].text).toBe(baseCues[i].text);
    }
  });
});

describe("mapSentencesToCuesOrFallback", () => {
  test("falls back to original cues when AI returns invalid segmentation", () => {
    const mapped = mapSentencesToCuesOrFallback([], baseCues);
    expect(mapped).toHaveLength(baseCues.length);
    for (let i = 0; i < baseCues.length; i += 1) {
      expect(mapped[i].start).toBeCloseTo(baseCues[i].start, 6);
      expect(mapped[i].end).toBeCloseTo(baseCues[i].end, 6);
      expect(mapped[i].duration).toBeCloseTo(baseCues[i].duration, 6);
      expect(mapped[i].text).toBe(baseCues[i].text);
    }
  });
});

describe("buildStageWindowsByPlayback", () => {
  test("prioritizes the stage around current playback index", () => {
    const windows = buildStageWindowsByPlayback(250, 100, 160);
    expect(windows).toEqual([
      { start: 100, end: 200 },
      { start: 200, end: 250 },
      { start: 0, end: 100 }
    ]);
  });
});
