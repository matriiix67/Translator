import type { SubtitleCue, YouTubeCaptionTrack } from "@shared/types";

interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  segs?: Array<{ utf8?: string }>;
}

interface Json3Response {
  events?: Json3Event[];
}

function decodeEntities(text: string): string {
  const parser = new DOMParser();
  const doc = parser.parseFromString(text, "text/html");
  return doc.documentElement.textContent ?? text;
}

function normalizeCueText(text: string): string {
  return decodeEntities(text).replace(/\s+/g, " ").trim();
}

function parseJson3(data: Json3Response): SubtitleCue[] {
  const events = data.events ?? [];
  const cues: SubtitleCue[] = [];

  for (const event of events) {
    const start = (event.tStartMs ?? 0) / 1000;
    const duration = (event.dDurationMs ?? 0) / 1000;
    const text = normalizeCueText(
      (event.segs ?? []).map((segment) => segment.utf8 ?? "").join("")
    );
    if (!text) {
      continue;
    }
    const safeDuration = duration > 0 ? duration : 2.2;
    cues.push({
      start,
      duration: safeDuration,
      end: start + safeDuration,
      text
    });
  }

  return cues;
}

function parseXml(xmlText: string): SubtitleCue[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const textNodes = Array.from(doc.querySelectorAll("text"));
  const cues: SubtitleCue[] = [];

  for (const node of textNodes) {
    const start = Number(node.getAttribute("start") ?? "0");
    const duration = Number(node.getAttribute("dur") ?? "0");
    const text = normalizeCueText(node.textContent ?? "");
    if (!text) {
      continue;
    }
    const safeDuration = duration > 0 ? duration : 2.2;
    cues.push({
      start,
      duration: safeDuration,
      end: start + safeDuration,
      text
    });
  }

  return cues;
}

async function tryFetchJson(trackUrl: string): Promise<SubtitleCue[] | null> {
  const url = new URL(trackUrl);
  if (!url.searchParams.get("fmt")) {
    url.searchParams.set("fmt", "json3");
  }
  const response = await fetch(url.toString());
  if (!response.ok) {
    return null;
  }
  const data = (await response.json()) as Json3Response;
  return parseJson3(data);
}

async function tryFetchXml(trackUrl: string): Promise<SubtitleCue[] | null> {
  const url = new URL(trackUrl);
  url.searchParams.delete("fmt");
  const response = await fetch(url.toString());
  if (!response.ok) {
    return null;
  }
  const text = await response.text();
  return parseXml(text);
}

export async function fetchSubtitleCues(
  track: YouTubeCaptionTrack
): Promise<SubtitleCue[]> {
  const jsonCues = await tryFetchJson(track.baseUrl);
  if (jsonCues && jsonCues.length > 0) {
    return jsonCues;
  }
  const xmlCues = await tryFetchXml(track.baseUrl);
  return xmlCues ?? [];
}

export function selectPreferredTrack(
  tracks: YouTubeCaptionTrack[]
): YouTubeCaptionTrack | null {
  if (!tracks.length) {
    return null;
  }

  const withoutAsr = tracks.filter((track) => track.kind !== "asr");
  const candidates = withoutAsr.length > 0 ? withoutAsr : tracks;

  const englishExact = candidates.find(
    (track) => track.languageCode.toLowerCase() === "en"
  );
  if (englishExact) {
    return englishExact;
  }

  const englishLike = candidates.find((track) =>
    track.languageCode.toLowerCase().startsWith("en")
  );
  if (englishLike) {
    return englishLike;
  }

  return candidates[0];
}
