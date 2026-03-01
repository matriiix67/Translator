export class SubtitleRenderer {
  private observer: MutationObserver | null = null;

  private syncScheduled = false;

  private nativeCaptionContainer: HTMLElement | null = null;

  private translatedWrapper: HTMLDivElement | null = null;

  private originalLine: HTMLDivElement | null = null;

  private translatedLine: HTMLDivElement | null = null;

  private latestTranslation = "";

  private latestOriginal: string | undefined;

  private dragActive = false;

  private dragStartX = 0;

  private dragStartY = 0;

  private dragOriginOffsetX = 0;

  private dragOriginOffsetY = 0;

  private dragLockedTop: number | null = null;

  private dragLockedLeft: number | null = null;

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

  setTranslation(translation: string, original?: string): void {
    this.latestTranslation = translation.trim();
    this.latestOriginal = original?.trim() || undefined;
    this.observeNativeCaptions();
    this.scheduleSync();
  }

  hide(): void {
    this.latestTranslation = "";
    this.latestOriginal = undefined;
    if (this.translatedWrapper) {
      this.translatedWrapper.style.display = "none";
    }
    this.restoreNativeCaptions();
  }

  private restoreNativeCaptions(): void {
    const captionRoot = this.findNativeCaptionContainer();
    if (!captionRoot) return;
    const windows = captionRoot.querySelectorAll<HTMLElement>(".caption-window");
    for (const win of windows) {
      win.style.opacity = "";
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

    // Use caller-provided original text if available, otherwise extract from native captions
    const originalText = this.latestOriginal ??
      (captionRoot ? this.extractNativeCaptionText(captionRoot) : "");
    const hasOriginal = Boolean(originalText);
    const hasTranslation = Boolean(this.latestTranslation);

    if (this.originalLine) {
      this.originalLine.textContent = originalText;
      this.originalLine.style.display = originalText ? "block" : "none";
    }
    this.translatedLine.textContent = this.latestTranslation;

    if (hasTranslation || hasOriginal) {
      this.translatedWrapper.style.display = "flex";
      if (captionRoot) {
        this.hideNativeCaptions(captionRoot);
      }
    }

    this.positionWrapper(playerHost, captionRoot, hasOriginal);
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

  private extractNativeCaptionText(container: HTMLElement): string {
    const segments = container.querySelectorAll<HTMLElement>(".ytp-caption-segment");
    const texts: string[] = [];
    for (const segment of segments) {
      const text = segment.textContent?.trim() ?? "";
      if (!text) continue;
      const style = window.getComputedStyle(segment);
      if (style.display !== "none" && style.visibility !== "hidden") {
        texts.push(text);
      }
    }
    return texts.join(" ");
  }

  private hideNativeCaptions(container: HTMLElement): void {
    const windows = container.querySelectorAll<HTMLElement>(".caption-window");
    for (const win of windows) {
      win.style.opacity = "0";
    }
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
    // Outer wrapper: centered like snowcc
    wrapper.style.textAlign = "center";
    wrapper.style.width = "fit-content";
    wrapper.style.maxWidth = "90%";
    wrapper.style.margin = "0 auto";
    wrapper.style.display = "none";
    wrapper.style.pointerEvents = "auto";
    wrapper.style.position = "absolute";
    wrapper.style.left = "0";
    wrapper.style.right = "0";
    wrapper.style.top = "56px";
    wrapper.style.bottom = "auto";
    wrapper.style.zIndex = "2147483000";
    wrapper.style.userSelect = "text";
    wrapper.style.transition = "bottom 50ms ease-in-out";

    // Inner content box (snowcc-body style)
    let contentBox =
      wrapper.querySelector<HTMLDivElement>(".ai-translator-yt-content-box");
    if (!contentBox) {
      contentBox = document.createElement("div");
      contentBox.className = "ai-translator-yt-content-box";
      wrapper.appendChild(contentBox);
    }

    contentBox.style.background = "rgba(0, 0, 0, 0.7)";
    contentBox.style.backdropFilter = "blur(10px)";
    contentBox.style.setProperty("-webkit-backdrop-filter", "blur(10px)");
    contentBox.style.borderRadius = "10px";
    contentBox.style.padding = "10px";
    contentBox.style.display = "inline-block";
    contentBox.style.maxWidth = "100%";
    contentBox.style.boxSizing = "border-box";
    contentBox.style.cursor = this.dragActive ? "grabbing" : "grab";
    contentBox.style.fontSize = "18px";
    contentBox.onmousedown = (event: MouseEvent) => this.startDrag(event);

    // Original text line (english-subtitle style)
    let origLine =
      this.originalLine &&
      this.originalLine.isConnected &&
      this.originalLine.parentElement === contentBox
        ? this.originalLine
        : contentBox.querySelector<HTMLDivElement>(".ai-translator-yt-original-line");

    if (!origLine) {
      origLine = document.createElement("div");
      origLine.className = "ai-translator-yt-original-line";
      contentBox.appendChild(origLine);
    }

    origLine.style.color = "#ffffff";
    origLine.style.fontSize = "20px";
    origLine.style.fontWeight = "400";
    origLine.style.lineHeight = "1.4";
    origLine.style.textAlign = "center";
    origLine.style.whiteSpace = "pre-wrap";
    origLine.style.wordBreak = "break-word";
    origLine.style.filter = "drop-shadow(1.41px 1.41px 3px rgba(0, 0, 0, 0.3))";
    origLine.style.marginBottom = "5px";

    // Translation line (chinese-subtitle style)
    let line =
      this.translatedLine &&
      this.translatedLine.isConnected &&
      this.translatedLine.parentElement === contentBox
        ? this.translatedLine
        : contentBox.querySelector<HTMLDivElement>(".ai-translator-yt-translation-line");

    if (!line) {
      line = document.createElement("div");
      line.className = "ai-translator-yt-translation-line";
      contentBox.appendChild(line);
    }

    line.style.color = "#ffffff";
    line.style.fontSize = "18px";
    line.style.fontWeight = "400";
    line.style.lineHeight = "1.4";
    line.style.textAlign = "center";
    line.style.whiteSpace = "pre-wrap";
    line.style.wordBreak = "break-word";
    line.style.filter = "drop-shadow(1.41px 1.41px 3px rgba(0, 0, 0, 0.3))";
    line.style.boxSizing = "border-box";

    this.originalLine = origLine;

    if (!wrapper.isConnected) {
      this.nativeCaptionContainer.appendChild(wrapper);
    }

    this.translatedWrapper = wrapper;
    this.translatedLine = line;
  }

  private positionWrapper(
    playerHost: HTMLElement,
    _captionRoot: HTMLElement | null,
    _hasNativeCaption: boolean
  ): void {
    if (!this.translatedWrapper) {
      return;
    }
    const playerRect = playerHost.getBoundingClientRect();
    const measuredWrapperHeight = this.translatedWrapper.getBoundingClientRect().height;
    const wrapperHeight = measuredWrapperHeight > 0 ? measuredWrapperHeight : 52;
    const minTop = 16;
    const maxTop = Math.max(minTop, playerRect.height - wrapperHeight - 16);

    // If user has dragged, use locked absolute position
    if (this.dragLockedTop !== null) {
      const clampedTop = Math.max(minTop, Math.min(maxTop, this.dragLockedTop));
      this.dragLockedTop = clampedTop;
      this.translatedWrapper.style.top = "auto";
      this.translatedWrapper.style.bottom = `${Math.round(playerRect.height - clampedTop - wrapperHeight)}px`;
      if (this.dragLockedLeft !== null) {
        this.translatedWrapper.style.left = `${Math.round(this.dragLockedLeft)}px`;
        this.translatedWrapper.style.right = "auto";
        this.translatedWrapper.style.margin = "0";
      }
      return;
    }

    // Position above the controls bar, like snowcc
    const SUBTITLE_BOTTOM_SPACING = 14;
    let bottomPx = SUBTITLE_BOTTOM_SPACING;
    const controls = playerHost.querySelector<HTMLElement>(".ytp-chrome-bottom");
    if (controls) {
      const controlsHeight = controls.offsetHeight > 0 ? controls.offsetHeight : 48;
      bottomPx = controlsHeight + SUBTITLE_BOTTOM_SPACING;
    }

    this.translatedWrapper.style.top = "auto";
    this.translatedWrapper.style.bottom = `${bottomPx}px`;
    this.translatedWrapper.style.left = "0";
    this.translatedWrapper.style.right = "0";
    this.translatedWrapper.style.margin = "0 auto";
  }

  private startDrag(event: MouseEvent): void {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    this.dragActive = true;
    this.dragStartX = event.clientX;
    this.dragStartY = event.clientY;
    // Capture current position as starting point
    if (this.translatedWrapper) {
      const rect = this.translatedWrapper.getBoundingClientRect();
      const playerHost = this.findPlayerContainer();
      if (playerHost) {
        const playerRect = playerHost.getBoundingClientRect();
        this.dragOriginOffsetX = rect.left - playerRect.left;
        this.dragOriginOffsetY = rect.top - playerRect.top;
      }
    }
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
    this.dragLockedLeft = this.dragOriginOffsetX + dx;
    this.dragLockedTop = this.dragOriginOffsetY + dy;
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
    this.originalLine = null;
    this.translatedLine = null;
  }
}
