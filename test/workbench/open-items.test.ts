import { describe, expect, it } from "vitest";
import { parse as corpusRefParse } from "@/corpus/refs";
import {
  activeItem,
  closeItem,
  emptyOpenItems,
  findSectionIndex,
  fromPersisted,
  type OpenItem,
  openItem,
  openItemWithoutSwitching,
  setActiveIndex,
  toPersisted,
  validateAgainstCorpus,
} from "@/workbench";

const refA = corpusRefParse({ module: "sf-port", section: "1.1" });
const refB = corpusRefParse({ module: "sf-port", section: "1.2" });
const refC = corpusRefParse({ module: "sf-fire", section: "101" });

describe("openItem (append + activate, dedupe by ref)", () => {
  it("appends a new ref and activates it", () => {
    const s1 = openItem(emptyOpenItems(), refA);
    expect(s1.items).toHaveLength(1);
    expect(s1.activeIndex).toBe(0);
    const s2 = openItem(s1, refB);
    expect(s2.items).toHaveLength(2);
    expect(s2.activeIndex).toBe(1);
  });

  it("activates an existing ref instead of duplicating", () => {
    const s1 = openItem(openItem(openItem(emptyOpenItems(), refA), refB), refC);
    expect(s1.items).toHaveLength(3);
    expect(s1.activeIndex).toBe(2);
    const s2 = openItem(s1, refA);
    expect(s2.items).toHaveLength(3);
    expect(s2.activeIndex).toBe(0);
  });

  it("returns the same state when re-opening the already-active ref", () => {
    const s1 = openItem(emptyOpenItems(), refA);
    const s2 = openItem(s1, refA);
    expect(s2).toBe(s1);
  });
});

describe("openItemWithoutSwitching (append, leave activeIndex)", () => {
  it("appends without changing activeIndex", () => {
    const s1 = openItem(emptyOpenItems(), refA); // activeIndex=0
    const s2 = openItemWithoutSwitching(s1, refB);
    expect(s2.items).toHaveLength(2);
    expect(s2.activeIndex).toBe(0);
  });

  it("is a no-op when the ref already exists", () => {
    const s1 = openItem(emptyOpenItems(), refA);
    const s2 = openItemWithoutSwitching(s1, refA);
    expect(s2).toBe(s1);
  });

  it("leaves activeIndex null when starting from empty", () => {
    const s = openItemWithoutSwitching(emptyOpenItems(), refA);
    expect(s.items).toHaveLength(1);
    expect(s.activeIndex).toBeNull();
  });
});

describe("closeItem (right-then-left fall-back)", () => {
  function buildState(active: number | null): ReturnType<typeof emptyOpenItems> {
    let s = openItem(openItem(openItem(emptyOpenItems(), refA), refB), refC);
    s = setActiveIndex(s, active);
    return s;
  }

  it("close active middle item → activeIndex stays at same numeric index (right neighbor)", () => {
    const s = buildState(1); // [A, B*, C]
    const after = closeItem(s, 1); // [A, C], C is now at index 1
    expect(after.items.map((i) => (i.kind === "section" ? i.ref.section : i.kind))).toEqual([
      "1.1",
      "101",
    ]);
    expect(after.activeIndex).toBe(1);
  });

  it("close active last item → activeIndex falls back to left neighbor", () => {
    const s = buildState(2); // [A, B, C*]
    const after = closeItem(s, 2);
    expect(after.items).toHaveLength(2);
    expect(after.activeIndex).toBe(1);
  });

  it("close last remaining item → activeIndex null", () => {
    const s = openItem(emptyOpenItems(), refA);
    const after = closeItem(s, 0);
    expect(after.items).toEqual([]);
    expect(after.activeIndex).toBeNull();
  });

  it("close non-active item below active → activeIndex shifts down", () => {
    const s = buildState(2); // [A, B, C*]
    const after = closeItem(s, 0); // [B, C], C at index 1
    expect(after.activeIndex).toBe(1);
  });

  it("close non-active item above active → activeIndex unchanged", () => {
    const s = buildState(0); // [A*, B, C]
    const after = closeItem(s, 2); // [A, B], A at index 0
    expect(after.activeIndex).toBe(0);
  });

  it("invalid index → state unchanged", () => {
    const s = buildState(0);
    expect(closeItem(s, -1)).toBe(s);
    expect(closeItem(s, 99)).toBe(s);
  });
});

describe("setActiveIndex", () => {
  it("returns the same reference when no change", () => {
    const s = openItem(emptyOpenItems(), refA);
    expect(setActiveIndex(s, 0)).toBe(s);
  });

  it("ignores out-of-range indices", () => {
    const s = openItem(emptyOpenItems(), refA);
    expect(setActiveIndex(s, 5)).toBe(s);
    expect(setActiveIndex(s, -1)).toBe(s);
  });

  it("nulls out the active index", () => {
    const s = openItem(emptyOpenItems(), refA);
    const after = setActiveIndex(s, null);
    expect(after.activeIndex).toBeNull();
  });
});

