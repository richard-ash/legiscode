// @vitest-environment jsdom
import { renderHook, act } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useTypeahead } from "@/ui/left-panel/file-tree/use-typeahead";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("useTypeahead", () => {
  it("appendChar accumulates characters and returns the running buffer", () => {
    const { result } = renderHook(() => useTypeahead());
    let buffer = "";
    act(() => {
      buffer = result.current.appendChar("c");
    });
    expect(buffer).toBe("c");
    act(() => {
      buffer = result.current.appendChar("o");
    });
    expect(buffer).toBe("co");
    act(() => {
      buffer = result.current.appendChar("M");
    });
    expect(buffer).toBe("com");
  });

  it("clears the buffer after the timeout window", () => {
    const { result } = renderHook(() => useTypeahead(500));
    act(() => {
      result.current.appendChar("c");
    });
    act(() => {
      vi.advanceTimersByTime(501);
    });
    let next = "";
    act(() => {
      next = result.current.appendChar("o");
    });
    expect(next).toBe("o");
  });

  it("each appendChar resets the timeout window", () => {
    const { result } = renderHook(() => useTypeahead(500));
    act(() => {
      result.current.appendChar("c");
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    act(() => {
      result.current.appendChar("o");
    });
    act(() => {
      vi.advanceTimersByTime(400);
    });
    // We're at total 800ms but the second char restarted the timer at
    // 400ms, so we're 400ms into the new window — buffer should still hold "co".
    let next = "";
    act(() => {
      next = result.current.appendChar("m");
    });
    expect(next).toBe("com");
  });

  it("reset clears the buffer immediately", () => {
    const { result } = renderHook(() => useTypeahead());
    act(() => {
      result.current.appendChar("c");
      result.current.appendChar("o");
    });
    act(() => {
      result.current.reset();
    });
    let next = "";
    act(() => {
      next = result.current.appendChar("m");
    });
    expect(next).toBe("m");
  });
});
