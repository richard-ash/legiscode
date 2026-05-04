import type { ZodError } from "zod";

// Single error formatter for the entire codebase. Tests assert the offending
// field name appears in the error string; they do NOT depend on raw zod
// internal text. If zod's error format ever changes, fix it here once.
//
// Output shape: <path.to.field>: <reason>; <path.to.field2>: <reason2>
// Anonymous root errors (no path) get the synthetic key "<root>".
export function formatZodError(err: ZodError): string {
  return err.issues
    .map((issue) => {
      const path = issue.path.length > 0 ? issue.path.join(".") : "<root>";
      return `${path}: ${issue.message}`;
    })
    .join("; ");
}
