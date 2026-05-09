// Frontend wrapper around the Rust commands that talk to NVIDIA's hosted
// inference API (build.nvidia.com). The API key lives in `.env` on the Rust
// side; this module never sees the key as a JS string.
//
// See `src-tauri/src/lib.rs` for the matching command surface.

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

export interface EnvSnapshot {
  path: string;
  has_nvidia_key: boolean;
  nvidia_api_base: string;
  nvidia_default_model: string;
}

export interface NvidiaModel {
  id: string;
  owned_by: string | null;
}

export interface NvidiaChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface NvidiaChatRequest {
  model: string;
  messages: NvidiaChatMessage[];
  temperature?: number;
  top_p?: number;
  max_tokens?: number;
}

export interface NvidiaChatStreamSummary {
  tokens: number;
  finish_reason: string | null;
}

type NvidiaStreamEvent =
  | { type: "delta"; content: string }
  | { type: "done"; tokens: number; finish_reason: string | null }
  | { type: "error"; message: string };

export async function readEnvSnapshot(): Promise<EnvSnapshot> {
  return await invoke<EnvSnapshot>("read_env_snapshot");
}

export async function writeEnvValue(key: string, value: string): Promise<string> {
  return await invoke<string>("write_env_value", { key, value });
}

export async function listNvidiaModels(): Promise<NvidiaModel[]> {
  return await invoke<NvidiaModel[]>("nvidia_list_models");
}

/**
 * Streams a chat completion from NVIDIA. `onDelta` fires for every token
 * fragment as it arrives; the returned promise resolves with the final
 * summary once the upstream stream terminates.
 *
 * `onError` is called for in-stream errors that the Rust side surfaces via
 * the event channel — those are also reflected as a rejected promise, so
 * callers can choose to handle either path.
 */
export async function nvidiaChatStream(
  request: NvidiaChatRequest,
  onDelta: (text: string) => void,
  onError?: (message: string) => void,
): Promise<NvidiaChatStreamSummary> {
  const eventName = `nvidia-chat-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

  let streamError: string | null = null;
  const unlisten = await listen<NvidiaStreamEvent>(eventName, (ev) => {
    const p = ev.payload;
    if (p.type === "delta") {
      onDelta(p.content);
    } else if (p.type === "error") {
      streamError = p.message;
      onError?.(p.message);
    }
    // "done" is implicit: the awaited invoke() will resolve.
  });

  try {
    const summary = await invoke<NvidiaChatStreamSummary>("nvidia_chat_stream", {
      request,
      eventName,
    });
    if (streamError) throw new Error(streamError);
    return summary;
  } finally {
    unlisten();
  }
}
