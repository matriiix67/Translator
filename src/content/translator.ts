import { DEFAULT_TRANSLATION_CONCURRENCY } from "@shared/constants";
import {
  createRequestId,
  createTranslationPort,
  onPortMessage,
  postStartTranslation
} from "@shared/messaging";
import { getSitePreference, getUserConfig, toSiteKey } from "@shared/storage";
import type {
  PageTranslationStatus,
  TranslationPortOutgoingMessage,
  TranslationStyle
} from "@shared/types";
import { RootMutationObserver } from "@content/observer";
import { mountTranslationAfter, type TranslationMount } from "@content/shadow-dom";

type StatusListener = (status: PageTranslationStatus) => void;

interface InflightRequest {
  element: HTMLElement;
  mount: TranslationMount;
}

const BLOCK_TRANSLATABLE_SELECTOR = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "li",
  "td",
  "th",
  "blockquote",
  "figcaption"
].join(",");

const TRANSLATABLE_SELECTOR = `${BLOCK_TRANSLATABLE_SELECTOR},span`;

const EXCLUDED_SELECTOR = [
  "script",
  "style",
  "noscript",
  "pre",
  "code",
  "textarea",
  "input",
  "button",
  "select",
  "option",
  "svg",
  "math"
].join(",");

function normalizeText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function isLikelyEnglish(text: string): boolean {
  const letters = (text.match(/[A-Za-z]/g) ?? []).length;
  const chinese = (text.match(/[\u4e00-\u9fff]/g) ?? []).length;
  return letters >= 8 && letters > chinese;
}

function isElementVisible(element: HTMLElement): boolean {
  if (
    element.getAttribute("aria-hidden") === "true" ||
    Boolean(element.closest('[aria-hidden="true"]'))
  ) {
    return false;
  }
  const style = window.getComputedStyle(element);
  if (
    style.display === "none" ||
    style.visibility === "hidden" ||
    style.opacity === "0"
  ) {
    return false;
  }
  if (element.getClientRects().length === 0) {
    return false;
  }
  const rect = element.getBoundingClientRect();
  if (rect.width < 2 || rect.height < 2) {
    return false;
  }
  return true;
}

export function collectCandidates(root: ParentNode): HTMLElement[] {
  if (!("querySelectorAll" in root)) {
    return [];
  }

  const nodes = Array.from(
    root.querySelectorAll<HTMLElement>(TRANSLATABLE_SELECTOR)
  );
  return nodes.filter((element) => {
    if (!element.isConnected) {
      return false;
    }
    if (element.closest(".ai-translator-host")) {
      return false;
    }
    if (element.closest(EXCLUDED_SELECTOR)) {
      return false;
    }
    // 避免同一段文本被“块元素 + 内联 span”同时命中导致双重翻译。
    if (element.tagName === "SPAN") {
      if (Boolean(element.closest(BLOCK_TRANSLATABLE_SELECTOR))) {
        return false;
      }
      // 避免嵌套 span 链式命中，优先保留最外层可翻译片段。
      if (Boolean(element.parentElement?.closest("span"))) {
        return false;
      }
    }
    if (!isElementVisible(element)) {
      return false;
    }
    const text = normalizeText(element.innerText || element.textContent || "");
    if (text.length < 16) {
      return false;
    }
    if (!isLikelyEnglish(text)) {
      return false;
    }
    const nestedBlocks = element.querySelector(BLOCK_TRANSLATABLE_SELECTOR);
    if (nestedBlocks) {
      return false;
    }
    return true;
  });
}

export class PageTranslator {
  private readonly siteKey = toSiteKey(window.location.href);

  private enabled = false;

  private contextWindow = 3;

  private style: TranslationStyle = {
    fontSize: "0.92em",
    color: "#2c3e50",
    backgroundColor: "#f6f8ff",
    borderColor: "#b9c4f5"
  };

  private port: chrome.runtime.Port | null = null;

  private unsubscribePort: (() => void) | null = null;

  private mutationObserver = new RootMutationObserver((roots) => {
    const changed = this.pruneDetachedElements();
    for (const root of roots) {
      this.scan(root);
    }
    if (changed && roots.length === 0) {
      this.emitStatus();
    }
  });

  private intersectionObserver: IntersectionObserver | null = null;

  private readonly tracked = new Set<HTMLElement>();

  private readonly elementTexts = new Map<HTMLElement, string>();

  private readonly ordered = new Array<HTMLElement>();

  private readonly queue = new Array<HTMLElement>();

  private readonly queued = new Set<HTMLElement>();

  private readonly translated = new Set<HTMLElement>();

  private readonly mounts = new Map<HTMLElement, TranslationMount>();

  private readonly inflight = new Map<string, InflightRequest>();

  private lastError: string | undefined;

