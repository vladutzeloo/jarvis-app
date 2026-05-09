// Chat send loop: orchestrates research → backend stream → markdown render →
// TTS handoff. Owns the conversation history, the input/send/clear UI, and
// the global "busy" flag that drives the brand pulse and brain activity.

import type { Message } from "../types";
import { OLLAMA_BASE } from "../types";
import { nvidiaChatStream } from "../backends/nvidia";
import { writeMemoryEntry } from "../vault";

import { addMessage, addSystem, clearChat, escapeHtml, renderMarkdown, getChatElement } from "./messages";
import { selectedBackend, getModelPicker } from "./models";
import { getResearchMode, runResearch, buildAugmentedPrompt } from "./research";
import type { ResearchResult } from "../types";

import { speak, cancelSynthOnly } from "../voice/tts";
import { isCallActive, endCall, getCurrentCallAudio } from "../voice/call";

import {
  getSettings,
  buildOllamaOptions,
  buildMessages,
  vaultSystemPromptReady,
} from "../settings/settings";

import { bumpTokens, updateTokenCells, persistTokenTotal } from "../cockpit/cockpit";

const input = document.getElementById("input") as HTMLTextAreaElement;
const sendBtn = document.getElementById("send") as HTMLButtonElement;
const clearBtn = document.getElementById("clear") as HTMLButtonElement;
const rememberBtn = document.getElementById("remember") as HTMLButtonElement | null;
const stats = document.getElementById("stats") as HTMLElement;

let history: Message[] = [];
let isGenerating = false;

export function getIsGenerating(): boolean {
  return isGenerating;
}

