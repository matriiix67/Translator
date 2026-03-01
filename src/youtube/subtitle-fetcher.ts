import type { SubtitleCue, YouTubeCaptionTrack } from "@shared/types";

/* ------------------------------------------------------------------ */
/*  DOM / HTML based caption track extraction (bypasses page CSP)      */
/* ------------------------------------------------------------------ */

interface PlayerResponseLike {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl?: string;
        languageCode?: string;
        kind?: string;
        name?: {
          simpleText?: string;
          runs?: Array<{ text?: string }>;
        };
      }>;
    };
  };
  videoDetails?: {
    videoId?: string;
  };
}

export interface TrackDiscoveryResult {
  videoId: string | null;
  tracks: YouTubeCaptionTrack[];
  source: string;
}

export interface CapturedSubtitlePayload {
  text: string;
  fmt?: string;
  languageCode?: string;
  kind?: string;
}

function getVideoIdFromURL(): string | null {
  try {
    return new URL(window.location.href).searchParams.get("v");
  } catch {
    return null;
  }
}

function findMatchingBrace(text: string, start: number): number {
  let depth = 0;
  let inString = false;
  let stringChar = "";
  let escape = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (escape) {
      escape = false;
      continue;
    }

    if (ch === "\\" && inString) {
      escape = true;
      continue;
    }

    if (inString) {
      if (ch === stringChar) {
        inString = false;
      }
      continue;
    }

    if (ch === '"' || ch === "'") {
      inString = true;
      stringChar = ch;
      continue;
    }

    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) return i + 1;
    }
  }

  return -1;
}

function parsePlayerResponseJSON(
  jsonStr: string
): { videoId: string | null; tracks: YouTubeCaptionTrack[] } | null {
  try {
    const obj = JSON.parse(jsonStr) as PlayerResponseLike;
    const captionTracks =
      obj?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
    const videoId = obj?.videoDetails?.videoId ?? null;
    const tracks: YouTubeCaptionTrack[] = captionTracks
      .filter((t) => t.baseUrl && t.languageCode)
      .map((t) => ({
        baseUrl: t.baseUrl!,
        languageCode: t.languageCode!,
        kind: t.kind,
        name:
          t.name?.simpleText ??
          t.name?.runs?.map((r) => r.text ?? "").join("") ??
          undefined
      }));
    return { videoId, tracks };
  } catch {
    return null;
  }
}

function extractPlayerResponseFromText(
  text: string
): { videoId: string | null; tracks: YouTubeCaptionTrack[] } | null {
  const marker = "ytInitialPlayerResponse";
  let searchStart = 0;

  while (searchStart < text.length) {
    const idx = text.indexOf(marker, searchStart);
    if (idx < 0) break;

    const eqIdx = text.indexOf("=", idx + marker.length);
    if (eqIdx < 0) break;

    const between = text.slice(idx + marker.length, eqIdx).trim();
    if (between.length > 0) {
      searchStart = eqIdx + 1;
      continue;
    }

    const braceIdx = text.indexOf("{", eqIdx);
    if (braceIdx < 0) break;

    const between2 = text.slice(eqIdx + 1, braceIdx).trim();
    if (between2.length > 0) {
      searchStart = braceIdx + 1;
      continue;
    }

    const endIdx = findMatchingBrace(text, braceIdx);
    if (endIdx < 0) break;

    const result = parsePlayerResponseJSON(text.slice(braceIdx, endIdx));
    if (result && result.tracks.length > 0) {
      return result;
    }

    searchStart = endIdx;
  }

  return null;
}

export function extractTracksFromDOM(): TrackDiscoveryResult {
  const scripts = document.querySelectorAll<HTMLScriptElement>(
    "script:not([src])"
  );
  for (const script of scripts) {
    const text = script.textContent ?? "";
    if (!text.includes("ytInitialPlayerResponse")) continue;
    const result = extractPlayerResponseFromText(text);
    if (result && result.tracks.length > 0) {
      return {
        videoId: result.videoId ?? getVideoIdFromURL(),
        tracks: result.tracks,
        source: "dom-script"
      };
    }
  }
  return { videoId: getVideoIdFromURL(), tracks: [], source: "dom-empty" };
}

