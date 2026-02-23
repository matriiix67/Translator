import { describe, expect, test } from "vitest";

import { toSiteKey } from "../src/shared/storage";

describe("toSiteKey", () => {
  test("extracts hostname from URL", () => {
    expect(toSiteKey("https://news.ycombinator.com/item?id=1")).toBe(
      "news.ycombinator.com"
    );
  });

  test("returns raw value when URL invalid", () => {
    expect(toSiteKey("not-a-url")).toBe("not-a-url");
  });
});
