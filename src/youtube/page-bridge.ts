import { PAGE_BRIDGE_SOURCE } from "@shared/constants";
import type { YouTubeCaptionTrack } from "@shared/types";

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
  }
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
  } catch (_error) {
    return null;
  }
}

function extractTrackName(track: {
  name?: { simpleText?: string; runs?: Array<{ text?: string }> };
}): string | undefined {
  const simple = track.name?.simpleText;
  if (simple) {
    return simple;
  }
  const fromRuns = track.name?.runs?.map((item) => item.text ?? "").join("");
  return fromRuns?.trim() || undefined;
}

function extractTracks(response: PlayerResponseLike | null): YouTubeCaptionTrack[] {
  const captionTracks =
    response?.captions?.playerCaptionsTracklistRenderer?.captionTracks ?? [];
  return captionTracks
    .filter((track) => track.baseUrl && track.languageCode)
    .map((track) => ({
      baseUrl: track.baseUrl as string,
      languageCode: track.languageCode as string,
      kind: track.kind,
      name: extractTrackName(track)
    }));
}

function emitTracks(): void {
  const response = readPlayerResponse();
  const tracks = extractTracks(response);
  const videoId = getCurrentVideoId();
  window.postMessage(
    {
      source: PAGE_BRIDGE_SOURCE,
      type: "tracks",
      payload: {
        videoId,
        tracks
      }
    },
    "*"
  );
}

function scheduleEmitTracks(): void {
  emitTracks();
  window.setTimeout(emitTracks, 700);
  window.setTimeout(emitTracks, 1800);
}

window.addEventListener("yt-navigate-finish", scheduleEmitTracks);
window.addEventListener("load", scheduleEmitTracks);
document.addEventListener("readystatechange", () => {
  if (document.readyState === "complete") {
    scheduleEmitTracks();
  }
});

scheduleEmitTracks();
