// Canonical reference type for a corpus section. Every consumer that
// addresses "this section in this module" reaches through `CorpusRef`
// rather than ad-hoc `{ moduleId, sectionId }` literals. The opaque tag
// (`__corpusRefBrand`) prevents an arbitrary string-keyed object from
// satisfying the type — a `CorpusRef` can only originate from `parse()`,
// which validates against the `ModuleIdSchema`/`SectionIdSchema` regexes.
//
// Future extension fields (deferred until each consumer needs them — see
// TODOS.md "CorpusRef extension fields") MUST be additive optional fields
// on this same interface; do not work around it with a sibling wrapper
// type when extending. Candidate fields: `version` for citation-resolution
// pinning, `anchor` for sub-section addressing, `revision` for compare.
//
// Wire shape (`{ moduleId, sectionId }`) is the IPC payload format,
// declared in `@/corpus/wire`. The boundary helper `corpusRefFromWire()`
// is the only sanctioned construction path on the renderer side besides
// `parse()`. Putting refs.ts (with zod) in the preload graph is forbidden
// — see test/baseline.test.ts for the gate that enforces it.

import { type ModuleId, ModuleIdSchema, type SectionId, SectionIdSchema } from "@/types";

declare const __corpusRefBrand: unique symbol;

export interface CorpusRef {
  readonly module: ModuleId;
  readonly section: SectionId;
  /** Phantom brand — `never` makes this property unassignable from any
   *  object literal, so the only way to obtain a `CorpusRef` is via
   *  `parse()` (which uses an internal cast). */
  readonly [__corpusRefBrand]: never;
}

export interface CorpusRefInput {
  module: string;
  section: string;
}

export class CorpusRefParseError extends Error {
  constructor(
    public readonly input: unknown,
    message: string,
  ) {
    super(message);
    this.name = "CorpusRefParseError";
  }
}

const SEPARATOR = "::";

/**
 * Construct a `CorpusRef` from an object or its serialized form. Throws
 * `CorpusRefParseError` on malformed input — call sites that read external
 * data (persistence, IPC payloads) wrap this in their own error handling
 * (persistence returns null + logs; IPC surfaces as a schema-validation
 * failure).
 */
export function parse(input: CorpusRefInput | string): CorpusRef {
  const obj = typeof input === "string" ? splitSerialized(input) : input;
  const moduleResult = ModuleIdSchema.safeParse(obj.module);
  if (!moduleResult.success) {
    throw new CorpusRefParseError(input, `invalid module id: ${moduleResult.error.message}`);
  }
  const sectionResult = SectionIdSchema.safeParse(obj.section);
  if (!sectionResult.success) {
    throw new CorpusRefParseError(input, `invalid section id: ${sectionResult.error.message}`);
  }
  return { module: moduleResult.data, section: sectionResult.data } as CorpusRef;
}

/**
 * Serialize a `CorpusRef` to a stable string form. Round-trips with
 * `parse()`. The separator (`::`) is chosen because it cannot appear in
 * either a `ModuleId` (kebab-case lowercase) or a `SectionId` (dotted /
 * dashed / underscored lowercase), so the split is unambiguous.
 */
export function serialize(ref: CorpusRef): string {
  return `${ref.module}${SEPARATOR}${ref.section}`;
}

/** Structural equality on the two payload fields. */
export function equals(a: CorpusRef, b: CorpusRef): boolean {
  return a.module === b.module && a.section === b.section;
}

/**
 * Stable string key suitable for `Map` / `Set` lookups. Identical to
 * `serialize()` today; kept as a separate symbol so future extension
 * fields can decide independently whether they affect identity (`equals`)
 * or only display (`serialize`).
 */
export function hash(ref: CorpusRef): string {
  return serialize(ref);
}

/**
 * Boundary helper for IPC payloads — converts the wire shape (declared in
 * `@/corpus/wire`) to a branded `CorpusRef`.
 */
export function corpusRefFromWire(wire: { moduleId: string; sectionId: string }): CorpusRef {
  return parse({ module: wire.moduleId, section: wire.sectionId });
}

/**
 * Inverse of `corpusRefFromWire` — produces the legacy wire shape for IPC
 * call sites that haven't yet been migrated to take `CorpusRef` directly.
 */
export function corpusRefToWire(ref: CorpusRef): { moduleId: string; sectionId: string } {
  return { moduleId: ref.module, sectionId: ref.section };
}

function splitSerialized(s: string): CorpusRefInput {
  const idx = s.indexOf(SEPARATOR);
  if (idx < 0) {
    throw new CorpusRefParseError(s, `serialized ref missing "${SEPARATOR}" separator`);
  }
  return { module: s.slice(0, idx), section: s.slice(idx + SEPARATOR.length) };
}
