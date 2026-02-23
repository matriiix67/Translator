/** @vitest-environment jsdom */

import { describe, expect, test } from "vitest";

import { SubtitleRenderer } from "../src/youtube/subtitle-renderer";

async function flushFrames(times = 2): Promise<void> {
  for (let i = 0; i < times; i += 1) {
    await new Promise<void>((resolve) => {
      if (typeof window.requestAnimationFrame === "function") {
        window.requestAnimationFrame(() => resolve());
        return;
      }
      window.setTimeout(() => resolve(), 0);
    });
  }
}

describe("SubtitleRenderer", () => {
  test("shows translated subtitle even when native segment is not visible", async () => {
    document.body.innerHTML = `
      <div class="html5-video-player">
        <div class="ytp-caption-window-container">
          <div class="ytp-caption-window"></div>
        </div>
      </div>
    `;

    const renderer = new SubtitleRenderer();
    renderer.setTranslation("测试译文");
    await flushFrames(3);

    const wrapper = document.querySelector<HTMLDivElement>(
      ".ai-translator-yt-translation-wrapper"
    );
    const line = document.querySelector<HTMLDivElement>(".ai-translator-yt-translation-line");

    expect(wrapper).not.toBeNull();
    expect(line).not.toBeNull();
    expect(line?.textContent).toBe("测试译文");
    expect(wrapper?.style.display).toBe("flex");
    expect(wrapper?.style.position).toBe("absolute");
    const left = Number.parseFloat(wrapper?.style.left ?? "");
    expect(Number.isFinite(left)).toBe(true);

    renderer.destroy();
  });

  test("supports fallback caption container selectors", async () => {
    document.body.innerHTML = `
      <div class="html5-video-player">
        <div class="captions-text"></div>
      </div>
    `;

    const renderer = new SubtitleRenderer();
    renderer.setTranslation("fallback");
    await flushFrames(3);

    const wrapper = document.querySelector<HTMLDivElement>(
      ".ai-translator-yt-translation-wrapper"
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.display).toBe("flex");

    renderer.hide();
    await flushFrames(2);
    expect(wrapper?.style.display).toBe("none");

    renderer.destroy();
  });

  test("keeps subtitle near native segment bottom when native caption exists", async () => {
    document.body.innerHTML = `
      <div class="html5-video-player">
        <div class="ytp-caption-window-container">
          <div class="ytp-caption-window">
            <span class="ytp-caption-segment">native subtitle</span>
          </div>
        </div>
      </div>
    `;

    const player = document.querySelector(".html5-video-player") as HTMLElement;
    const segment = document.querySelector(".ytp-caption-segment") as HTMLElement;
    Object.defineProperty(player, "getBoundingClientRect", {
      value: () => ({ bottom: 720, top: 0, left: 0, right: 1280, width: 1280, height: 720 }),
      configurable: true
    });
    Object.defineProperty(segment, "getBoundingClientRect", {
      value: () => ({ bottom: 650, top: 620, left: 300, right: 980, width: 680, height: 30 }),
      configurable: true
    });

    const renderer = new SubtitleRenderer();
    renderer.setTranslation("with-native");
    await flushFrames(3);

    const wrapper = document.querySelector<HTMLDivElement>(
      ".ai-translator-yt-translation-wrapper"
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.display).toBe("flex");
    const top = Number.parseFloat(wrapper?.style.top ?? "");
    expect(Number.isFinite(top)).toBe(true);
    // Should stay below native segment area; when space is tight it may clamp near bottom edge.
    expect(top >= 651).toBe(true);
    expect(wrapper?.style.bottom).toBe("auto");

    renderer.destroy();
  });

  test("supports dragging translated subtitle to avoid overlap", async () => {
    document.body.innerHTML = `
      <div class="html5-video-player">
        <div class="ytp-caption-window-container">
          <div class="ytp-caption-window">
            <span class="ytp-caption-segment">native subtitle</span>
          </div>
        </div>
      </div>
    `;

    const player = document.querySelector(".html5-video-player") as HTMLElement;
    const segment = document.querySelector(".ytp-caption-segment") as HTMLElement;
    Object.defineProperty(player, "getBoundingClientRect", {
      value: () => ({ bottom: 720, top: 0, left: 0, right: 1280, width: 1280, height: 720 }),
      configurable: true
    });
    Object.defineProperty(segment, "getBoundingClientRect", {
      value: () => ({ bottom: 650, top: 620, left: 300, right: 980, width: 680, height: 30 }),
      configurable: true
    });

    const renderer = new SubtitleRenderer();
    renderer.setTranslation("drag-me");
    await flushFrames(3);

    const wrapper = document.querySelector<HTMLDivElement>(
      ".ai-translator-yt-translation-wrapper"
    );
    const line = document.querySelector<HTMLDivElement>(".ai-translator-yt-translation-line");
    expect(wrapper).not.toBeNull();
    expect(line).not.toBeNull();

    const beforeTop = Number.parseFloat(wrapper?.style.top ?? "0");
    const beforeLeft = Number.parseFloat(wrapper?.style.left ?? "0");

    line?.dispatchEvent(
      new MouseEvent("mousedown", {
        bubbles: true,
        button: 0,
        clientX: 240,
        clientY: 300
      })
    );
    window.dispatchEvent(
      new MouseEvent("mousemove", {
        bubbles: true,
        clientX: 290,
        clientY: 220
      })
    );
    await flushFrames(2);
    window.dispatchEvent(new MouseEvent("mouseup", { bubbles: true }));
    await flushFrames(1);

    const afterTop = Number.parseFloat(wrapper?.style.top ?? "0");
    const afterLeft = Number.parseFloat(wrapper?.style.left ?? "0");

    expect(afterTop).toBeLessThan(beforeTop);
    expect(afterLeft).toBeGreaterThan(beforeLeft);

    renderer.destroy();
  });
});
