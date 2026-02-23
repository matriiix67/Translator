/** @vitest-environment jsdom */

import { describe, expect, test, vi } from "vitest";

import { collectCandidates, PageTranslator } from "../src/content/translator";
import { mountTranslationAfter } from "../src/content/shadow-dom";

function markVisible(element: HTMLElement): void {
  Object.defineProperty(element, "getClientRects", {
    value: () => [{ width: 100, height: 20 }],
    configurable: true
  });
  Object.defineProperty(element, "getBoundingClientRect", {
    value: () => ({ width: 100, height: 20 }),
    configurable: true
  });
}

describe("collectCandidates", () => {
  test("does not double-pick paragraph and its inner span", () => {
    document.body.innerHTML = `
      <article>
        <p id="p1">
          <span id="s1">Every AI conversation starts the same way and keeps repeating.</span>
        </p>
      </article>
    `;

    const paragraph = document.getElementById("p1") as HTMLElement;
    const innerSpan = document.getElementById("s1") as HTMLElement;
    markVisible(paragraph);
    markVisible(innerSpan);

    const candidates = collectCandidates(document);
    const ids = candidates.map((element) => element.id);

    expect(ids).toContain("p1");
    expect(ids).not.toContain("s1");
  });

  test("keeps standalone span candidates", () => {
    document.body.innerHTML = `
      <div>
        <span id="standalone">Standalone translated caption should still be detected properly.</span>
      </div>
    `;

    const standalone = document.getElementById("standalone") as HTMLElement;
    markVisible(standalone);

    const candidates = collectCandidates(document);
    const ids = candidates.map((element) => element.id);

    expect(ids).toContain("standalone");
  });

  test("does not double-pick nested spans", () => {
    document.body.innerHTML = `
      <div>
        <span id="outer">
          Nested span candidate should only be translated once in complex UI trees.
          <span id="inner">Nested span candidate should only be translated once in complex UI trees.</span>
        </span>
      </div>
    `;

    const outer = document.getElementById("outer") as HTMLElement;
    const inner = document.getElementById("inner") as HTMLElement;
    markVisible(outer);
    markVisible(inner);

    const candidates = collectCandidates(document);
    const ids = candidates.map((element) => element.id);

    expect(ids).toContain("outer");
    expect(ids).not.toContain("inner");
  });

  test("ignores aria-hidden duplicated nodes", () => {
    document.body.innerHTML = `
      <section>
        <span id="visible">This visible sentence should be translated exactly once without hidden duplicates.</span>
        <span id="hidden" aria-hidden="true">This visible sentence should be translated exactly once without hidden duplicates.</span>
      </section>
    `;

    const visible = document.getElementById("visible") as HTMLElement;
    const hidden = document.getElementById("hidden") as HTMLElement;
    markVisible(visible);
    markVisible(hidden);

    const candidates = collectCandidates(document);
    const ids = candidates.map((element) => element.id);

    expect(ids).toContain("visible");
    expect(ids).not.toContain("hidden");
  });
});

describe("PageTranslator detached cleanup", () => {
  test("prunes detached elements and removes stale mounts", () => {
    const translator = new PageTranslator(() => void 0);

    const connected = document.createElement("p");
    connected.id = "connected";
    connected.textContent = "Connected paragraph should keep active translation tracking.";
    document.body.appendChild(connected);

    const detached = document.createElement("p");
    detached.id = "detached";
    detached.textContent = "Detached paragraph should be cleaned from translator state.";
    document.body.appendChild(detached);
    detached.remove();

    const remove = vi.fn();
    const fakeMount = {
      appendChunk: vi.fn(),
      setText: vi.fn(),
      setLoading: vi.fn(),
      setError: vi.fn(),
      remove
    };

    const internal = translator as unknown as {
      tracked: Set<HTMLElement>;
      translated: Set<HTMLElement>;
      queued: Set<HTMLElement>;
      queue: HTMLElement[];
      ordered: HTMLElement[];
      elementTexts: Map<HTMLElement, string>;
      mounts: Map<HTMLElement, { remove: () => void }>;
      inflight: Map<string, { element: HTMLElement; mount: { remove: () => void } }>;
      pruneDetachedElements: () => boolean;
    };

    internal.tracked.add(connected);
    internal.tracked.add(detached);
    internal.translated.add(detached);
    internal.queued.add(detached);
    internal.queue.push(detached);
    internal.ordered.push(connected, detached);
    internal.elementTexts.set(connected, connected.textContent ?? "");
    internal.elementTexts.set(detached, detached.textContent ?? "");
    internal.mounts.set(detached, fakeMount);
    internal.inflight.set("req-detached", { element: detached, mount: fakeMount });

    const changed = internal.pruneDetachedElements();

    expect(changed).toBe(true);
    expect(internal.tracked.has(detached)).toBe(false);
    expect(internal.translated.has(detached)).toBe(false);
    expect(internal.queued.has(detached)).toBe(false);
    expect(internal.elementTexts.has(detached)).toBe(false);
    expect(internal.mounts.has(detached)).toBe(false);
    expect(internal.inflight.size).toBe(0);
    expect(internal.queue).toEqual([]);
    expect(internal.ordered).toEqual([connected]);
    expect(remove).toHaveBeenCalledTimes(1);
  });
});

describe("PageTranslator duplicate text dedupe", () => {
  test("scan tracks only one nearby duplicate text element", () => {
    document.body.innerHTML = `
      <div id="root">
        <p id="dup1">Duplicate paragraph text should be translated only once in nearby siblings.</p>
        <p id="dup2">Duplicate paragraph text should be translated only once in nearby siblings.</p>
      </div>
    `;

    const dup1 = document.getElementById("dup1") as HTMLElement;
    const dup2 = document.getElementById("dup2") as HTMLElement;
    markVisible(dup1);
    markVisible(dup2);

    const translator = new PageTranslator(() => void 0);
    const observe = vi.fn();

    const internal = translator as unknown as {
      enabled: boolean;
      intersectionObserver: { observe: (element: Element) => void };
      scan: (root: ParentNode) => void;
      tracked: Set<HTMLElement>;
    };

    internal.enabled = true;
    internal.intersectionObserver = { observe } as unknown as IntersectionObserver;
    internal.scan(document);

    expect(internal.tracked.has(dup1)).toBe(true);
    expect(internal.tracked.has(dup2)).toBe(false);
    expect(observe).toHaveBeenCalledTimes(1);
  });
});

describe("mountTranslationAfter", () => {
  test("removes stale sibling translation hosts before mounting", () => {
    document.body.innerHTML = `
      <article>
        <p id="target">This target should keep only one translation host.</p>
        <span class="ai-translator-host"></span>
        <span class="ai-translator-host"></span>
      </article>
    `;

    const target = document.getElementById("target") as HTMLElement;

    mountTranslationAfter(target, {
      fontSize: "0.92em",
      color: "#2c3e50",
      backgroundColor: "#f6f8ff",
      borderColor: "#b9c4f5"
    });

    const hosts: HTMLElement[] = [];
    let sibling = target.nextElementSibling as HTMLElement | null;
    while (sibling?.classList.contains("ai-translator-host")) {
      hosts.push(sibling);
      sibling = sibling.nextElementSibling as HTMLElement | null;
    }

    expect(hosts).toHaveLength(1);
  });
});
