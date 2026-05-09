// Frontend wrapper around the vault I/O commands in `src-tauri/src/lib.rs`.
// The vault path lives in `.env` on the Rust side; this module never touches it
// directly. Falls back to safe no-ops when the vault is not configured so the
// UI keeps working without a vault.

import { invoke } from "@tauri-apps/api/core";

export interface VaultStatus {
  configured: boolean;
  path: string | null;
}

export async function getVaultStatus(): Promise<VaultStatus> {
  try {
    return await invoke<VaultStatus>("get_vault_status");
  } catch {
    return { configured: false, path: null };
  }
}

/**
 * Reads a file from the vault. Returns null if the vault is not configured
 * or the file doesn't exist (so the UI degrades gracefully).
 */
export async function readVaultFile(relPath: string): Promise<string | null> {
  try {
    return await invoke<string>("read_vault_file", { relPath });
  } catch {
    return null;
  }
}

/**
 * Loads the Jarvis system prompt by combining identity + preferences files.
 * Falls back to a minimal default if the vault is unavailable.
 */
export async function loadSystemPrompt(): Promise<string> {
  const [about, prefs] = await Promise.all([
    readVaultFile("01_Identity/about.md"),
    readVaultFile("01_Identity/preferences.md"),
  ]);

  const parts = [about, prefs].filter((p): p is string => Boolean(p));
  if (parts.length === 0) {
    return "You are Jarvis, a helpful AI assistant.";
  }
  return parts.join("\n\n---\n\n");
}

/**
 * Writes a memory entry to 06_Memory/ in the vault.
 * filename format: YYYY-MM-DD_<slug>.md
 * Returns the absolute path of the saved file, or null on failure.
 */
export async function writeMemoryEntry(slug: string, content: string): Promise<string | null> {
  const today = new Date().toISOString().slice(0, 10);
  const safeSlug = slug.replace(/[^a-z0-9-]/gi, "-").toLowerCase() || "note";
  const filename = `${today}_${safeSlug}.md`;
  try {
    return await invoke<string>("write_memory_entry", { filename, content });
  } catch (e) {
    console.error("writeMemoryEntry failed:", e);
    return null;
  }
}