  constructor(private readonly onStatus: StatusListener) {}

  async initialize(): Promise<void> {
    const config = await getUserConfig();
    this.contextWindow = Math.max(1, config.contextWindow);
    this.style = config.translationStyle;

    const sitePreference = await getSitePreference(this.siteKey);
    this.enabled = sitePreference ? sitePreference.enabled : config.autoTranslate;
    this.connectPort();

    if (this.enabled) {
      this.startObservers();
    }
    this.emitStatus();
  }

  getStatus(): PageTranslationStatus {
    return {
      enabled: this.enabled,
      progress: {
        total: this.tracked.size,
        translated: this.translated.size,
        inflight: this.inflight.size,
        pending: this.queue.length
      },
      lastError: this.lastError
    };
  }

  async setEnabled(enabled: boolean): Promise<void> {
    this.enabled = enabled;
    this.lastError = undefined;
    if (enabled) {
      this.connectPort();
      this.startObservers();
      this.scan(document);
      this.processQueue();
    } else {
      this.stopObservers();
      this.queue.length = 0;
      this.queued.clear();
      this.clearMounts();
      this.translated.clear();
      this.inflight.clear();
      this.tracked.clear();
      this.elementTexts.clear();
      this.ordered.length = 0;
    }
    this.emitStatus();
  }

  dispose(): void {
    this.stopObservers();
    this.unsubscribePort?.();
    this.unsubscribePort = null;
    this.port?.disconnect();
    this.port = null;
    this.clearMounts();
    this.queue.length = 0;
    this.queued.clear();
    this.inflight.clear();
  }

  private connectPort(): void {
    if (this.port) {
      return;
    }

    const port = createTranslationPort("webpage");
    this.port = port;
    this.unsubscribePort = onPortMessage(port, (message) =>
      this.handlePortMessage(message)
    );

    port.onDisconnect.addListener(() => {
      this.unsubscribePort?.();
      this.unsubscribePort = null;
      this.port = null;

      if (this.enabled) {
        window.setTimeout(() => {
          this.connectPort();
          this.processQueue();
        }, 300);
      }
    });
  }

  private handlePortMessage(message: TranslationPortOutgoingMessage): void {
    if (message.type === "translate:chunk") {
      const request = this.inflight.get(message.payload.requestId);
      request?.mount.appendChunk(message.payload.chunk);
      return;
    }

    if (message.type === "translate:done") {
      const request = this.inflight.get(message.payload.requestId);
      if (!request) {
        return;
      }
      request.mount.setText(message.payload.translation);
      this.translated.add(request.element);
      this.inflight.delete(message.payload.requestId);
      this.emitStatus();
      this.processQueue();
      return;
    }

    if (message.type === "translate:error") {
      const request = this.inflight.get(message.payload.requestId);
      if (request) {
        request.mount.setError(message.payload.message);
        this.inflight.delete(message.payload.requestId);
      }
      this.lastError = message.payload.message;
      this.emitStatus();
      this.processQueue();
    }
  }

