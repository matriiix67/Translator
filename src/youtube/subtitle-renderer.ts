export class SubtitleRenderer {
  private host: HTMLDivElement | null = null;

  private originalLine: HTMLDivElement | null = null;

  private translatedLine: HTMLDivElement | null = null;

  attach(): void {
    if (this.host) {
      return;
    }
    const player = document.querySelector<HTMLElement>(".html5-video-player");
    if (!player) {
      return;
    }

    player.style.position = player.style.position || "relative";
    const host = document.createElement("div");
    host.className = "ai-translator-yt-subtitles";
    host.style.position = "absolute";
    host.style.left = "50%";
    host.style.bottom = "14%";
    host.style.transform = "translateX(-50%)";
    host.style.width = "82%";
    host.style.maxWidth = "1100px";
    host.style.textAlign = "center";
    host.style.pointerEvents = "none";
    host.style.zIndex = "2147483000";
    host.style.display = "none";
    host.style.textShadow = "0 1px 2px rgba(0, 0, 0, 0.75)";

    const original = document.createElement("div");
    original.style.color = "#ffffff";
    original.style.fontSize = "24px";
    original.style.fontWeight = "600";
    original.style.lineHeight = "1.4";

    const translated = document.createElement("div");
    translated.style.marginTop = "6px";
    translated.style.color = "#8fd2ff";
    translated.style.fontSize = "21px";
    translated.style.fontWeight = "500";
    translated.style.lineHeight = "1.4";

    host.appendChild(original);
    host.appendChild(translated);
    player.appendChild(host);

    this.host = host;
    this.originalLine = original;
    this.translatedLine = translated;
  }

  setLines(original: string, translated: string): void {
    this.attach();
    if (!this.host || !this.originalLine || !this.translatedLine) {
      return;
    }

    this.host.style.display = "block";
    this.originalLine.textContent = original;
    this.translatedLine.textContent = translated;
  }

  hide(): void {
    if (!this.host) {
      return;
    }
    this.host.style.display = "none";
  }

  destroy(): void {
    this.host?.remove();
    this.host = null;
    this.originalLine = null;
    this.translatedLine = null;
  }
}
