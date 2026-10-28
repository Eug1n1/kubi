import { afterEach, describe, expect, it } from "vitest";

import { currentWindowLabel, ownerOfLabel, ownerSuffix, pinnedContext } from "./windows";

/** `pinnedContext` reads the window's URL, which node has no idea about. */
function withUrl(search: string): void {
  (globalThis as { window?: unknown }).window = { location: { search } };
}

afterEach(() => {
  delete (globalThis as { window?: unknown }).window;
});

describe("ownerSuffix", () => {
  it("leaves a main-window dock label bare", () => {
    expect(ownerSuffix("main")).toBe("");
  });

  it("addresses any other window after a colon", () => {
    expect(ownerSuffix("ctx-prod")).toBe(":ctx-prod");
  });
});

describe("ownerOfLabel", () => {
  it("reads a bare label as the main window's", () => {
    expect(ownerOfLabel("log-3")).toBe("main");
    expect(ownerOfLabel("ctx-prod")).toBe("main");
  });

  it("reads the window a dock label answers to", () => {
    expect(ownerOfLabel("log-3:ctx-prod")).toBe("ctx-prod");
    expect(ownerOfLabel("exec-1:ctx-kz-mgmt")).toBe("ctx-kz-mgmt");
  });
});

describe("currentWindowLabel", () => {
  it("falls back to the main window outside a Tauri webview", () => {
    expect(currentWindowLabel()).toBe("main");
  });
});

describe("pinnedContext", () => {
  it("reads the context out of the window's URL", () => {
    withUrl("?context=prod-eu");
    expect(pinnedContext()).toBe("prod-eu");
  });

  it("has no context in a window that is not pinned", () => {
    withUrl("");
    expect(pinnedContext()).toBeNull();
    withUrl("?context=");
    expect(pinnedContext()).toBeNull();
    withUrl("?context=%20");
    expect(pinnedContext()).toBeNull();
  });

  it("keeps a name the window label cannot hold", () => {
    withUrl(`?context=${encodeURIComponent("kz mgmt/1")}`);
    expect(pinnedContext()).toBe("kz mgmt/1");
  });
});