  private startObservers(): void {
    if (this.intersectionObserver) {
      return;
    }

    this.intersectionObserver = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            this.enqueue(entry.target as HTMLElement);
          }
        }
      },
      {
        rootMargin: "220px 0px"
      }
    );

    this.scan(document);
    this.mutationObserver.start();
  }

  private stopObservers(): void {
    this.mutationObserver.stop();
    if (this.intersectionObserver) {
      this.intersectionObserver.disconnect();
      this.intersectionObserver = null;
    }
  }

  private scan(root: ParentNode): void {
    if (!this.enabled || !this.intersectionObserver) {
      return;
    }
    this.pruneDetachedElements();
    const candidates = collectCandidates(root);
    for (const element of candidates) {
      if (this.tracked.has(element)) {
        continue;
      }
      const text = normalizeText(element.innerText || element.textContent || "");
      if (this.hasTrackedSiblingDuplicate(element, text)) {
        continue;
      }
      this.tracked.add(element);
      this.elementTexts.set(element, text);
      this.ordered.push(element);
      this.intersectionObserver.observe(element);
    }
    this.emitStatus();
  }

  private enqueue(element: HTMLElement): void {
    if (!this.enabled) {
      return;
    }
    if (!this.tracked.has(element)) {
      return;
    }
    if (this.translated.has(element) || this.queued.has(element)) {
      return;
    }
    const text = this.elementTexts.get(element);
    if (text && this.hasActiveSiblingDuplicate(element, text)) {
      return;
    }
    const alreadyInflight = Array.from(this.inflight.values()).some(
      (item) => item.element === element
    );
    if (alreadyInflight) {
      return;
    }
    this.queue.push(element);
    this.queued.add(element);
    this.emitStatus();
    this.processQueue();
  }

  private processQueue(): void {
    if (!this.enabled) {
      return;
    }
    this.pruneDetachedElements();
    if (!this.port) {
      return;
    }

    while (
      this.inflight.size < DEFAULT_TRANSLATION_CONCURRENCY &&
      this.queue.length > 0
    ) {
      const element = this.queue.shift();
      if (!element) {
        continue;
      }
      this.queued.delete(element);

      const text = this.elementTexts.get(element);
      if (!text) {
        continue;
      }

      const mount = this.mounts.get(element) ?? mountTranslationAfter(element, this.style);
      this.mounts.set(element, mount);
      mount.setLoading();

      const requestId = createRequestId("web");
      this.inflight.set(requestId, { element, mount });
      const { contextBefore, contextAfter } = this.getContext(element);

      postStartTranslation(this.port, {
        requestId,
        text,
        contextBefore,
        contextAfter,
        stream: true,
        metadata: {
          source: "webpage",
          url: window.location.href,
          siteKey: this.siteKey
        }
      });
    }

    this.emitStatus();
  }

  private pruneDetachedElements(): boolean {
    let changed = false;
    const detachedElements = new Set<HTMLElement>();

    const detachElementState = (element: HTMLElement): void => {
      this.tracked.delete(element);
      this.translated.delete(element);
      this.queued.delete(element);
      this.elementTexts.delete(element);
      const mount = this.mounts.get(element);
      if (mount) {
        mount.remove();
        this.mounts.delete(element);
      }
      detachedElements.add(element);
      changed = true;
    };

    for (const element of this.tracked) {
      if (!element.isConnected) {
        detachElementState(element);
      }
    }

    for (const [requestId, request] of this.inflight) {
      if (request.element.isConnected) {
        continue;
      }
      this.inflight.delete(requestId);
      if (!detachedElements.has(request.element)) {
        detachElementState(request.element);
      } else {
        changed = true;
      }
    }

    if (!changed) {
      return false;
    }

    const filteredOrdered = this.ordered.filter(
      (element) => element.isConnected && this.tracked.has(element)
    );
    this.ordered.splice(0, this.ordered.length, ...filteredOrdered);

    const filteredQueue = this.queue.filter(
      (element) => element.isConnected && this.tracked.has(element)
    );
    this.queue.splice(0, this.queue.length, ...filteredQueue);
    this.queued.clear();
    for (const element of this.queue) {
      this.queued.add(element);
    }

    return true;
  }

  private hasTrackedSiblingDuplicate(element: HTMLElement, text: string): boolean {
    const parent = element.parentElement;
    if (!parent) {
      return false;
    }
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === element) {
        continue;
      }
      if (!this.tracked.has(sibling) || !sibling.isConnected) {
        continue;
      }
      const siblingText =
        this.elementTexts.get(sibling) ??
        normalizeText(sibling.innerText || sibling.textContent || "");
      if (siblingText === text) {
        return true;
      }
    }
    return false;
  }

  private hasActiveSiblingDuplicate(element: HTMLElement, text: string): boolean {
    const parent = element.parentElement;
    if (!parent) {
      return false;
    }
    for (const sibling of Array.from(parent.children)) {
      if (!(sibling instanceof HTMLElement) || sibling === element) {
        continue;
      }
      if (!this.tracked.has(sibling) || !sibling.isConnected) {
        continue;
      }
      const siblingText = this.elementTexts.get(sibling);
      if (!siblingText || siblingText !== text) {
        continue;
      }
      if (this.translated.has(sibling) || this.queued.has(sibling)) {
        return true;
      }
      const siblingInflight = Array.from(this.inflight.values()).some(
        (item) => item.element === sibling
      );
      if (siblingInflight) {
        return true;
      }
    }
    return false;
  }

  private getContext(target: HTMLElement): {
    contextBefore: string[];
    contextAfter: string[];
  } {
    const index = this.ordered.indexOf(target);
    if (index < 0) {
      return { contextBefore: [], contextAfter: [] };
    }

    const contextBefore: string[] = [];
    const contextAfter: string[] = [];

    for (let i = index - 1; i >= 0 && contextBefore.length < this.contextWindow; i -= 1) {
      const text = this.elementTexts.get(this.ordered[i]);
      if (text) {
        contextBefore.unshift(text);
      }
    }

    for (
      let i = index + 1;
      i < this.ordered.length && contextAfter.length < this.contextWindow;
      i += 1
    ) {
      const text = this.elementTexts.get(this.ordered[i]);
      if (text) {
        contextAfter.push(text);
      }
    }

    return { contextBefore, contextAfter };
  }

  private clearMounts(): void {
    for (const mount of this.mounts.values()) {
      mount.remove();
    }
    this.mounts.clear();
  }

  private emitStatus(): void {
    this.onStatus(this.getStatus());
  }
}
