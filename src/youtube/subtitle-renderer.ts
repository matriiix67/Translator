export class SubtitleRenderer {
  private observer: MutationObserver | null = null;

  private syncScheduled = false;

  private nativeCaptionContainer: HTMLElement | null = null;

  private translatedWrapper: HTMLDivElement | null = null;

  private translatedLine: HTMLDivElement | null = null;

  private latestTranslation = "";

  private latestSource = "";

  private sourceLine: HTMLDivElement | null = null;

  private hideStyleElement: HTMLStyleElement | null = null;

  private lastNativeHiddenLogAt = 0;

  private dragOffsetX = 0;

  private dragOffsetY = 0;

  private dragActive = false;

  private dragStartX = 0;

  private dragStartY = 0;

  private dragOriginOffsetX = 0;

  private dragOriginOffsetY = 0;

  private lastAppliedTop: number | null = null;

  private scopedObserver: MutationObserver | null = null;

  private observedCaptionRoot: HTMLElement | null = null;

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

  setTranslation(translation: string, source?: string): void {
    this.latestTranslation = translation.trim();
    this.latestSource = source?.trim() ?? "";
    this.observeNativeCaptions();
    this.scheduleSync();
  }

  hide(): void {
    this.latestTranslation = "";
    this.latestSource = "";
    this.restoreNativeCaptions();
    if (this.translatedWrapper) {
      this.translatedWrapper.style.display = "none";
    }
  }

  destroy(): void {
    this.stopDrag();
    this.unbindDragEvents();
    this.observer?.disconnect();
    this.observer = null;
    this.scopedObserver?.disconnect();
    this.scopedObserver = null;
    this.observedCaptionRoot = null;
    this.restoreNativeCaptions();
    this.detachTranslatedWrapper();
    this.hideStyleElement?.remove();
    this.hideStyleElement = null;
    this.nativeCaptionContainer = null;
    this.latestTranslation = "";
    this.latestSource = "";
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

    // Narrow MutationObserver scope once caption container is found.
    if (captionRoot && captionRoot !== this.observedCaptionRoot) {
      this.narrowObserverScope(captionRoot, playerHost);
    } else if (!captionRoot && this.observedCaptionRoot) {
      // Caption container lost (e.g. ad transition); fall back to body observer.
      this.scopedObserver?.disconnect();
      this.scopedObserver = null;
      this.observedCaptionRoot = null;
      this.observeNativeCaptions();
    }

    this.ensureTranslatedNode();
    if (!this.translatedWrapper || !this.translatedLine) {
      return;
    }

    const hasSource = Boolean(this.latestSource);
    const hasNativeCaption = captionRoot ? this.hasVisibleNativeCaption(captionRoot) : false;
    const hasTranslation = Boolean(this.latestTranslation);
    this.translatedLine.textContent = this.latestTranslation;

    // Show resegmented source and hide native captions when source is available.
    if (this.sourceLine) {
      if (hasSource) {
        this.sourceLine.textContent = this.latestSource;
        this.sourceLine.style.display = "inline-block";
        this.hideNativeCaptions(captionRoot);
      } else {
        this.sourceLine.textContent = "";
        this.sourceLine.style.display = "none";
        this.restoreNativeCaptions();
      }
    }

    if (hasTranslation) {
      // Ensure measurable box metrics before positioning.
      this.translatedWrapper.style.display = "flex";
    }
    if (!hasNativeCaption && !hasSource && hasTranslation) {
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

  private narrowObserverScope(captionRoot: HTMLElement, playerHost: HTMLElement): void {
    this.observer?.disconnect();
    this.observer = null;
    this.scopedObserver?.disconnect();
    this.scopedObserver = new MutationObserver(() => this.scheduleSync());
    this.scopedObserver.observe(captionRoot, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["style", "class", "aria-hidden"]
    });
    this.scopedObserver.observe(playerHost, {
      attributes: true,
      attributeFilter: ["style", "class"]
    });
    this.observedCaptionRoot = captionRoot;
  }

  private ensureHideStyle(): void {
    if (this.hideStyleElement?.isConnected) {
      return;
    }
    const style = document.createElement("style");
    style.textContent =
      ".ai-translator-native-hidden > * { visibility: hidden !important; }";
    (document.head ?? document.documentElement).appendChild(style);
    this.hideStyleElement = style;
  }

  private hideNativeCaptions(captionRoot: HTMLElement | null): void {
    if (!captionRoot) {
      return;
    }
    this.ensureHideStyle();
    captionRoot.classList.add("ai-translator-native-hidden");
  }

  private restoreNativeCaptions(): void {
    const captionRoot = this.findNativeCaptionContainer();
    if (!captionRoot) {
      return;
    }
    captionRoot.classList.remove("ai-translator-native-hidden");
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
    wrapper.style.flexDirection = "column";
    wrapper.style.alignItems = "center";
    wrapper.style.gap = "4px";
    wrapper.style.marginTop = "0";
    wrapper.style.pointerEvents = "auto";
    wrapper.style.position = "absolute";
    // Only set initial top/left on first creation; positionWrapper() manages them afterwards.
    if (!wrapper.isConnected) {
      wrapper.style.left = "12px";
      wrapper.style.top = "56px";
    }
    wrapper.style.bottom = "auto";
    wrapper.style.transform = "none";
    wrapper.style.zIndex = "2147483000";
    wrapper.style.transition = this.dragActive ? "none" : "top 0.15s ease-out";

    // Source line (resegmented original text, shown above translation for ASR).
    let srcLine =
      this.sourceLine &&
      this.sourceLine.isConnected &&
      this.sourceLine.parentElement === wrapper
        ? this.sourceLine
        : wrapper.querySelector<HTMLDivElement>(".ai-translator-yt-source-line");

    if (!srcLine) {
      srcLine = document.createElement("div");
      srcLine.className = "ai-translator-yt-source-line";
      wrapper.appendChild(srcLine);
    }

    srcLine.style.color = "#ffffff";
    srcLine.style.fontSize = "18px";
    srcLine.style.fontWeight = "400";
    srcLine.style.lineHeight = "1.35";
    srcLine.style.textAlign = "center";
    srcLine.style.padding = "4px 14px";
    srcLine.style.borderRadius = "6px";
    srcLine.style.background = "rgba(0, 0, 0, 0.55)";
    srcLine.style.display = "none";
    srcLine.style.maxWidth = "88%";
    srcLine.style.whiteSpace = "nowrap";
    srcLine.style.overflow = "hidden";
    srcLine.style.textOverflow = "ellipsis";
    srcLine.style.textShadow = "0 1px 2px rgba(0, 0, 0, 0.85)";
    srcLine.style.boxSizing = "border-box";

    // Translation line.
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

    // Ensure source line comes before translation line in DOM order.
    if (srcLine.nextSibling !== line) {
      wrapper.insertBefore(srcLine, line);
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

    this.sourceLine = srcLine;
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

    // When source text is shown, native captions are hidden; skip segment tracking.
    if (captionRoot && hasNativeCaption && !this.latestSource) {
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

    const POSITION_THRESHOLD = 10;
    const shouldUpdateTop =
      this.dragActive ||
      this.lastAppliedTop === null ||
      Math.abs(clampedTop - this.lastAppliedTop) >= POSITION_THRESHOLD;

    this.translatedWrapper.style.left = `${Math.round(clampedLeft)}px`;
    if (shouldUpdateTop) {
      this.translatedWrapper.style.top = `${Math.round(clampedTop)}px`;
      this.lastAppliedTop = clampedTop;
    }
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
    if (this.translatedWrapper) {
      this.translatedWrapper.style.transition = "none";
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
    if (this.translatedWrapper) {
      this.translatedWrapper.style.transition = "top 0.15s ease-out";
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
    this.restoreNativeCaptions();
    this.translatedWrapper?.remove();
    this.translatedWrapper = null;
    this.translatedLine = null;
    this.sourceLine = null;
    this.lastAppliedTop = null;
  }
}
