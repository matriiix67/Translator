import { describe, expect, test } from "vitest";

import { selectPreferredTrack } from "../src/youtube/subtitle-fetcher";

describe("selectPreferredTrack", () => {
  test("prefers non-ASR english tracks", () => {
    const track = selectPreferredTrack([
      {
        baseUrl: "https://example.com/asr",
        languageCode: "en",
        kind: "asr"
      },
      {
        baseUrl: "https://example.com/manual",
        languageCode: "en"
      }
    ]);

    expect(track?.baseUrl).toBe("https://example.com/manual");
  });

  test("falls back to first available track", () => {
    const track = selectPreferredTrack([
      {
        baseUrl: "https://example.com/es",
        languageCode: "es"
      }
    ]);

    expect(track?.languageCode).toBe("es");
  });
});
