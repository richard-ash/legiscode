// The barrel re-exports both runtime values (zod schemas + constants) and
// types. Under verbatimModuleSyntax, downstream consumers must import types
// with `import type { SectionFile }` and runtime values with
// `import { SectionFileSchema }`. See docs/GIT.md for repo conventions.

export * from "./appendix";
export * from "./citation";
export * from "./corpus-entry";
export * from "./corpus-meta";
export * from "./definitions";
export * from "./identifiers";
export * from "./legal-instrument-entry";
export * from "./manifest";
export * from "./ordinance";
export * from "./ordinance-history";
export * from "./parsed-module";
export * from "./resolution-history";
export * from "./section";
export * from "./source-location";
export * from "./text-diff";
