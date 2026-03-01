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

  test("positions subtitle above controls bar using bottom", async () => {
    document.body.innerHTML = `
      <div class="html5-video-player">
        <div class="ytp-caption-window-container">
          <div class="ytp-caption-window">
            <span class="ytp-caption-segment">native subtitle</span>
          </div>
        </div>
        <div class="ytp-chrome-bottom"></div>
      </div>
    `;

    const player = document.querySelector(".html5-video-player") as HTMLElement;
    const controls = document.querySelector(".ytp-chrome-bottom") as HTMLElement;
    Object.defineProperty(player, "getBoundingClientRect", {
      value: () => ({ bottom: 720, top: 0, left: 0, right: 1280, width: 1280, height: 720 }),
      configurable: true
    });
    Object.defineProperty(controls, "offsetHeight", { value: 48, configurable: true });

    const renderer = new SubtitleRenderer();
    renderer.setTranslation("with-native");
    await flushFrames(3);

    const wrapper = document.querySelector<HTMLDivElement>(
      ".ai-translator-yt-translation-wrapper"
    );
    expect(wrapper).not.toBeNull();
    expect(wrapper?.style.display).toBe("flex");
    // Should use bottom positioning
    const bottom = Number.parseFloat(wrapper?.style.bottom ?? "");
    expect(Number.isFinite(bottom)).toBe(true);
    expect(bottom).toBeGreaterThan(0);
    expect(wrapper?.style.top).toBe("auto");

    renderer.destroy();
  });

  test("supports dragging translated subtitle to reposition", async () => {
    document.body.innerHTML = `
      <div class="html5-video-player">
        <div class="ytp-caption-window-container">
          <div class="caption-window">
            <span class="ytp-caption-segment">native subtitle</span>
          </div>
        </div>
        <div class="ytp-chrome-bottom"></div>
      </div>
    `;

    const player = document.querySelector(".html5-video-player") as HTMLElement;
    const controls = document.querySelector(".ytp-chrome-bottom") as HTMLElement;
    Object.defineProperty(player, "getBoundingClientRect", {
      value: () => ({ bottom: 720, top: 0, left: 0, right: 1280, width: 1280, height: 720 }),
      configurable: true
    });
    Object.defineProperty(controls, "offsetHeight", { value: 48, configurable: true });

    const renderer = new SubtitleRenderer();
    renderer.setTranslation("drag-me");
    await flushFrames(3);

    const wrapper = document.querySelector<HTMLDivElement>(
      ".ai-translator-yt-translation-wrapper"
    );
    const contentBox = document.querySelector<HTMLDivElement>(".ai-translator-yt-content-box");
    expect(wrapper).not.toBeNull();
    expect(contentBox).not.toBeNull();

    const beforeBottom = wrapper?.style.bottom;

    // Drag via contentBox (mousedown is bound there)
    contentBox?.dispatchEvent(
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

    // After drag, position should have changed
    const afterBottom = wrapper?.style.bottom;
    expect(afterBottom).not.toBe(beforeBottom);

    renderer.destroy();
  });
});
