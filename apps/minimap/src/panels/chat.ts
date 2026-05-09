import type { Api } from "../api.ts";
import type { Settings } from "../settings.ts";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

export function mountChat(api: Api, getSettings: () => Settings) {
  const body = document.getElementById("chat-body") as HTMLDivElement;
  const form = document.getElementById("chat-form") as HTMLFormElement;
  const input = document.getElementById("chat-input") as HTMLInputElement;
  const send = document.getElementById("chat-send") as HTMLButtonElement;
  const history: ChatMessage[] = [];

  function addMessage(role: "user" | "assistant", text: string, opts: { error?: boolean } = {}): HTMLElement {
    const el = document.createElement("div");
    el.className = `msg ${role === "user" ? "user" : opts.error ? "error" : "bot"}`;
    el.textContent = text;
    body.appendChild(el);
    body.scrollTop = body.scrollHeight;
    return el;
  }

  async function ask(prompt: string) {
    addMessage("user", prompt);
    history.push({ role: "user", content: prompt });

    const target = addMessage("assistant", "");
    target.classList.add("streaming");
    let acc = "";

    send.disabled = true;
    input.disabled = true;

    try {
      const r = await fetch(api.chatUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          model: getSettings().ollamaModel,
          messages: history,
        }),
      });
      if (!r.ok || !r.body) {
        target.remove();
        addMessage("assistant", `chat failed: HTTP ${r.status}`, { error: true });
        history.pop();
        return;
      }
      const reader = r.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const evt = JSON.parse(line) as {
              token?: string;
              error?: string;
              done?: boolean;
            };
            if (evt.error) {
              target.remove();
              addMessage("assistant", `error: ${evt.error}`, { error: true });
              history.pop();
              return;
            }
            if (evt.token) {
              acc += evt.token;
              target.textContent = acc;
              body.scrollTop = body.scrollHeight;
            }
          } catch {
            // ignore malformed lines
          }
        }
      }
      target.classList.remove("streaming");
      if (acc) {
        history.push({ role: "assistant", content: acc });
      } else {
        target.textContent = "(empty response)";
        history.pop();
      }
    } catch (e: unknown) {
      target.remove();
      addMessage("assistant", `chat error: ${(e as Error).message ?? e}`, {
        error: true,
      });
      history.pop();
    } finally {
      send.disabled = false;
      input.disabled = false;
      input.focus();
    }
  }

  form.addEventListener("submit", (ev) => {
    ev.preventDefault();
    const text = input.value.trim();
    if (!text) return;
    input.value = "";
    void ask(text);
  });

  addMessage(
    "assistant",
    "Hi — I'm the minimap helper. Ask me about jarvis status or anything else.",
  );
}