describe("validateAgainstCorpus (drop vanished refs)", () => {
  it("drops a single vanished ref and remaps activeIndex", () => {
    const s = openItem(openItem(openItem(emptyOpenItems(), refA), refB), refC);
    const after = validateAgainstCorpus(s, (ref) => ref.section !== "1.2");
    expect(after.items).toHaveLength(2);
    expect(after.items[0]?.kind).toBe("section");
    if (after.items[0]?.kind === "section") expect(after.items[0].ref.section).toBe("1.1");
    if (after.items[1]?.kind === "section") expect(after.items[1].ref.section).toBe("101");
    // refC was at index 2; with refB removed, it's now at index 1.
    expect(after.activeIndex).toBe(1);
  });

  it("activeIndex → null when the active ref is dropped", () => {
    const s = openItem(emptyOpenItems(), refA);
    const after = validateAgainstCorpus(s, () => false);
    expect(after.items).toEqual([]);
    expect(after.activeIndex).toBeNull();
  });

  it("returns the same reference when nothing is dropped", () => {
    const s = openItem(openItem(emptyOpenItems(), refA), refB);
    expect(validateAgainstCorpus(s, () => true)).toBe(s);
  });
});

describe("kind discriminator", () => {
  it("a chat item coexists alongside section items", () => {
    const sections = openItem(openItem(emptyOpenItems(), refA), refB);
    const chatItem: OpenItem = { kind: "chat", chatId: "thread-1" };
    const mixed = {
      items: [sections.items[0], chatItem, sections.items[1]] as OpenItem[],
      activeIndex: 1,
    };
    expect(mixed.items.filter((i) => i.kind === "section")).toHaveLength(2);
    expect(mixed.items.filter((i) => i.kind === "chat")).toHaveLength(1);
  });

  it("findSectionIndex ignores non-section items when locating a ref", () => {
    const items: OpenItem[] = [
      { kind: "chat", chatId: "thread-1" },
      { kind: "section", ref: refA },
    ];
    expect(findSectionIndex(items, refA)).toBe(1);
  });

  it("validateAgainstCorpus passes through non-section items unchanged", () => {
    const items: OpenItem[] = [
      { kind: "section", ref: refA },
      { kind: "chat", chatId: "thread-1" },
      { kind: "section", ref: refB },
    ];
    const state = { items, activeIndex: 1 };
    const after = validateAgainstCorpus(state, () => true);
    expect(after.items).toEqual(items);
    expect(after.activeIndex).toBe(1);
  });
});

describe("activeItem", () => {
  it("returns the active item or null", () => {
    expect(activeItem(emptyOpenItems())).toBeNull();
    const s = openItem(emptyOpenItems(), refA);
    expect(activeItem(s)?.kind).toBe("section");
  });
});

describe("persistence interop", () => {
  it("toPersisted serializes a section-only state", () => {
    const s = openItem(openItem(emptyOpenItems(), refA), refB);
    const persisted = toPersisted(s);
    expect(persisted).toEqual({
      items: [
        { kind: "section", ref: { module: "sf-port", section: "1.1" } },
        { kind: "section", ref: { module: "sf-port", section: "1.2" } },
      ],
      activeIndex: 1,
    });
  });

  it("toPersisted drops chat items and remaps activeIndex", () => {
    const items: OpenItem[] = [
      { kind: "section", ref: refA },
      { kind: "chat", chatId: "thread-1" },
      { kind: "section", ref: refB },
    ];
    const persisted = toPersisted({ items, activeIndex: 2 });
    expect(persisted.items).toHaveLength(2);
    // refB was at index 2; with chat at index 1 dropped, refB lands at persisted index 1.
    expect(persisted.activeIndex).toBe(1);
  });

  it("toPersisted activeIndex → null when the active item is a chat that gets dropped", () => {
    const items: OpenItem[] = [
      { kind: "section", ref: refA },
      { kind: "chat", chatId: "thread-1" },
    ];
    const persisted = toPersisted({ items, activeIndex: 1 });
    expect(persisted.activeIndex).toBeNull();
  });

  it("fromPersisted hydrates and validates refs", () => {
    const state = fromPersisted({
      items: [
        { kind: "section", ref: { module: "sf-port", section: "1.1" } },
        { kind: "section", ref: { module: "sf-port", section: "1.2" } },
      ],
      activeIndex: 0,
    });
    expect(state.items).toHaveLength(2);
    expect(state.activeIndex).toBe(0);
    if (state.items[0]?.kind === "section") {
      expect(state.items[0].ref.section).toBe("1.1");
    }
  });

  it("fromPersisted drops refs that fail validation and remaps activeIndex", () => {
    const state = fromPersisted({
      items: [
        { kind: "section", ref: { module: "sf-port", section: "1.1" } },
        { kind: "section", ref: { module: "BAD MODULE", section: "1.2" } },
        { kind: "section", ref: { module: "sf-port", section: "1.3" } },
      ],
      activeIndex: 2,
    });
    expect(state.items).toHaveLength(2);
    expect(state.activeIndex).toBe(1);
  });

  it("fromPersisted with activeIndex pointing at a dropped item → null", () => {
    const state = fromPersisted({
      items: [{ kind: "section", ref: { module: "BAD", section: "1.1" } }],
      activeIndex: 0,
    });
    expect(state.items).toEqual([]);
    expect(state.activeIndex).toBeNull();
  });

  it("toPersisted ↔ fromPersisted round-trip for section-only state", () => {
    const original = openItem(openItem(openItem(emptyOpenItems(), refA), refB), refC);
    const round = fromPersisted(toPersisted(original));
    expect(round.items).toHaveLength(3);
    expect(round.activeIndex).toBe(2);
  });
});
