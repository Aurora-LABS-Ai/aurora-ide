import { describe, expect, it } from "vitest";

import { addressTitle, normalizeAddress, userBrowserLabel } from "./browser-tabs";

describe("normalizeAddress", () => {
  it("keeps a full address as typed", () => {
    expect(normalizeAddress("https://docs.stripe.com/webhooks")).toBe(
      "https://docs.stripe.com/webhooks",
    );
    expect(normalizeAddress("about:blank")).toBe("about:blank");
  });

  it("sends a local server over plain http, not https", () => {
    expect(normalizeAddress("localhost:5173")).toBe("http://localhost:5173");
    expect(normalizeAddress("127.0.0.1:8000/admin")).toBe("http://127.0.0.1:8000/admin");
  });

  it("treats a bare domain as a site and anything else as a search", () => {
    expect(normalizeAddress("kick.com")).toBe("https://kick.com");
    expect(normalizeAddress("tauri webview bounds")).toBe(
      "https://www.google.com/search?q=tauri%20webview%20bounds",
    );
  });
});

describe("addressTitle", () => {
  it("names a tab by host, keeping the port", () => {
    expect(addressTitle("http://localhost:5173/")).toBe("localhost:5173");
    expect(addressTitle("https://docs.stripe.com/webhooks")).toBe("docs.stripe.com");
  });

  it("falls back to the raw text when it is not an address", () => {
    expect(addressTitle("not a url")).toBe("not a url");
  });
});

describe("userBrowserLabel", () => {
  it("satisfies Rust's label rule and never repeats", () => {
    const a = userBrowserLabel();
    const b = userBrowserLabel();
    expect(a).toMatch(/^browser-[A-Za-z0-9_-]+$/);
    expect(a).not.toBe(b);
    expect(a).not.toBe("browser-agentwin");
  });
});
