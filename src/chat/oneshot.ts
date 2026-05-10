// One-shot streaming completion against the active chat backend.
//
// Lives next to chat.ts so any feature module (Vinted negotiator, Brain
// summariser, …) can ask the user's currently-selected model for a focused,
// stand-alone reply without touching the chat history. The user's sampling
// settings (temperature, top_p, …) are reused so the personality stays
// consistent.
//
// Routing mirrors chat.ts:
//   - "ollama" → POST /api/chat with stream:true, parse NDJSON
//   - "nvidia" → nvidiaChatStream() (Tauri-bridged SSE, key stays in Rust)

import { OLLAMA_BASE } from "../types";
import { getSettings, buildOllamaOptions } from "../settings/settings";
import { selectedBackend, getModelPicker } from "./models";
import { nvidiaChatStream } from "../backends/nvidia";
import { streamNdjson } from "./stream";

export interface OneshotOptions {
  systemPrompt: string;
  userPrompt: string;
  /** Override max output tokens (defaults to user's settings). */
  maxTokens?: number;
  /** Override temperature (defaults to user's settings). */
  temperature?: number;
  /** Called for every text delta as it streams in. */
  onDelta: (chunk: string) => void;
  /** Optional abort signal. Best-effort — Ollama path supports it. */
  signal?: AbortSignal;
}

export interface OneshotResult {
  text: string;
  backend: "ollama" | "nvidia";
  model: string;
  tokens: number;
  elapsedMs: number;
}

/** Stream a single completion through the user's active model. */
export async function streamCompletion(opts: OneshotOptions): Promise<OneshotResult> {
  const backend = selectedBackend();
  const picker = getModelPicker();
  const model = picker.value;
  if (!model) throw new Error("no model selected — pick one in the chat tab first");

  const settings = getSettings();
  const temperature = opts.temperature ?? settings.temperature;
  const messages = [
    { role: "system" as const, content: opts.systemPrompt },
    { role: "user" as const, content: opts.userPrompt },
  ];

  const startedAt = performance.now();
  let text = "";
  let tokens = 0;

  if (backend === "nvidia") {
    const summary = await nvidiaChatStream(
      {
        model,
        messages,
        temperature,
        top_p: settings.topP,
        max_tokens:
          opts.maxTokens ?? (settings.numPredict > 0 ? settings.numPredict : undefined),
      },
      (delta) => {
        text += delta;
        tokens++;
        opts.onDelta(delta);
      },
    );
    return {
      text,
      backend,
      model,
      tokens: summary.tokens > 0 ? summary.tokens : tokens,
      elapsedMs: performance.now() - startedAt,
    };
  }

  // Ollama path — same NDJSON streaming the chat tab uses.
  const ollamaOpts: Record<string, number> = { ...buildOllamaOptions(), temperature };
  if (opts.maxTokens != null && opts.maxTokens > 0) {
    ollamaOpts.num_predict = opts.maxTokens;
  }
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, messages, stream: true, options: ollamaOpts }),
    signal: opts.signal,
  });
  if (!res.ok || !res.body) throw new Error(`Ollama HTTP ${res.status}`);

  for await (const obj of streamNdjson(res.body.getReader())) {
    const chunk = obj.message?.content || "";
    if (chunk) {
      text += chunk;
      tokens++;
      opts.onDelta(chunk);
    }
    if (obj.done && obj.eval_count) {
      tokens = obj.eval_count;
    }
  }
  return { text, backend, model, tokens, elapsedMs: performance.now() - startedAt };
}