export async function send() {
  if (isGenerating) return;
  const text = input.value.trim();
  if (!text) return;

  isGenerating = true;
  sendBtn.disabled = true;
  input.value = "";
  input.style.height = "auto";

  // Make sure the vault-derived identity prompt is in place before we build
  // the messages array. After the first send, this resolves immediately.
  await vaultSystemPromptReady;

  cancelSynthOnly();

  history.push({ role: "user", content: text });
  addMessage("user", text);

  const assistantBody = addMessage("assistant", "");
  assistantBody.parentElement?.classList.add("streaming");

  const thinkingHTML = (label = "processing") => `
    <div class="thinking">
      <div class="thinking-orb">
        <svg viewBox="0 0 60 60">
          <circle class="ring outer" cx="30" cy="30" r="26" />
          <circle class="ring middle" cx="30" cy="30" r="18" />
          <circle class="ring inner" cx="30" cy="30" r="10" />
          <rect class="tick" x="29" y="2" width="2" height="6" rx="1" />
          <circle class="core" cx="30" cy="30" r="3" />
        </svg>
      </div>
      <span class="thinking-text">${label}</span>
    </div>
  `;
  const researchMode = getResearchMode();
  assistantBody.innerHTML = thinkingHTML(researchMode ? "researching" : "processing");

  document.querySelector("header")?.classList.add("busy");
  document.querySelector('.view[data-view="chat"]')?.classList.add("busy");

  const modelPicker = getModelPicker();
  const model = modelPicker.value;
  const startTime = performance.now();
  let tokenCount = 0;
  let assistantText = "";

  let researchResult: ResearchResult | null = null;
  if (researchMode) {
    try {
      researchResult = await runResearch(text, (label) => {
        assistantBody.innerHTML = thinkingHTML(label);
      });
      const augmented = buildAugmentedPrompt(text, researchResult);
      history[history.length - 1] = { role: "user", content: augmented };

      const card = document.createElement("details");
      card.className = "research-notes";
      const notesHTML = researchResult.notes.length
        ? researchResult.notes
            .map(n => `<div class="research-note"><div class="research-note-title">${escapeHtml(n.rel)}</div><div class="research-note-excerpt">${escapeHtml(n.excerpt.slice(0, 400))}${n.excerpt.length > 400 ? "…" : ""}</div></div>`)
            .join("")
        : `<div class="research-empty">No relevant notes found in your vault.</div>`;
      const webHTML = researchResult.webHits.length
        ? researchResult.webHits
            .map((h, i) => {
              const host = (() => { try { return new URL(h.url).host; } catch { return h.url; } })();
              return `<div class="research-note web-hit">
                <div class="research-note-title">
                  <span class="web-hit-index">[${i + 1}]</span>
                  <a href="${escapeHtml(h.url)}" target="_blank" rel="noopener noreferrer">${escapeHtml(h.title || host)}</a>
                  <span class="web-hit-host">${escapeHtml(host)}</span>
                </div>
                <div class="research-note-excerpt">${escapeHtml(h.snippet.slice(0, 400))}${h.snippet.length > 400 ? "…" : ""}</div>
              </div>`;
            })
            .join("")
        : "";
      const counts = `${researchResult.notes.length} note${researchResult.notes.length === 1 ? "" : "s"}` +
        (researchResult.webHits.length ? ` · ${researchResult.webHits.length} web` : "");
      card.innerHTML = `
        <summary>
          <span class="research-icon">🔬</span>
          <span class="research-title">Research notes</span>
          <span class="research-meta">${counts} · ${researchResult.fastModel}</span>
        </summary>
        <div class="research-body">
          ${researchResult.searchTerms.length ? `<div class="research-section"><div class="research-section-label">Search terms</div><div class="research-terms">${researchResult.searchTerms.map(t => `<span class="research-term">${escapeHtml(t)}</span>`).join("")}</div></div>` : ""}
          <div class="research-section"><div class="research-section-label">Notes</div>${notesHTML}</div>
          ${webHTML ? `<div class="research-section"><div class="research-section-label">🌐 Web sources</div>${webHTML}</div>` : ""}
          ${researchResult.webAnswer ? `<div class="research-section"><div class="research-section-label">Web summary</div><div class="research-outline">${renderMarkdown(researchResult.webAnswer)}</div></div>` : ""}
          ${researchResult.outline ? `<div class="research-section"><div class="research-section-label">Outline</div><div class="research-outline">${renderMarkdown(researchResult.outline)}</div></div>` : ""}
        </div>
      `;
      getChatElement().insertBefore(card, assistantBody.parentElement || null);
      card.scrollIntoView({ behavior: "smooth", block: "end" });

      assistantBody.innerHTML = thinkingHTML(`generating with ${model}`);
    } catch {
      assistantBody.innerHTML = thinkingHTML("research failed — falling back");
    }
  }

  const settings = getSettings();
  const backend = selectedBackend();

  try {
    if (backend === "nvidia") {
      // NVIDIA hosted inference. Streams via Tauri events from Rust;
      // the API key never reaches this JS context.
      const summary = await nvidiaChatStream(
        {
          model,
          messages: buildMessages(history) as { role: "system" | "user" | "assistant"; content: string }[],
          temperature: settings.temperature,
          top_p: settings.topP,
          max_tokens: settings.numPredict > 0 ? settings.numPredict : undefined,
        },
        (delta) => {
          assistantText += delta;
          assistantBody.innerHTML = renderMarkdown(assistantText);
          tokenCount++;
          bumpTokens(1);
          if (tokenCount % 10 === 0) updateTokenCells();
          const elapsed = (performance.now() - startTime) / 1000;
          const rate = tokenCount / elapsed;
          stats.textContent = `${tokenCount} tok • ${rate.toFixed(1)} tok/s • ${elapsed.toFixed(1)}s · NVIDIA`;
        },
      );
      const elapsed = (performance.now() - startTime) / 1000;
      const finalCount = summary.tokens > 0 ? summary.tokens : tokenCount;
      const finalRate = elapsed > 0 ? finalCount / elapsed : 0;
      stats.textContent = `${finalCount} tok • ${finalRate.toFixed(1)} tok/s • ${elapsed.toFixed(1)}s · NVIDIA`;
    } else {
      const res = await fetch(`${OLLAMA_BASE}/api/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model,
          messages: buildMessages(history),
          stream: true,
          options: buildOllamaOptions(),
        }),
      });

      if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() || "";

        for (const line of lines) {
          if (!line.trim()) continue;
          let obj: any;
          try { obj = JSON.parse(line); } catch { continue; }

          const chunk = obj.message?.content || "";
          if (chunk) {
            assistantText += chunk;
            assistantBody.innerHTML = renderMarkdown(assistantText);
            tokenCount++;
            bumpTokens(1);
            if (tokenCount % 10 === 0) updateTokenCells();
            const elapsed = (performance.now() - startTime) / 1000;
            const rate = tokenCount / elapsed;
            stats.textContent = `${tokenCount} tok • ${rate.toFixed(1)} tok/s • ${elapsed.toFixed(1)}s`;
          }

          if (obj.done) {
            const evalCount = obj.eval_count || tokenCount;
            const evalDur = (obj.eval_duration || 0) / 1e9;
            const finalRate = evalDur > 0 ? evalCount / evalDur : 0;
            stats.textContent = `${evalCount} tok • ${finalRate.toFixed(1)} tok/s • ${evalDur.toFixed(1)}s`;
          }
        }
      }
    }

    history.push({ role: "assistant", content: assistantText });
    speak(assistantText);
  } catch (e: any) {
    assistantBody.textContent = `Error: ${e.message}`;
    assistantBody.parentElement?.classList.add("error");
  } finally {
    assistantBody.parentElement?.classList.remove("streaming");
    document.querySelector("header")?.classList.remove("busy");
    document.querySelector('.view[data-view="chat"]')?.classList.remove("busy");
    persistTokenTotal();
    updateTokenCells();
    isGenerating = false;
    sendBtn.disabled = false;
    input.focus();
  }
}

sendBtn.addEventListener("click", send);
input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send();
  }
});
input.addEventListener("input", () => {
  input.style.height = "auto";
  input.style.height = Math.min(input.scrollHeight, 200) + "px";
});
clearBtn.addEventListener("click", () => {
  if (isGenerating) return;
  history = [];
  clearChat();
  stats.textContent = "";
  cancelSynthOnly();
  if (isCallActive()) endCall();
  const audio = getCurrentCallAudio();
  if (audio) audio.pause();
  input.focus();
});

// Remember button: snapshot the non-system turns of the current chat to
// `06_Memory/` in the vault as a dated markdown note with YAML frontmatter.
rememberBtn?.addEventListener("click", async () => {
  if (history.length === 0) {
    addSystem("Nothing to remember — chat is empty.");
    return;
  }
  const turns = history
    .map((m) => `**${m.role}:** ${m.content}`)
    .join("\n\n");
  const frontmatter = `---\ntitle: Session note\ndate: ${new Date().toISOString()}\ntags: [session, auto]\n---\n\n`;
  const saved = await writeMemoryEntry("session", frontmatter + turns);
  if (saved) {
    addSystem(`Saved to vault: ${saved}`);
  } else {
    addSystem("Could not save — is JARVIS_VAULT_PATH set?");
  }
});
