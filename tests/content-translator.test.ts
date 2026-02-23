/** @vitest-environment jsdom */

import { describe, expect, test } from "vitest";

import { collectCandidates } from "../src/content/translator";

function markVisible(element: HTMLElement): void {
  Object.defineProperty(element, "getClientRects", {
    value: () => [{ width: 100, height: 20 }],
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
});