export async function fetchTracksForVideoId(
  videoId: string
): Promise<TrackDiscoveryResult> {
  try {
    const response = await fetch(
      `https://www.youtube.com/watch?v=${videoId}`,
      { credentials: "same-origin" }
    );
    if (!response.ok) {
      return { videoId, tracks: [], source: "fetch-http-error" };
    }
    const html = await response.text();
    const result = extractPlayerResponseFromText(html);
    if (result && result.tracks.length > 0) {
      return {
        videoId: result.videoId ?? videoId,
        tracks: result.tracks,
        source: "fetch-html"
      };
    }
    return { videoId, tracks: [], source: "fetch-no-tracks" };
  } catch {
    return { videoId, tracks: [], source: "fetch-error" };
  }
}

/* ------------------------------------------------------------------ */
/*  Subtitle cue fetching and parsing                                  */
/* ------------------------------------------------------------------ */

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

  // Cap default-duration cues at the next cue's start to prevent overlap
  for (let i = 0; i < cues.length - 1; i += 1) {
    const nextStart = cues[i + 1].start;
    if (cues[i].end > nextStart) {
      cues[i].end = nextStart;
      cues[i].duration = cues[i].end - cues[i].start;
    }
  }

  return cues;
}

function parseXml(xmlText: string): SubtitleCue[] {
  const parser = new DOMParser();
  const doc = parser.parseFromString(xmlText, "text/xml");
  const cues: SubtitleCue[] = [];
  const allElements = Array.from(doc.getElementsByTagName("*"));

  // 兼容 classic timedtext: <text start=".." dur="..">..</text>
  const textNodes = allElements.filter((el) => el.localName === "text");
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

  // 兼容 srv3/ttml 类结构: <p t="1234" d="2345">..</p>
  const pNodes = allElements.filter((el) => el.localName === "p");
  for (const node of pNodes) {
    const tRaw = Number(node.getAttribute("t") ?? node.getAttribute("start") ?? "0");
    const dRaw = Number(node.getAttribute("d") ?? node.getAttribute("dur") ?? "0");
    const useMs = node.hasAttribute("t") || node.hasAttribute("d");
    const start = useMs ? tRaw / 1000 : tRaw;
    const duration = useMs ? dRaw / 1000 : dRaw;
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

  if (cues.length === 0) {
    return cues;
  }

  cues.sort((a, b) => a.start - b.start);
  const deduped: SubtitleCue[] = [];
  let lastKey = "";
  for (const cue of cues) {
    const key = `${cue.start.toFixed(3)}|${cue.text}`;
    if (key !== lastKey) {
      deduped.push(cue);
      lastKey = key;
    }
  }

  return deduped;
}

function parseVttTimestamp(value: string): number {
  const raw = value.trim();
  const parts = raw.split(":");
  if (parts.length < 2 || parts.length > 3) {
    return Number.NaN;
  }
  const secondsPart = parts[parts.length - 1];
  const minutesPart = parts[parts.length - 2];
  const hoursPart = parts.length === 3 ? parts[0] : "0";

  const seconds = Number(secondsPart.replace(",", "."));
  const minutes = Number(minutesPart);
  const hours = Number(hoursPart);

  if ([seconds, minutes, hours].some((n) => Number.isNaN(n))) {
    return Number.NaN;
  }
  return hours * 3600 + minutes * 60 + seconds;
}

function parseWebVtt(vttText: string): SubtitleCue[] {
  const lines = vttText.replace(/\r/g, "").split("\n");
  const cues: SubtitleCue[] = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line.includes("-->")) {
      continue;
    }

    const [startRaw, endRaw] = line.split("-->").map((part) => part.trim().split(" ")[0]);
    const start = parseVttTimestamp(startRaw);
    const end = parseVttTimestamp(endRaw);
    if (Number.isNaN(start) || Number.isNaN(end) || end <= start) {
      continue;
    }

    const textLines: string[] = [];
    let j = i + 1;
    while (j < lines.length && lines[j].trim() !== "") {
      textLines.push(lines[j]);
      j += 1;
    }

    const text = normalizeCueText(textLines.join(" "));
    if (text) {
      cues.push({
        start,
        end,
        duration: end - start,
        text
      });
    }

    i = j;
  }

  return cues;
}

