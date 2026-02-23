import type { SubtitleCue } from "@shared/types";

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function countTextUnits(text: string): number {
  const normalized = normalizeText(text);
  if (!normalized) {
    return 0;
  }
  const parts = normalized.split(/\s+/).filter(Boolean);
  if (parts.length > 1 || /\s/.test(normalized)) {
    return parts.length;
  }
  // 对无空格语言回退到字符计数，避免所有片段都被视为 1 个词。
  return normalized.length;
}

function buildCueFromRange(
  sentence: string,
  firstCue: SubtitleCue,
  lastCue: SubtitleCue
): SubtitleCue {
  const safeEnd =
    lastCue.end > firstCue.start
      ? lastCue.end
      : firstCue.start + Math.max(firstCue.duration, 0.2);
  return {
    start: firstCue.start,
    end: safeEnd,
    duration: safeEnd - firstCue.start,
    text: normalizeText(sentence)
  };
}

export interface CueSentenceRange {
  startIndex: number;
  endIndex: number;
  text: string;
}

export interface StageWindow {
  start: number;
  end: number;
}

function buildIdentityRanges(originalCues: SubtitleCue[]): CueSentenceRange[] {
  return originalCues.map((cue, index) => ({
    startIndex: index,
    endIndex: index,
    text: normalizeText(cue.text)
  }));
}

function mapSentencesToRanges(
  sentences: string[],
  originalCues: SubtitleCue[]
): CueSentenceRange[] {
  if (originalCues.length === 0) {
    return [];
  }

  const normalizedSentences = sentences.map(normalizeText).filter(Boolean);
  if (normalizedSentences.length === 0) {
    return [];
  }

  const mapped: CueSentenceRange[] = [];
  let pointer = 0;

  for (const sentence of normalizedSentences) {
    if (pointer >= originalCues.length) {
      break;
    }

    const targetUnits = Math.max(1, countTextUnits(sentence));
    const startIndex = pointer;
    let endIndex = pointer;
    let consumedUnits = 0;

    while (endIndex < originalCues.length) {
      consumedUnits += Math.max(1, countTextUnits(originalCues[endIndex].text));
      if (consumedUnits >= targetUnits) {
        break;
      }
      endIndex += 1;
    }

    if (endIndex >= originalCues.length) {
      endIndex = originalCues.length - 1;
    }

    mapped.push({
      startIndex,
      endIndex,
      text: sentence
    });
    pointer = endIndex + 1;
  }

  if (pointer < originalCues.length && mapped.length > 0) {
    const remainText = originalCues
      .slice(pointer)
      .map((cue) => normalizeText(cue.text))
      .filter(Boolean)
      .join(" ");
    if (remainText) {
      const lastIndex = mapped.length - 1;
      const last = mapped[lastIndex];
      const mergedText = normalizeText(`${last.text} ${remainText}`);
      mapped[lastIndex] = {
        startIndex: last.startIndex,
        endIndex: originalCues.length - 1,
        text: mergedText
      };
    }
  }

  return mapped;
}

export function mapSentencesToRangesOrFallback(
  sentences: string[],
  originalCues: SubtitleCue[]
): CueSentenceRange[] {
  const mapped = mapSentencesToRanges(sentences, originalCues);
  if (mapped.length === 0) {
    return buildIdentityRanges(originalCues);
  }

  const originalUnits = countTextUnits(originalCues.map((cue) => cue.text).join(" "));
  const mappedUnits = countTextUnits(mapped.map((cue) => cue.text).join(" "));
  if (originalUnits > 0 && mappedUnits < Math.floor(originalUnits * 0.7)) {
    return buildIdentityRanges(originalCues);
  }

  return mapped;
}

export function mapSentencesToCues(
  sentences: string[],
  originalCues: SubtitleCue[]
): SubtitleCue[] {
  const mappedRanges = mapSentencesToRanges(sentences, originalCues);
  if (mappedRanges.length === 0) {
    return [];
  }

  return mappedRanges.map((range) =>
    buildCueFromRange(
      range.text,
      originalCues[range.startIndex],
      originalCues[range.endIndex]
    )
  );
}

export function mapSentencesToCuesOrFallback(
  sentences: string[],
  originalCues: SubtitleCue[]
): SubtitleCue[] {
  return mapSentencesToRangesOrFallback(sentences, originalCues).map((range) =>
    buildCueFromRange(
      range.text,
      originalCues[range.startIndex],
      originalCues[range.endIndex]
    )
  );
}

export function buildStageWindowsByPlayback(
  totalCues: number,
  stageSize: number,
  currentIndex: number
): StageWindow[] {
  if (totalCues <= 0) {
    return [];
  }
  const safeStageSize = Math.max(1, Math.floor(stageSize));
  const windows: StageWindow[] = [];
  for (let start = 0; start < totalCues; start += safeStageSize) {
    windows.push({
      start,
      end: Math.min(totalCues, start + safeStageSize)
    });
  }
  if (windows.length <= 1) {
    return windows;
  }

  const clampedIndex = Math.max(0, Math.min(totalCues - 1, Math.floor(currentIndex)));
  const currentWindowIndex = Math.floor(clampedIndex / safeStageSize);
  return windows
    .slice(currentWindowIndex)
    .concat(windows.slice(0, currentWindowIndex));
}
