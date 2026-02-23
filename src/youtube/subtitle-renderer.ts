export class SubtitleRenderer {
  private observer: MutationObserver | null = null;

  private syncScheduled = false;

  private nativeCaptionContainer: HTMLElement | null = null;

  private translatedWrapper: HTMLDivElement | null = null;

  private translatedLine: HTMLDivElement | null = null;

  private latestTranslation = "";

  private lastNativeHiddenLogAt = 0;

  observeNativeCaptions(): void {
    if (this.observer) {
      return;
    }
    const root = document.body ?? document.documentElement;
    if (!root) {
      return;
    }
    this.observer = new MutationObserver(() => this.scheduleSync());
    this.observer.observe(root, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "aria-hidden"]
    });
    this.scheduleSync();
  }

  setTranslation(translation: string): void {
    this.latestTranslation = translation.trim();
    this.observeNativeCaptions();
    this.scheduleSync();
  }

  hide(): void {
    this.latestTranslation = "";
    if (this.translatedWrapper) {
      this.translatedWrapper.style.display = "none";
    }
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.detachTranslatedWrapper();
    this.nativeCaptionContainer = null;
    this.latestTranslation = "";
  }

  private scheduleSync(): void {
    if (this.syncScheduled) {
      return;
    }
    this.syncScheduled = true;
    window.requestAnimationFrame(() => {
      this.syncScheduled = false;
      this.syncToNativeCaptions();
    });
  }

  private syncToNativeCaptions(): void {
    const captionRoot = this.findNativeCaptionContainer();
    const playerHost = this.findPlayerContainer();
    if (!playerHost) {
      this.detachTranslatedWrapper();
      this.nativeCaptionContainer = null;
      return;
    }

    if (this.nativeCaptionContainer !== playerHost) {
      this.detachTranslatedWrapper();
      this.nativeCaptionContainer = playerHost;
    }

    this.ensureTranslatedNode();
    if (!this.translatedWrapper || !this.translatedLine) {
      return;
    }

    const hasNativeCaption = captionRoot ? this.hasVisibleNativeCaption(captionRoot) : false;
    const hasTranslation = Boolean(this.latestTranslation);
    this.translatedLine.textContent = this.latestTranslation;
    if (!hasNativeCaption && hasTranslation) {
      const now = Date.now();
      if (now - this.lastNativeHiddenLogAt > 3000) {
        this.lastNativeHiddenLogAt = now;
        console.warn(
          "[AI Translator][phase:render_blocked_by_native_caption]",
          "native caption is not visible, fallback to show translated subtitle"
        );
      }
    }
    // Some videos use different caption segment visibility rules.
    // Keep translated subtitle visible as long as we have text.
    this.positionWrapper(playerHost, captionRoot, hasNativeCaption);
    this.translatedWrapper.style.display = hasTranslation ? "flex" : "none";
  }

  private findPlayerContainer(): HTMLElement | null {
    return document.querySelector<HTMLElement>(".html5-video-player");
  }

  private findNativeCaptionContainer(): HTMLElement | null {
    const selectors = [
      ".html5-video-player .ytp-caption-window-container",
      ".html5-video-player .caption-window-container",
      ".html5-video-player .captions-text"
    ];
    for (const selector of selectors) {
      const found = document.querySelector<HTMLElement>(selector);
      if (found) {
        return found;
      }
    }
    return null;
  }

  private hasVisibleNativeCaption(container: HTMLElement): boolean {
    const segments = container.querySelectorAll<HTMLElement>(".ytp-caption-segment");
    if (segments.length === 0) {
      return false;
    }
    return Array.from(segments).some((segment) => {
      const text = segment.textContent?.trim() ?? "";
      if (!text) {
        return false;
      }
      const style = window.getComputedStyle(segment);
      return style.display !== "none" && style.visibility !== "hidden";
    });
  }

  private ensureTranslatedNode(): void {
    if (!this.nativeCaptionContainer) {
      return;
    }

    const currentWrapper =
      this.translatedWrapper &&
      this.translatedWrapper.isConnected &&
      this.translatedWrapper.parentElement === this.nativeCaptionContainer
        ? this.translatedWrapper
        : null;

    const wrapper =
      currentWrapper ??
      this.nativeCaptionContainer.querySelector<HTMLDivElement>(
        ".ai-translator-yt-translation-wrapper"
      ) ??
      document.createElement("div");

    if (!wrapper.classList.contains("ai-translator-yt-translation-wrapper")) {
      wrapper.className = "ai-translator-yt-translation-wrapper";
    }
    const hostStyle = window.getComputedStyle(this.nativeCaptionContainer);
    if (hostStyle.position === "static") {
      this.nativeCaptionContainer.style.position = "relative";
    }
    wrapper.style.width = "calc(100% - 24px)";
    wrapper.style.maxWidth = "960px";
    wrapper.style.display = "none";
    wrapper.style.justifyContent = "center";
    wrapper.style.marginTop = "0";
    wrapper.style.pointerEvents = "none";
    wrapper.style.position = "absolute";
    wrapper.style.left = "50%";
    wrapper.style.transform = "translateX(-50%)";
    wrapper.style.bottom = "56px";
    wrapper.style.zIndex = "2147483000";

    let line =
      this.translatedLine &&
      this.translatedLine.isConnected &&
      this.translatedLine.parentElement === wrapper
        ? this.translatedLine
        : wrapper.querySelector<HTMLDivElement>(".ai-translator-yt-translation-line");

    if (!line) {
      line = document.createElement("div");
      line.className = "ai-translator-yt-translation-line";
      wrapper.appendChild(line);
    }

    line.style.color = "#ffcc40";
    line.style.fontSize = "20px";
    line.style.fontWeight = "500";
    line.style.lineHeight = "1.35";
    line.style.textAlign = "center";
    line.style.padding = "4px 14px";
    line.style.border = "2px solid #ff6644";
    line.style.borderRadius = "8px";
    line.style.background = "rgba(0, 0, 0, 0.55)";
    line.style.display = "inline-block";
    line.style.maxWidth = "88%";
    line.style.whiteSpace = "pre-wrap";
    line.style.wordBreak = "break-word";
    line.style.textShadow = "0 1px 2px rgba(0, 0, 0, 0.85)";
    line.style.boxSizing = "border-box";

    if (!wrapper.isConnected) {
      this.nativeCaptionContainer.appendChild(wrapper);
    }

    this.translatedWrapper = wrapper;
    this.translatedLine = line;
  }

  private positionWrapper(
    playerHost: HTMLElement,
    captionRoot: HTMLElement | null,
    hasNativeCaption: boolean
  ): void {
    if (!this.translatedWrapper) {
      return;
    }
    let bottomPx = 56;
    if (captionRoot && hasNativeCaption) {
      const visibleSegments = Array.from(
        captionRoot.querySelectorAll<HTMLElement>(".ytp-caption-segment")
      ).filter((segment) => {
        const text = segment.textContent?.trim() ?? "";
        if (!text) {
          return false;
        }
        const style = window.getComputedStyle(segment);
        return style.display !== "none" && style.visibility !== "hidden";
      });
      if (visibleSegments.length > 0) {
        const playerRect = playerHost.getBoundingClientRect();
        const maxBottom = Math.max(
          ...visibleSegments.map((segment) => segment.getBoundingClientRect().bottom)
        );
        const offsetFromBottom = Math.round(playerRect.bottom - maxBottom - 6);
        bottomPx = Math.max(28, Math.min(180, offsetFromBottom));
      }
    }
    this.translatedWrapper.style.bottom = `${bottomPx}px`;
  }

  private detachTranslatedWrapper(): void {
    this.translatedWrapper?.remove();
    this.translatedWrapper = null;
    this.translatedLine = null;
  }
}