export function parseCapturedSubtitlePayload(
  payload: CapturedSubtitlePayload
): SubtitleCue[] {
  const body = payload.text.trim();
  if (!body) {
    return [];
  }
  const fmt = (payload.fmt ?? "").toLowerCase();
  if (fmt.includes("json3") || body.startsWith("{")) {
    try {
      const data = JSON.parse(body) as Json3Response;
      return parseJson3(data);
    } catch {
      // keep falling back
    }
  }
  if (fmt.includes("vtt") || body.startsWith("WEBVTT")) {
    return parseWebVtt(body);
  }
  return parseXml(body);
}

/**
 * 将可能指向 googlevideo CDN 的字幕 URL 重建为标准 youtube.com/api/timedtext URL。
 * 部分 ASR 轨道的 baseUrl 会被签名后指向 CDN，从 content script 直接 fetch 会得到 403。
 */
function buildYouTubeTimedTextUrl(url: URL, fmt: string): string {
  // 如果本身就是 youtube.com，仅确保 fmt 参数正确
  if (url.hostname.endsWith("youtube.com")) {
    const copy = new URL(url.toString());
    copy.searchParams.delete("fmt");
    copy.searchParams.set("fmt", fmt);
    return copy.toString();
  }

  // CDN URL：从 query params 里重建 youtube.com timedtext 请求
  const rebuilt = new URL("https://www.youtube.com/api/timedtext");
  rebuilt.searchParams.set("fmt", fmt);

  for (const key of ["v", "docid", "lang", "tlang", "kind", "name", "expire",
                      "signature", "sig", "sparams", "key", "asr_langs", "caps"]) {
    const val = url.searchParams.get(key);
    if (val) rebuilt.searchParams.set(key, val);
  }

  return rebuilt.toString();
}

async function fetchOneUrl(target: string): Promise<string | null> {
  let response: Response;
  try {
    response = await fetch(target, { credentials: "include" });
  } catch {
    return null;
  }
  if (!response.ok) {
    console.log("[AI Translator] subtitle fetch HTTP", response.status, target.slice(0, 100));
    return null;
  }
  const text = await response.text();
  const trimmed = text.trim();
  if (!trimmed) {
    return null;
  }
  console.log(
    "[AI Translator] subtitle body len", trimmed.length,
    "head:", trimmed.slice(0, 80).replace(/\n/g, " ")
  );
  return trimmed;
}

async function tryFetchJson(trackUrl: string): Promise<SubtitleCue[] | null> {
  const url = new URL(trackUrl);
  const ytUrl = buildYouTubeTimedTextUrl(url, "json3");
  const cdnUrl = (() => {
    const u = new URL(trackUrl);
    u.searchParams.delete("fmt");
    u.searchParams.set("fmt", "json3");
    return u.toString();
  })();

  // 优先用 youtube.com timedtext（不受 CDN 鉴权限制）
  const targets = ytUrl !== cdnUrl ? [ytUrl, cdnUrl] : [ytUrl];

  for (const target of targets) {
    const body = await fetchOneUrl(target);
    if (!body) continue;
    try {
      const data = JSON.parse(body) as Json3Response;
      const cues = parseJson3(data);
      if (cues.length > 0) return cues;
      console.log("[AI Translator] json3 returned 0 cues");
    } catch {
      console.log("[AI Translator] json3 parse failed, head:", body.slice(0, 60));
    }
  }
  return null;
}

async function tryFetchXml(trackUrl: string): Promise<SubtitleCue[] | null> {
  const url = new URL(trackUrl);
  const ytUrl = buildYouTubeTimedTextUrl(url, "");
  const cdnUrl = (() => {
    const u = new URL(trackUrl);
    u.searchParams.delete("fmt");
    return u.toString();
  })();
  const targets = ytUrl !== cdnUrl ? [ytUrl, cdnUrl] : [ytUrl];

  for (const target of targets) {
    const body = await fetchOneUrl(target);
    if (!body) continue;
    const cues = body.startsWith("WEBVTT") ? parseWebVtt(body) : parseXml(body);
    if (cues.length > 0) return cues;
  }
  return null;
}

export async function fetchSubtitleCues(
  track: YouTubeCaptionTrack
): Promise<SubtitleCue[]> {
  try {
    const jsonCues = await tryFetchJson(track.baseUrl);
    if (jsonCues && jsonCues.length > 0) {
      return jsonCues;
    }
    const xmlCues = await tryFetchXml(track.baseUrl);
    return xmlCues ?? [];
  } catch {
    return [];
  }
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
