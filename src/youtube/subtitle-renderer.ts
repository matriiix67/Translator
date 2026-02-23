export class SubtitleRenderer {
  private observer: MutationObserver | null = null;

  private syncScheduled = false;

  private nativeCaptionContainer: HTMLElement | null = null;

  private translatedWrapper: HTMLDivElement | null = null;

  private translatedLine: HTMLDivElement | null = null;

  private latestTranslation = "";

  private lastNativeHiddenLogAt = 0;

  private dragOffsetX = 0;

  private dragOffsetY = 0;

  private dragActive = false;

  private dragStartX = 0;

  private dragStartY = 0;

  private dragOriginOffsetX = 0;

  private dragOriginOffsetY = 0;

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
    this.stopDrag();
    this.unbindDragEvents();
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
    if (hasTranslation) {
      // Ensure measurable box metrics before positioning.
      this.translatedWrapper.style.display = "flex";
    }
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
    wrapper.style.pointerEvents = "auto";
    wrapper.style.position = "absolute";
    wrapper.style.left = "12px";
    wrapper.style.top = "56px";
    wrapper.style.bottom = "auto";
    wrapper.style.transform = "none";
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
    line.style.cursor = this.dragActive ? "grabbing" : "grab";
    line.style.userSelect = "none";
    line.onmousedown = (event: MouseEvent) => this.startDrag(event);

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
    const playerRect = playerHost.getBoundingClientRect();
    const measuredWrapperHeight = this.translatedWrapper.getBoundingClientRect().height;
    const wrapperHeight = measuredWrapperHeight > 0 ? measuredWrapperHeight : 52;
    const measuredWrapperWidth = this.translatedWrapper.getBoundingClientRect().width;
    const wrapperWidth = measuredWrapperWidth > 0 ? measuredWrapperWidth : 420;
    const minTop = 16;
    const maxTop = Math.max(minTop, playerRect.height - wrapperHeight - 16);
    const minLeft = 8;
    const maxLeft = Math.max(minLeft, playerRect.width - wrapperWidth - 8);
    const centeredLeft = (playerRect.width - wrapperWidth) / 2;
    let topPx = maxTop - 44;

    const controls = playerHost.querySelector<HTMLElement>(".ytp-chrome-bottom");
    if (controls) {
      const controlsRect = controls.getBoundingClientRect();
      const controlsHeight = controlsRect.height > 0 ? controlsRect.height : 48;
      topPx = playerRect.height - wrapperHeight - controlsHeight - 14;
    }

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
        const minSegmentTop = Math.min(
          ...visibleSegments.map((segment) => segment.getBoundingClientRect().top)
        );
        const maxBottom = Math.max(
          ...visibleSegments.map((segment) => segment.getBoundingClientRect().bottom)
        );
        const gap = 8;
        const segmentTop = minSegmentTop - playerRect.top;
        const segmentBottom = maxBottom - playerRect.top;
        // Always place translated subtitle below native subtitle first.
        topPx = segmentBottom + gap;
        // If native subtitle is unusually high, keep translated subtitle from floating too high.
        topPx = Math.max(topPx, segmentTop + 4);
      }
    }

    const clampedTop = Math.max(minTop, Math.min(maxTop, topPx + this.dragOffsetY));
    const clampedLeft = Math.max(
      minLeft,
      Math.min(maxLeft, centeredLeft + this.dragOffsetX)
    );
    this.dragOffsetX = clampedLeft - centeredLeft;
    this.dragOffsetY = clampedTop - topPx;
    this.translatedWrapper.style.left = `${Math.round(clampedLeft)}px`;
    this.translatedWrapper.style.top = `${Math.round(clampedTop)}px`;
    this.translatedWrapper.style.bottom = "auto";
  }

  private startDrag(event: MouseEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    this.dragActive = true;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    this.dragOriginOffsetX = this.dragOffsetX;
    this.dragOriginOffsetY = this.dragOffsetY;
    if (this.translatedLine) {
      this.translatedLine.style.cursor = "grabbing";
    }
    this.bindDragEvents();
  }

  private bindDragEvents(): void {
    window.addEventListener("mousemove", this.handleDragMove);
    window.addEventListener("mouseup", this.handleDragEnd);
  }

  private unbindDragEvents(): void {
    window.removeEventListener("mousemove", this.handleDragMove);
    window.removeEventListener("mouseup", this.handleDragEnd);
  }

  private stopDrag(): void {
    this.dragActive = false;
    if (this.translatedLine) {
      this.translatedLine.style.cursor = "grab";
    }
  }

  private readonly handleDragMove = (event: MouseEvent): void => {
    if (!this.dragActive) {
      return;
    }
    const dx = event.clientX - this.dragStartX;
    const dy = event.clientY - this.dragStartY;
    this.dragOffsetX = this.dragOriginOffsetX + dx;
    this.dragOffsetY = this.dragOriginOffsetY + dy;
    this.scheduleSync();
  };

  private readonly handleDragEnd = (): void => {
    if (!this.dragActive) {
      return;
    }
    this.stopDrag();
    this.unbindDragEvents();
  };

  private detachTranslatedWrapper(): void {
    this.translatedWrapper?.remove();
    this.translatedWrapper = null;
    this.translatedLine = null;
  }
}
