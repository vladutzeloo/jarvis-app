// Research mode: a fast model picks search terms, hits the vault AND (if
// TAVILY_API_KEY is configured) the web in parallel, then writes an outline
// that gets folded into the prompt sent to the (slower) main model. Toggles
// are wired here; `runResearch` is called from the chat send loop when
// research mode is on.

import type { IndexedDoc, ResearchResult, WebHit } from "../types";
import { OLLAMA_BASE } from "../types";
import { searchVault, getVaultPath, getVaultIndex, indexVault } from "../brain/brain";
import { getModelPicker } from "./models";
import { invoke } from "@tauri-apps/api/core";

const STORAGE_RESEARCH = "jarvis.research.mode";
const STORAGE_WEBSEARCH = "jarvis.websearch.mode";
const researchToggle = document.getElementById("research-toggle") as HTMLButtonElement;
const websearchToggle = document.getElementById("websearch-toggle") as HTMLButtonElement | null;

let researchMode = localStorage.getItem(STORAGE_RESEARCH) === "true";
let websearchMode = localStorage.getItem(STORAGE_WEBSEARCH) === "true";

export function getResearchMode(): boolean {
  return researchMode;
}

export function getWebsearchMode(): boolean {
  return websearchMode;
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

function refreshWebsearchUI() {
  if (!websearchToggle) return;
  if (websearchMode) {
    websearchToggle.classList.add("websearch-on");
    websearchToggle.title = "Web search ON — Research mode also pulls fresh web hits (Tavily)";
  } else {
    websearchToggle.classList.remove("websearch-on");
    websearchToggle.title = "Web search OFF — Research mode uses vault only";
  }
}
refreshWebsearchUI();

websearchToggle?.addEventListener("click", () => {
  websearchMode = !websearchMode;
  localStorage.setItem(STORAGE_WEBSEARCH, String(websearchMode));
  refreshWebsearchUI();
});

async function pickResearchModel(): Promise<string> {
  try {
    const res = await fetch(`${OLLAMA_BASE}/api/tags`);
    const data = await res.json();
    const names: string[] = (data.models || []).map((m: any) => m.name);
    // Prefer well-known small/fast models for the research pass; fall through
    // to anything in the 3-8B range, or whatever the user has picked.
    const prefer = [
      "llama3.1:8b", "llama3.2:3b",
      "qwen2.5-coder:7b",
    ];
    for (const p of prefer) {
      if (names.includes(p)) return p;
    }
    const small = names.find(n => /:[378]b/i.test(n));
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

  let webHits: WebHit[] = [];
  let webAnswer: string | null = null;
  if (websearchMode) {
    status("Searching the web…");
    // One web call against the user's original question; Tavily ranks better
    // on natural language than on the chopped-up term list. Failures are
    // swallowed so a missing key / network blip never breaks Research mode.
    try {
      const res = await invoke<{ answer: string | null; hits: WebHit[] }>("web_search", {
        query,
        maxResults: 5,
      });
      webHits = res.hits || [];
      webAnswer = res.answer ?? null;
    } catch (e: any) {
      const msg = String(e?.message ?? e);
      status(msg.includes("TAVILY_API_KEY")
        ? "Web search skipped — TAVILY_API_KEY not set."
        : `Web search failed: ${msg}`);
    }
  }

  status(`Found ${notes.length} note(s)${websearchMode ? `, ${webHits.length} web hit(s)` : ""}. Outlining the answer…`);

  const notesText = notes.length
    ? notes.map(n => `--- ${n.rel} ---\n${n.excerpt}`).join("\n\n")
    : "(no relevant notes found in vault)";
  const webText = webHits.length
    ? webHits.map(h => `--- ${h.title} (${h.url}) ---\n${h.snippet}`).join("\n\n")
    : "(no web results)";

  const outlinePrompt = `You are a research assistant. The user asked: "${query}"

Here are excerpts from their personal knowledge base that may be relevant:
${notesText}

${websearchMode ? `Here are fresh excerpts from the web:\n${webText}\n\n` : ""}Based on the question and these sources, write a SHORT outline (3-5 bullet points) of what a good answer should cover. Be concise. Return only the bullets, no preamble.`;

  let outline = "";
  try {
    outline = await callOllamaOnce(fastModel, outlinePrompt, 0.3);
  } catch (e: any) {
    status(`Outline failed: ${e.message}`);
  }

  return { searchTerms: terms, notes, webHits, webAnswer, outline, fastModel };
}

export function buildAugmentedPrompt(query: string, r: ResearchResult): string {
  const notesBlock = r.notes.length
    ? `\n\nResearch notes from the user's knowledge base:\n${r.notes.map(n => `--- ${n.rel} ---\n${n.excerpt}`).join("\n\n")}`
    : "";
  const webBlock = r.webHits.length
    ? `\n\nWeb sources (cite as [n] using these numbers):\n${r.webHits
        .map((h, i) => `[${i + 1}] ${h.title} — ${h.url}\n${h.snippet}`)
        .join("\n\n")}`
    : "";
  const answerBlock = r.webAnswer
    ? `\n\nTavily quick answer (treat as a hint, not ground truth):\n${r.webAnswer}`
    : "";
  const outlineBlock = r.outline ? `\n\nOutline (from research assistant):\n${r.outline}` : "";
  const citeHint = r.webHits.length
    ? " Cite web sources inline using [n] markers matching the numbered list above."
    : "";
  return `${query}${notesBlock}${webBlock}${answerBlock}${outlineBlock}\n\nProvide a thorough, well-structured answer using the outline, notes, and sources above where relevant.${citeHint}`;
}
