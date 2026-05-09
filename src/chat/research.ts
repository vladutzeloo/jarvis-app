// Research mode: a fast model picks search terms, hits the vault, and writes
// an outline that gets folded into the prompt sent to the (slower) main
// model. Toggle is wired here; `runResearch` is called from the chat send
// loop when the toggle is on.

import type { IndexedDoc, ResearchResult } from "../types";
import { OLLAMA_BASE } from "../types";
import { searchVault, getVaultPath, getVaultIndex, indexVault } from "../brain/brain";
import { getModelPicker } from "./models";

const STORAGE_RESEARCH = "jarvis.research.mode";
const researchToggle = document.getElementById("research-toggle") as HTMLButtonElement;

let researchMode = localStorage.getItem(STORAGE_RESEARCH) === "true";

export function getResearchMode(): boolean {
  return researchMode;
}

function refreshResearchUI() {
  if (researchMode) {
    researchToggle.classList.add("research-on");
    researchToggle.title = "Research mode ON — fast model researches first";
  } else {
    researchToggle.classList.remove("research-on");
    researchToggle.title = "Research mode OFF — direct query";
  }
}
refreshResearchUI();

researchToggle?.addEventListener("click", () => {
  researchMode = !researchMode;
  localStorage.setItem(STORAGE_RESEARCH, String(researchMode));
  refreshResearchUI();
});

async function pickResearchModel(): Promise<string> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    const data = await res.json();
    const names: string[] = (data.models || []).map((m: any) => m.name);
    const prefer = [
      "llama-4070:latest", "llama-4070",
      "qwen-coder-4070-fast:latest", "qwen-coder-4070-fast",
      "llama3.1:8b", "llama3.2:3b",
      "qwen2.5-coder:7b",
    ];
    for (const p of prefer) {
      if (names.includes(p)) return p;
    }
    const small = names.find(n => /:[37]b/i.test(n));
    return small || getModelPicker().value;
  } catch {
    return getModelPicker().value;
  }
}

async function callOllamaOnce(model: string, prompt: string, temperature = 0.3): Promise<string> {
  const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [{ role: "user", content: prompt }],
      stream: false,
      options: { temperature },
    }),
  });
  if (!res.ok) throw new Error(`fast model HTTP ${res.status}`);
  const data = await res.json();
  return (data.message?.content || "").trim();
}

export async function runResearch(query: string, status: (msg: string) => void): Promise<ResearchResult> {
  const fastModel = await pickResearchModel();
  status(`Picking research topics with ${fastModel}…`);

  const termsPrompt = `You are a research assistant. Extract 1-3 short search terms from the user's question that I should look up in their personal knowledge base. Return ONLY the terms, one per line, no commentary, no numbering.

Question: ${query}

Search terms:`;
  let termsRaw = "";
  try {
    termsRaw = await callOllamaOnce(fastModel, termsPrompt, 0.2);
  } catch (e: any) {
    status(`Term extraction failed: ${e.message}`);
  }
  const terms = termsRaw
    .split("\n")
    .map(s => s.trim().replace(/^[-*•\d.\)]+\s*/, "").replace(/^["']|["']$/g, ""))
    .filter(s => s.length > 1 && s.length < 80)
    .slice(0, 3);

  if (getVaultPath() && !getVaultIndex()) {
    try { await indexVault(); } catch {}
  }

  const collectedDocs = new Map<string, IndexedDoc>();
  for (const t of terms) {
    const hits = searchVault(t);
    for (const h of hits.slice(0, 2)) collectedDocs.set(h.doc.path, h.doc);
  }
  const notes = Array.from(collectedDocs.values()).map(d => ({
    rel: d.rel,
    excerpt: d.content.slice(0, 1500),
  }));

  status(`Found ${notes.length} note(s). Outlining the answer…`);

  const notesText = notes.length
    ? notes.map(n => `--- ${n.rel} ---\n${n.excerpt}`).join("\n\n")
    : "(no relevant notes found in vault)";

  const outlinePrompt = `You are a research assistant. The user asked: "${query}"

Here are excerpts from their personal knowledge base that may be relevant:
${notesText}

Based on the question and these notes, write a SHORT outline (3-5 bullet points) of what a good answer should cover. Be concise. Return only the bullets, no preamble.`;

  let outline = "";
  try {
    outline = await callOllamaOnce(fastModel, outlinePrompt, 0.3);
  } catch (e: any) {
    status(`Outline failed: ${e.message}`);
  }

  return { searchTerms: terms, notes, outline, fastModel };
}

export function buildAugmentedPrompt(query: string, r: ResearchResult): string {
  const notesBlock = r.notes.length
    ? `\n\nResearch notes from the user's knowledge base:\n${r.notes.map(n => `--- ${n.rel} ---\n${n.excerpt}`).join("\n\n")}`
    : "";
  const outlineBlock = r.outline ? `\n\nOutline (from research assistant):\n${r.outline}` : "";
  return `${query}${notesBlock}${outlineBlock}\n\nProvide a thorough, well-structured answer using the outline and notes above where relevant.`;
}
