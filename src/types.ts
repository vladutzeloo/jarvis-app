// Shared types used across feature modules.

export type BackendId = "ollama" | "nvidia";

export interface Message {
  role: "user" | "assistant";
  content: string;
}

export interface IndexedDoc {
  path: string;
  rel: string;
  content: string;
}

export interface SearchHit {
  doc: IndexedDoc;
  snippet: string;
  matchPos: number;
}

export interface ResearchResult {
  searchTerms: string[];
  notes: { rel: string; excerpt: string }[];
  outline: string;
  fastModel: string;
}

export interface JarvisSettings {
  systemPrompt: string;
  temperature: number;
  topP: number;
  topK: number;
  repeatPenalty: number;
  numCtx: number;
  numPredict: number;
  preset: "focused" | "balanced" | "creative" | "custom";
}

// Use 127.0.0.1 (not "localhost") to force IPv4. On Windows 11 "localhost"
// resolves IPv6-first (::1), but Ollama / Piper in WSL only bind IPv4 - that
// mismatch shows up as net::ERR_CONNECTION_REFUSED in the webview even when
// curl works.
export const OLLAMA_BASE = "http://127.0.0.1:11434";
export const PIPER_BASE = "http://127.0.0.1:5500";
