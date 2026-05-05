// @vitest-environment jsdom
/// <reference lib="dom" />

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { getTheme, setTheme, subscribe, toggleTheme } from "../../src/app/theme";

beforeEach(() => {
  document.documentElement.className = "";
  localStorage.clear();
});

afterEach(() => {
  document.documentElement.className = "";
  localStorage.clear();
});

describe("theme", () => {
  it("defaults to dark when no class is applied", () => {
    expect(getTheme()).toBe("dark");
  });

  it("setTheme('light') applies the lc-light class on <html>", () => {
    setTheme("light");
    expect(document.documentElement.classList.contains("lc-light")).toBe(true);
    expect(getTheme()).toBe("light");
  });

  it("setTheme persists to localStorage", () => {
    setTheme("light");
    expect(localStorage.getItem("legiscode.theme")).toBe("light");
    setTheme("dark");
    expect(localStorage.getItem("legiscode.theme")).toBe("dark");
  });

  it("toggleTheme flips between dark and light", () => {
    expect(toggleTheme()).toBe("light");
    expect(getTheme()).toBe("light");
    expect(toggleTheme()).toBe("dark");
    expect(getTheme()).toBe("dark");
  });

  it("subscribers fire on every change", () => {
    const calls: string[] = [];
    const unsubscribe = subscribe((t) => calls.push(t));
    setTheme("light");
    setTheme("dark");
    expect(calls).toEqual(["light", "dark"]);
    unsubscribe();
    setTheme("light");
    expect(calls).toEqual(["light", "dark"]); // no further calls
  });
});
