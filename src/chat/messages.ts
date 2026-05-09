// Rendering primitives for the chat transcript. Pulled out of chat/index.ts
// so other modules (workspace, brain, settings, voice) can post system
// messages without dragging the whole chat send loop into their import graph.

import { marked } from "marked";
import hljs from "highlight.js";

marked.setOptions({ gfm: true, breaks: true });

const chatEl = document.getElementById("chat") as HTMLElement;

export function renderMarkdown(text: string): string {
  const rendered = marked.parse(text, { async: false }) as string;
  const wrapper = document.createElement("div");
  wrapper.innerHTML = rendered;
  wrapper.querySelectorAll("pre code").forEach((block) => {
    hljs.highlightElement(block as HTMLElement);
  });
  return wrapper.innerHTML;
}

export function addMessage(role: "user" | "assistant", content: string): HTMLElement {
  const wrap = document.createElement("div");
  wrap.className = `msg msg-${role}`;
  const body = document.createElement("div");
  body.className = "msg-body";
  body.textContent = content;
  wrap.appendChild(body);
  chatEl.appendChild(wrap);
  wrap.scrollIntoView({ behavior: "smooth", block: "end" });
  return body;
}

export function addSystem(content: string) {
  const el = document.createElement("div");
  el.className = "msg msg-system";
  el.textContent = content;
  chatEl.appendChild(el);
  el.scrollIntoView({ block: "end" });
}

export function clearChat() {
  chatEl.innerHTML = "";
}

export function getChatElement(): HTMLElement {
  return chatEl;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]!));
}
