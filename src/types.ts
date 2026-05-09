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

export const OLLAMA_BASE = "http://localhost:11434";
export const PIPER_BASE = "http://localhost:5500";
