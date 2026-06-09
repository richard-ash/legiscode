// Tool router. Dispatches a single tool_use block from the model — `read`
// or `search` — to the matching handler, validates inputs with zod, and
// projects the payload onto the uniform `ToolResultBase` shape so every
// output carries `{ok, fetched, corpus_hash, turn_id}` per C2.
//
// Errors are data, not exceptions (C6). A zod failure becomes a
// `bad_input` ToolError. An unknown tool name becomes the same. A handler
// throw becomes `internal`. The conversation loop wraps the final
// stringified output in <corpus_evidence> tags and feeds it back as a
// tool_result block.

import type { AiCorpusHandle } from "../corpus-loader";
import { runRead } from "./tools/read";
import { runSearch } from "./tools/search";
import {
  isToolName,
  ReadInputSchema,
  SearchInputSchema,
  type ToolError,
  type ToolName,
  type ToolResultBase,
} from "./tools/types";

export interface RouterContext {
  readonly corpus: AiCorpusHandle;
  readonly turnId: number;
}

export interface RouterResult {
  /** The tool_use_id from the model — echoed back as the tool_result key. */
  toolUseId: string;
  /** Tool-specific payload + ToolResultBase fields. */
  payload: ToolResultBase;
}

export interface RouterRequest {
  toolUseId: string;
  name: string;
  input: unknown;
}

/**
 * Dispatch one tool_use. Returns a `RouterResult` whose `payload` always
 * has `ok` + `fetched` + `corpus_hash` + `turn_id`. The conversation
 * loop calls this once per tool_use block in a model response.
 */
export async function dispatchTool(req: RouterRequest, ctx: RouterContext): Promise<RouterResult> {
  if (!isToolName(req.name)) {
    return {
      toolUseId: req.toolUseId,
      payload: badInput(`Unknown tool: ${req.name}`, ctx),
    };
  }
  try {
    const payload = await runOne(req.name, req.input, ctx);
    return { toolUseId: req.toolUseId, payload };
  } catch (cause) {
    return {
      toolUseId: req.toolUseId,
      payload: internalError(describe(cause), ctx),
    };
  }
}

async function runOne(
  name: ToolName,
  rawInput: unknown,
  ctx: RouterContext,
): Promise<ToolResultBase> {
  switch (name) {
    case "read": {
      const parsed = ReadInputSchema.safeParse(rawInput);
      if (!parsed.success) return badInput(zodSummary(parsed.error.issues), ctx);
      return runRead(parsed.data, ctx);
    }
    case "search": {
      const parsed = SearchInputSchema.safeParse(rawInput);
      if (!parsed.success) return badInput(zodSummary(parsed.error.issues), ctx);
      return runSearch(parsed.data, ctx);
    }
  }
}

function badInput(detail: string, ctx: RouterContext): ToolError {
  return {
    ok: false,
    reason: "bad_input",
    detail,
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function internalError(detail: string, ctx: RouterContext): ToolError {
  return {
    ok: false,
    reason: "internal",
    detail,
    fetched: [],
    corpus_hash: ctx.corpus.corpusHash,
    turn_id: ctx.turnId,
  };
}

function zodSummary(issues: readonly { path: readonly PropertyKey[]; message: string }[]): string {
  return issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}

function describe(cause: unknown): string {
  if (cause instanceof Error) return cause.message;
  return typeof cause === "string" ? cause : JSON.stringify(cause);
}

/**
 * Build the <corpus_evidence>-wrapped string body the conversation loop
 * sends back as the tool_result block content. The wrap defends against
 * statutory-text-as-injection (N1): poisoned section text can't be
 * mistaken for system instructions because everything between the tags
 * is data.
 */
export function serializeToolResult(result: ToolResultBase): string {
  const body = JSON.stringify(result);
  return `<corpus_evidence>${body}</corpus_evidence>`;
}
