/**
 * Model routes — pure route handlers reading from model-store singleton.
 */

import { Hono } from "hono";
import type { OpenAIModel, OpenAIModelList } from "../types/openai.js";
import {
  getModelCatalog,
  getModelAliases,
  getModelInfo,
  getModelStoreDebug,
  type CodexModelInfo,
} from "../models/model-store.js";
import { triggerImmediateRefresh } from "../models/model-fetcher.js";
import { getConfig } from "../config.js";
import type { ApiKeyPool } from "../auth/api-key-pool.js";

// --- Routes ---

/** Stable timestamp used for all model `created` fields (2023-11-14T22:13:20Z). */
const MODEL_CREATED_TIMESTAMP = 1700000000;
const CODEX_REASONING_EFFORTS = new Set(["none", "minimal", "low", "medium", "high", "xhigh"]);
const CODEX_INPUT_MODALITIES = new Set(["text", "image"]);

interface CodexRemoteModel {
  slug: string;
  display_name: string;
  description: string | null;
  default_reasoning_level: string | null;
  supported_reasoning_levels: Array<{ effort: string; description: string }>;
  shell_type: "shell_command";
  visibility: "list";
  supported_in_api: boolean;
  priority: number;
  additional_speed_tiers: string[];
  availability_nux: null;
  upgrade: null;
  base_instructions: string;
  model_messages: null;
  supports_reasoning_summaries: boolean;
  default_reasoning_summary: "auto";
  support_verbosity: boolean;
  default_verbosity: null;
  apply_patch_tool_type: null;
  web_search_tool_type: "text";
  truncation_policy: { mode: "tokens"; limit: number };
  supports_parallel_tool_calls: boolean;
  supports_image_detail_original: boolean;
  context_window?: number;
  max_context_window?: number;
  max_output_tokens?: number;
  experimental_supported_tools: string[];
  input_modalities: string[];
  supports_search_tool: boolean;
}

type ModelsListResponse = OpenAIModelList & { models: CodexRemoteModel[] };

function toOpenAIModel(info: CodexModelInfo): OpenAIModel {
  return {
    id: info.id,
    object: "model",
    created: MODEL_CREATED_TIMESTAMP,
    owned_by: "openai",
  };
}

function toRuntimeOpenAIModel(id: string): OpenAIModel {
  return {
    id,
    object: "model",
    created: MODEL_CREATED_TIMESTAMP,
    owned_by: "openai",
  };
}

function normalizeReasoningEffort(value: string | undefined): string | null {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return CODEX_REASONING_EFFORTS.has(normalized) ? normalized : null;
}

function normalizeInputModalities(values: string[]): string[] {
  const modalities = values
    .map((value) => value.trim().toLowerCase())
    .filter((value) => CODEX_INPUT_MODALITIES.has(value));
  return modalities.length > 0 ? [...new Set(modalities)] : ["text"];
}

function toCodexRemoteModel(info: CodexModelInfo, priority: number): CodexRemoteModel {
  const supportedReasoningLevels = info.supportedReasoningEfforts
    .map((effort) => ({
      effort: normalizeReasoningEffort(effort.reasoningEffort),
      description: effort.description,
    }))
    .filter((effort): effort is { effort: string; description: string } => effort.effort !== null);
  if (supportedReasoningLevels.length === 0) {
    supportedReasoningLevels.push({ effort: "none", description: "No reasoning" });
  }
  const requestedDefault = normalizeReasoningEffort(info.defaultReasoningEffort);
  const defaultReasoningLevel = requestedDefault && supportedReasoningLevels.some((effort) => effort.effort === requestedDefault)
    ? requestedDefault
    : supportedReasoningLevels[0]?.effort ?? "none";
  const outputModalities = info.outputModalities ?? ["text"];
  const inputModalities = normalizeInputModalities(info.inputModalities);
  const contextWindow = info.contextWindow ?? info.maxContextWindow ?? 272000;

  return {
    slug: info.id,
    display_name: info.displayName || info.id,
    description: info.description || null,
    default_reasoning_level: defaultReasoningLevel,
    supported_reasoning_levels: supportedReasoningLevels,
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: outputModalities.includes("text"),
    priority,
    additional_speed_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: "",
    model_messages: null,
    supports_reasoning_summaries: false,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: contextWindow },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: inputModalities.includes("image"),
    context_window: contextWindow,
    max_context_window: info.maxContextWindow ?? info.contextWindow ?? contextWindow,
    max_output_tokens: info.maxOutputTokens,
    experimental_supported_tools: [],
    input_modalities: inputModalities,
    supports_search_tool: false,
  };
}

