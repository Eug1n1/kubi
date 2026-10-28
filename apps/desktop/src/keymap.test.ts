import { describe, expect, it } from "vitest";

import {
  DEFAULT_KEYMAP,
  KEYMAP_ROWS,
  bindingKeys,
  bindingOwner,
  defaultFor,
  eventToBinding,
  isTypedKey,
  matchesBinding,
  parseKeymap,
  sameBinding,
} from "./keymap";

const press = (key: string, modifiers: Partial<{ ctrl: boolean; meta: boolean; alt: boolean; shift: boolean }> = {}) => ({
  key,
  ctrlKey: modifiers.ctrl === true,
  metaKey: modifiers.meta === true,
  altKey: modifiers.alt === true,
  shiftKey: modifiers.shift === true,
});

describe("the shipped keymap", () => {
  it("gives every rebindable action a default", () => {
    for (const row of KEYMAP_ROWS) expect(DEFAULT_KEYMAP[row.id]).toBeDefined();
  });

  it("binds Spotlight to Ctrl+A by default", () => {
    expect(bindingKeys(defaultFor("openSearch"))).toEqual(["Ctrl", "A"]);
  });
});

describe("parseKeymap", () => {
  it("returns the defaults for a missing, empty or broken file", () => {
    expect(parseKeymap(null)).toEqual(DEFAULT_KEYMAP);
    expect(parseKeymap("  ")).toEqual(DEFAULT_KEYMAP);
    expect(parseKeymap("{ broken")).toEqual(DEFAULT_KEYMAP);
    expect(parseKeymap(JSON.stringify({ version: 4 }))).toEqual(DEFAULT_KEYMAP);
  });

  it("reads a rebound action and keeps the others", () => {
    const keymap = parseKeymap(JSON.stringify({ keybindings: { openSearch: { key: "K", ctrl: true } } }));
    expect(keymap.openSearch).toEqual({ key: "k", ctrl: true, meta: false, alt: false, shift: false });
    expect(keymap.focusFilter).toEqual(DEFAULT_KEYMAP.focusFilter);
  });

  it("falls back per binding, not per file", () => {
    const keymap = parseKeymap(
      JSON.stringify({ keybindings: { openSearch: { key: "" }, focusFilter: "not a binding" } }),
    );
    expect(keymap.openSearch).toEqual(DEFAULT_KEYMAP.openSearch);
    expect(keymap.focusFilter).toEqual(DEFAULT_KEYMAP.focusFilter);
  });

  it("only accepts a real boolean as a modifier", () => {
    const keymap = parseKeymap(JSON.stringify({ keybindings: { openSearch: { key: "k", ctrl: "yes", shift: 1 } } }));
    expect(keymap.openSearch.ctrl).toBe(false);
    expect(keymap.openSearch.shift).toBe(false);
  });

  it("keeps a named key as it is and lowercases a typed one", () => {
    const keymap = parseKeymap(
      JSON.stringify({ keybindings: { openSearch: { key: "F5" }, focusFilter: { key: "J" } } }),
    );
    expect(keymap.openSearch.key).toBe("F5");
    expect(keymap.focusFilter.key).toBe("j");
  });
});

describe("eventToBinding", () => {
  it("reads a typed key and a named one", () => {
    expect(eventToBinding(press("A", { ctrl: true }))).toEqual({ key: "a", ctrl: true, meta: false, alt: false, shift: false });
    expect(eventToBinding(press("F5"))?.key).toBe("F5");
    expect(eventToBinding(press(" "))?.key).toBe(" ");
  });

  it("ignores a bare modifier, which is never a shortcut on its own", () => {
    expect(eventToBinding(press("Control", { ctrl: true }))).toBeNull();
    expect(eventToBinding(press("Meta", { meta: true }))).toBeNull();
    expect(eventToBinding(press("Dead"))).toBeNull();
    expect(eventToBinding(press(""))).toBeNull();
  });
});

describe("matchesBinding", () => {
  it("fires the default Spotlight shortcut and nothing looser", () => {
    expect(matchesBinding(press("a", { ctrl: true }), defaultFor("openSearch"))).toBe(true);
    expect(matchesBinding(press("a"), defaultFor("openSearch"))).toBe(false);
    expect(matchesBinding(press("a", { ctrl: true, shift: true }), defaultFor("openSearch"))).toBe(false);
  });

  it("does not fire while a bare modifier is held", () => {
    expect(matchesBinding(press("Control", { ctrl: true }), defaultFor("openSearch"))).toBe(false);
  });
});

describe("sameBinding", () => {
  it("ignores the case of the key", () => {
    expect(sameBinding(defaultFor("openSearch"), { ...defaultFor("openSearch"), key: "A" })).toBe(true);
    expect(sameBinding(defaultFor("openSearch"), { ...defaultFor("openSearch"), meta: true })).toBe(false);
  });
});

describe("bindingOwner", () => {
  it("names the action that already holds a binding", () => {
    const keymap = { ...DEFAULT_KEYMAP, focusFilter: { ...DEFAULT_KEYMAP.openSearch } };
    expect(bindingOwner(keymap, DEFAULT_KEYMAP.openSearch, "openSearch")?.id).toBe("focusFilter");
  });

  it("reports the action itself when it is not excluded", () => {
    expect(bindingOwner(DEFAULT_KEYMAP, DEFAULT_KEYMAP.openSearch)?.id).toBe("openSearch");
  });

  it("lets an action keep its own binding", () => {
    expect(bindingOwner(DEFAULT_KEYMAP, DEFAULT_KEYMAP.openSearch, "openSearch")).toBeNull();
  });

  it("reports nothing when the binding is free", () => {
    expect(bindingOwner(DEFAULT_KEYMAP, { key: "F9", ctrl: true, meta: false, alt: false, shift: false })).toBeNull();
  });
});

describe("bindingKeys", () => {
  it("draws the modifiers in a fixed order", () => {
    expect(bindingKeys({ key: "a", ctrl: true, meta: true, alt: true, shift: true })).toEqual(["Ctrl", "Cmd", "Alt", "Shift", "A"]);
  });

  it("names the keys a cap cannot show", () => {
    expect(bindingKeys({ key: " ", ctrl: false, meta: false, alt: false, shift: false })).toEqual(["Space"]);
    expect(bindingKeys({ key: "F5", ctrl: false, meta: false, alt: false, shift: false })).toEqual(["F5"]);
  });
});

describe("isTypedKey", () => {
  it("is true only when the shortcut would type text", () => {
    expect(isTypedKey(defaultFor("focusFilter"))).toBe(true);
    expect(isTypedKey(defaultFor("openSearch"))).toBe(false);
    expect(isTypedKey({ key: "a", ctrl: false, meta: false, alt: true, shift: false })).toBe(false);
  });
});