function toRuntimeCodexRemoteModel(id: string, priority: number): CodexRemoteModel {
  return {
    slug: id,
    display_name: id,
    description: null,
    default_reasoning_level: "none",
    supported_reasoning_levels: [{ effort: "none", description: "No reasoning" }],
    shell_type: "shell_command",
    visibility: "list",
    supported_in_api: true,
    priority,
    additional_speed_tiers: [],
    availability_nux: null,
    upgrade: null,
    base_instructions: "",
    model_messages: null,
    supports_reasoning_summaries: false,
    default_reasoning_summary: "auto",
    support_verbosity: false,
    default_verbosity: null,
    apply_patch_tool_type: null,
    web_search_tool_type: "text",
    truncation_policy: { mode: "tokens", limit: 272000 },
    supports_parallel_tool_calls: true,
    supports_image_detail_original: false,
    context_window: 272000,
    max_context_window: 272000,
    experimental_supported_tools: [],
    input_modalities: ["text"],
    supports_search_tool: false,
  };
}

export function createModelRoutes(apiKeyPool?: ApiKeyPool): Hono {
  const app = new Hono();

  app.get("/v1/models", (c) => {
    const catalog = getModelCatalog();
    const aliases = getModelAliases();
    const modelsById = new Map<string, OpenAIModel>();
    const codexModelsById = new Map<string, CodexRemoteModel>();
    const includeCodexModels = c.req.query("client_version") !== undefined;

    for (const [index, model] of catalog.entries()) {
      modelsById.set(model.id, toOpenAIModel(model));
      if (includeCodexModels) {
        const priority = model.isDefault ? 0 : index + 1;
        codexModelsById.set(model.id, toCodexRemoteModel(model, priority));
      }
    }
    for (const [index, alias] of Object.keys(aliases).entries()) {
      modelsById.set(alias, toRuntimeOpenAIModel(alias));
      if (includeCodexModels && !codexModelsById.has(alias)) {
        codexModelsById.set(alias, toRuntimeCodexRemoteModel(alias, catalog.length + index + 1));
      }
    }
    for (const [index, modelId] of (apiKeyPool?.getActiveModels() ?? []).entries()) {
      modelsById.set(modelId, toRuntimeOpenAIModel(modelId));
      if (includeCodexModels && !codexModelsById.has(modelId)) {
        codexModelsById.set(modelId, toRuntimeCodexRemoteModel(modelId, catalog.length + Object.keys(aliases).length + index + 1));
      }
    }

    const response: OpenAIModelList | ModelsListResponse = includeCodexModels
      ? {
          object: "list",
          data: [...modelsById.values()],
          models: [...codexModelsById.values()],
        }
      : { object: "list", data: [...modelsById.values()] };
    return c.json(response);
  });

  // Full catalog with reasoning efforts (for dashboard UI)
  // Must be before :modelId to avoid being matched as a model ID
  app.get("/v1/models/catalog", (c) => {
    // Default outputModalities to ["text"] for chat-family entries that don't
    // set it explicitly, matching the interface's documented default.
    return c.json(
      getModelCatalog().map((m) => ({
        ...m,
        outputModalities: m.outputModalities ?? ["text"],
      })),
    );
  });

  app.get("/v1/models/:modelId", (c) => {
    const modelId = c.req.param("modelId");
    const catalog = getModelCatalog();
    const aliases = getModelAliases();

    const info = catalog.find((m) => m.id === modelId);
    if (info) return c.json(toOpenAIModel(info));

    const resolved = aliases[modelId];
    if (resolved) {
      return c.json(toRuntimeOpenAIModel(modelId));
    }

    if (apiKeyPool?.hasActiveModel(modelId)) {
      return c.json(toRuntimeOpenAIModel(modelId));
    }

    c.status(404);
    return c.json({
      error: {
        message: `Model '${modelId}' not found`,
        type: "invalid_request_error",
        param: "model",
        code: "model_not_found",
      },
    });
  });

  // Extended endpoint: model details with reasoning efforts
  app.get("/v1/models/:modelId/info", (c) => {
    const modelId = c.req.param("modelId");
    const aliases = getModelAliases();
    const resolved = aliases[modelId] ?? modelId;
    const info = getModelInfo(resolved);
    if (!info) {
      c.status(404);
      return c.json({ error: `Model '${modelId}' not found` });
    }
    return c.json(info);
  });

  // Debug endpoint: model store internals
  app.get("/debug/models", (c) => {
    return c.json(getModelStoreDebug());
  });

  // Admin endpoint: trigger immediate model refresh
  app.post("/admin/refresh-models", (c) => {
    const config = getConfig();
    const configKey = config.server.proxy_api_key;
    if (configKey) {
      const authHeader = c.req.header("Authorization") ?? "";
      const token = authHeader.startsWith("Bearer ") ? authHeader.slice(7) : "";
      if (token !== configKey) {
        c.status(401);
        return c.json({ error: "Unauthorized" });
      }
    }
    triggerImmediateRefresh();
    return c.json({ ok: true, message: "Model refresh triggered" });
  });

  return app;
}
