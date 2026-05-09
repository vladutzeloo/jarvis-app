// Vinted tab — multi-bot Vinted hunter for PC parts.
//
// State lives server-side (Python `vinted_runner.py` persists to a JSON file
// under ~/jarvis-tts). The webview is a thin client over those REST endpoints
// served by the same WSL bridge that hosts /system-stats and /tts.
//
// Scan results carry a `source` field — "vinted" when the public catalog
// returned data, "demo" when it didn't and the runner generated plausible
// listings instead. The UI surfaces that so the user knows what they're
// looking at.

import { PIPER_BASE } from "../types";

interface CategoryDef {
  id: string;
  label: string;
}

interface VintedHealth {
  ok: boolean;
  store?: string;
  categories?: CategoryDef[];
  conditions?: string[];
  max_bots?: number;
  error?: string;
}

interface Suggestion {
  id: string;
  title: string;
  price: number;
  currency: string;
  url: string;
  thumb: string | null;
  condition: string | null;
  favourite_count: number;
  score: number;
  verdict: "buy" | "watch" | "skip";
  reason: string;
  median_price: number;
}

interface ScanSummary {
  counts: { buy: number; watch: number; skip: number };
  total: number;
  cheapest: Suggestion | null;
  top_pick: Suggestion | null;
}

interface Bot {
  id: string;
  name: string;
  query: string;
  category: string;
  condition: string;
  min_price: number | null;
  max_price: number | null;
  max_results: number;
  created_at?: number;
  last_scan_at?: number | null;
  last_results?: Suggestion[];
  last_summary?: ScanSummary;
  last_source?: "vinted" | "demo";
}

interface ScanResponse {
  bot_id: string;
  scanned_at: number;
  source: "vinted" | "demo";
  error: string | null;
  summary: ScanSummary;
  suggestions: Suggestion[];
}

const VIEW = document.querySelector<HTMLElement>('.view[data-view="vinted"]');
if (!VIEW) {
  // Tab markup not present — bail quietly. (Lets the module be no-oped if
  // someone strips the tab from index.html.)
  throw new Error("vinted tab not found");
}

const statusEl = document.getElementById("vinted-status") as HTMLElement;
const statusText = statusEl.querySelector(".vinted-status-text") as HTMLElement;
const versionEl = document.getElementById("vinted-version") as HTMLElement;
const newBtn = document.getElementById("vinted-new") as HTMLButtonElement;
const scanAllBtn = document.getElementById("vinted-scan-all") as HTMLButtonElement;
const botListEl = document.getElementById("vinted-bot-list") as HTMLUListElement;

const editorEl = document.getElementById("vinted-editor") as HTMLFormElement;
const editorTitle = document.getElementById("vinted-editor-title") as HTMLElement;
const editorMsg = document.getElementById("vinted-editor-msg") as HTMLElement;
const formName = document.getElementById("vinted-form-name") as HTMLInputElement;
const formQuery = document.getElementById("vinted-form-query") as HTMLInputElement;
const formCategory = document.getElementById("vinted-form-category") as HTMLSelectElement;
const formCondition = document.getElementById("vinted-form-condition") as HTMLSelectElement;
const formMin = document.getElementById("vinted-form-min") as HTMLInputElement;
const formMax = document.getElementById("vinted-form-max") as HTMLInputElement;
const formMaxResults = document.getElementById("vinted-form-max-results") as HTMLInputElement;
const formCancelBtn = document.getElementById("vinted-form-cancel") as HTMLButtonElement;

const detailEl = document.getElementById("vinted-detail") as HTMLElement;
const detailName = document.getElementById("vinted-detail-name") as HTMLElement;
const detailMeta = document.getElementById("vinted-detail-meta") as HTMLElement;
const editBtn = document.getElementById("vinted-edit") as HTMLButtonElement;
const deleteBtn = document.getElementById("vinted-delete") as HTMLButtonElement;
const scanBtn = document.getElementById("vinted-scan") as HTMLButtonElement;
const summaryBuy = document.getElementById("vinted-summary-buy") as HTMLElement;
const summaryWatch = document.getElementById("vinted-summary-watch") as HTMLElement;
const summarySkip = document.getElementById("vinted-summary-skip") as HTMLElement;
const summarySource = document.getElementById("vinted-summary-source") as HTMLElement;
const resultsEl = document.getElementById("vinted-results") as HTMLUListElement;

const emptyEl = document.getElementById("vinted-empty") as HTMLElement;

let bots: Bot[] = [];
let selectedId: string | null = null;
let editingId: string | null = null;

// ─── status pill ─────────────────────────────────────────────────────────────

function setStatus(state: "online" | "offline" | "probing" | "degraded", text: string) {
  statusEl.dataset.state = state;
  statusText.textContent = text;
}

async function refreshHealth() {
  try {
    const res = await fetch(`${PIPER_BASE}/vinted/health`, {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) {
      setStatus("offline", "bridge offline");
      versionEl.textContent = "run scripts/jarvis-server.sh";
      return;
    }
    const h: VintedHealth = await res.json();
    if (!h.ok) {
      setStatus("degraded", "bridge degraded");
      versionEl.textContent = h.error || "";
      return;
    }
    setStatus("online", "bridge online");
    versionEl.textContent = `${h.categories?.length ?? 0} categories · max ${h.max_bots} bots`;
    populateSelect(formCategory, (h.categories || []).map(c => ({ value: c.id, label: c.label })));
    populateSelect(formCondition, (h.conditions || []).map(c => ({ value: c, label: c.replace(/_/g, " ") })));
  } catch {
    setStatus("offline", "bridge offline");
    versionEl.textContent = "run scripts/jarvis-server.sh";
  }
}

function populateSelect(sel: HTMLSelectElement, opts: { value: string; label: string }[]) {
  if (sel.dataset.populated === "1") return;
  sel.replaceChildren();
  for (const { value, label } of opts) {
    const o = document.createElement("option");
    o.value = value;
    o.textContent = label;
    sel.appendChild(o);
  }
  sel.dataset.populated = "1";
}

setStatus("probing", "probing…");

// Recursive setTimeout (rather than setInterval) so a slow probe can never
// overlap with the next one — the next tick is only scheduled once the
// previous fetch settles.
async function probeLoop() {
  await refreshHealth();
  setTimeout(probeLoop, 12000);
}
probeLoop();

// ─── bot list ────────────────────────────────────────────────────────────────

async function fetchBots() {
  try {
    const res = await fetch(`${PIPER_BASE}/vinted/bots`);
    if (!res.ok) {
      bots = [];
      renderBotList();
      return;
    }
    bots = await res.json();
    renderBotList();
    if (selectedId && !bots.find(b => b.id === selectedId)) {
      selectedId = null;
      showEmpty();
    } else if (selectedId) {
      renderDetail();
    }
  } catch {
    bots = [];
    renderBotList();
  }
}

function renderBotList() {
  botListEl.replaceChildren();
  if (bots.length === 0) {
    const li = document.createElement("li");
    li.className = "vinted-bot-empty";
    li.textContent = "No bots yet — click + New bot.";
    botListEl.appendChild(li);
    return;
  }
  for (const bot of bots) {
    const li = document.createElement("li");
    li.className = "vinted-bot";
    li.tabIndex = 0;
    li.dataset.id = bot.id;
    if (bot.id === selectedId) li.classList.add("active");

    const head = document.createElement("div");
    head.className = "vinted-bot-head";
    const name = document.createElement("span");
    name.className = "vinted-bot-name";
    name.textContent = bot.name;
    const buyCount = bot.last_summary?.counts.buy ?? 0;
    if (buyCount > 0) {
      const badge = document.createElement("span");
      badge.className = "vinted-bot-badge";
      badge.textContent = `${buyCount} buy`;
      head.appendChild(name);
      head.appendChild(badge);
    } else {
      head.appendChild(name);
    }

    const sub = document.createElement("div");
    sub.className = "vinted-bot-sub";
    const filters: string[] = [bot.category];
    if (bot.min_price != null) filters.push(`≥ €${bot.min_price}`);
    if (bot.max_price != null) filters.push(`≤ €${bot.max_price}`);
    if (bot.condition !== "any") filters.push(bot.condition.replace(/_/g, " "));
    sub.textContent = `"${bot.query}" · ${filters.join(" · ")}`;

    const meta = document.createElement("div");
    meta.className = "vinted-bot-meta";
    meta.textContent = bot.last_scan_at
      ? `last scan ${formatRelative(bot.last_scan_at)}`
      : "never scanned";

    li.appendChild(head);
    li.appendChild(sub);
    li.appendChild(meta);

    const select = () => {
      selectedId = bot.id;
      hideEditor();
      renderDetail();
      renderBotList();
    };
    li.addEventListener("click", select);
    li.addEventListener("keydown", e => {
      if (e.key === "Enter" || e.key === " ") {
        e.preventDefault();
        select();
      }
    });
    botListEl.appendChild(li);
  }
}

// ─── detail panel ────────────────────────────────────────────────────────────

function selectedBot(): Bot | undefined {
  return bots.find(b => b.id === selectedId);
}

function renderDetail() {
  const bot = selectedBot();
  if (!bot) {
    showEmpty();
    return;
  }
  emptyEl.classList.add("hidden");
  editorEl.classList.add("hidden");
  detailEl.classList.remove("hidden");

  detailName.textContent = bot.name;
  const metaParts: string[] = [
    `query: "${bot.query}"`,
    `category: ${bot.category}`,
    `condition: ${bot.condition}`,
    `top ${bot.max_results}`,
  ];
  if (bot.min_price != null) metaParts.push(`min €${bot.min_price}`);
  if (bot.max_price != null) metaParts.push(`max €${bot.max_price}`);
  detailMeta.textContent = metaParts.join(" · ");

  const summary = bot.last_summary;
  summaryBuy.textContent = String(summary?.counts.buy ?? 0);
  summaryWatch.textContent = String(summary?.counts.watch ?? 0);
  summarySkip.textContent = String(summary?.counts.skip ?? 0);

  if (bot.last_scan_at) {
    const src = bot.last_source === "demo" ? "demo data (Vinted unreachable)" : "live Vinted";
    summarySource.textContent = `Source: ${src} · scanned ${formatRelative(bot.last_scan_at)}`;
    summarySource.dataset.source = bot.last_source || "";
  } else {
    summarySource.textContent = "Not scanned yet — press ▶ Scan.";
    summarySource.dataset.source = "";
  }

  renderResults(bot.last_results || []);
}

function renderResults(suggestions: Suggestion[]) {
  resultsEl.replaceChildren();
  if (suggestions.length === 0) {
    const li = document.createElement("li");
    li.className = "vinted-result-empty";
    li.textContent = "No suggestions yet. Press ▶ Scan to fetch listings.";
    resultsEl.appendChild(li);
    return;
  }
  for (const s of suggestions) {
    const li = document.createElement("li");
    li.className = "vinted-result";
    li.dataset.verdict = s.verdict;

    const verdictBadge = document.createElement("span");
    verdictBadge.className = "vinted-result-verdict";
    verdictBadge.textContent = s.verdict.toUpperCase();

    const main = document.createElement("div");
    main.className = "vinted-result-main";

    const title = document.createElement("a");
    title.className = "vinted-result-title";
    title.href = s.url || "#";
    title.target = "_blank";
    title.rel = "noopener noreferrer";
    title.textContent = s.title;

    const reason = document.createElement("div");
    reason.className = "vinted-result-reason";
    reason.textContent = s.reason;

    main.appendChild(title);
    main.appendChild(reason);

    const stats = document.createElement("div");
    stats.className = "vinted-result-stats";
    const price = document.createElement("div");
    price.className = "vinted-result-price";
    price.textContent = `€${s.price.toFixed(2)}`;
    const median = document.createElement("div");
    median.className = "vinted-result-median";
    median.textContent = s.median_price ? `median €${s.median_price.toFixed(0)}` : "";
    const score = document.createElement("div");
    score.className = "vinted-result-score";
    score.textContent = `score ${s.score}`;
    stats.appendChild(price);
    if (s.median_price) stats.appendChild(median);
    stats.appendChild(score);

    const negotiateBtn = document.createElement("button");
    negotiateBtn.className = "vinted-result-negotiate";
    negotiateBtn.title = "Suggest a counter-offer";
    negotiateBtn.textContent = "💬 Negotiate";
    negotiateBtn.addEventListener("click", () => openNegotiation(s.id));

    li.appendChild(verdictBadge);
    li.appendChild(main);
    li.appendChild(stats);
    li.appendChild(negotiateBtn);
    resultsEl.appendChild(li);
  }
}

function showEmpty() {
  detailEl.classList.add("hidden");
  editorEl.classList.add("hidden");
  emptyEl.classList.remove("hidden");
}

// ─── editor ──────────────────────────────────────────────────────────────────

function showEditor(bot: Bot | null) {
  editingId = bot?.id ?? null;
  detailEl.classList.add("hidden");
  emptyEl.classList.add("hidden");
  editorEl.classList.remove("hidden");
  editorTitle.textContent = bot ? `Edit · ${bot.name}` : "New bot";
  editorMsg.textContent = "";

  formName.value = bot?.name ?? "";
  formQuery.value = bot?.query ?? "";
  formCategory.value = bot?.category ?? "gpu";
  formCondition.value = bot?.condition ?? "any";
  formMin.value = bot?.min_price != null ? String(bot.min_price) : "";
  formMax.value = bot?.max_price != null ? String(bot.max_price) : "";
  formMaxResults.value = String(bot?.max_results ?? 8);
  formName.focus();
}

function hideEditor() {
  editorEl.classList.add("hidden");
  editingId = null;
}

newBtn.addEventListener("click", () => showEditor(null));

editBtn.addEventListener("click", () => {
  const bot = selectedBot();
  if (bot) showEditor(bot);
});

formCancelBtn.addEventListener("click", () => {
  if (selectedId) {
    renderDetail();
  } else {
    showEmpty();
  }
  hideEditor();
});

editorEl.addEventListener("submit", async e => {
  e.preventDefault();
  editorMsg.textContent = "saving…";

  const payload: Record<string, unknown> = {
    name: formName.value.trim(),
    query: formQuery.value.trim(),
    category: formCategory.value,
    condition: formCondition.value,
    min_price: formMin.value === "" ? null : Number(formMin.value),
    max_price: formMax.value === "" ? null : Number(formMax.value),
    max_results: Number(formMaxResults.value || 8),
  };
  if (editingId) payload.id = editingId;

  try {
    const res = await fetch(`${PIPER_BASE}/vinted/bots`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      editorMsg.textContent = `error: ${body.error || res.statusText}`;
      return;
    }
    const saved: Bot = await res.json();
    selectedId = saved.id;
    await fetchBots();
    hideEditor();
    renderDetail();
  } catch (err: any) {
    editorMsg.textContent = `error: ${err.message || err}`;
  }
});

// ─── scan / delete ───────────────────────────────────────────────────────────

scanBtn.addEventListener("click", async () => {
  const bot = selectedBot();
  if (!bot) return;
  scanBtn.disabled = true;
  const original = scanBtn.textContent;
  scanBtn.textContent = "scanning…";
  try {
    const res = await fetch(`${PIPER_BASE}/vinted/scan/${encodeURIComponent(bot.id)}`, {
      method: "POST",
    });
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      summarySource.textContent = `scan failed: ${body.error || res.statusText}`;
      return;
    }
    const result: ScanResponse = await res.json();
    bot.last_scan_at = result.scanned_at;
    bot.last_results = result.suggestions;
    bot.last_summary = result.summary;
    bot.last_source = result.source;
    renderDetail();
    renderBotList();
  } finally {
    scanBtn.disabled = false;
    scanBtn.textContent = original;
  }
});

deleteBtn.addEventListener("click", async () => {
  const bot = selectedBot();
  if (!bot) return;
  if (!confirm(`Delete bot "${bot.name}"? This cannot be undone.`)) return;
  const res = await fetch(`${PIPER_BASE}/vinted/bots/${encodeURIComponent(bot.id)}`, {
    method: "DELETE",
  });
  if (!res.ok) {
    alert(`delete failed: ${res.statusText}`);
    return;
  }
  selectedId = null;
  await fetchBots();
  showEmpty();
});

scanAllBtn.addEventListener("click", async () => {
  if (bots.length === 0) return;
  scanAllBtn.disabled = true;
  const original = scanAllBtn.textContent;
  scanAllBtn.textContent = "scanning…";
  try {
    const res = await fetch(`${PIPER_BASE}/vinted/scan-all`, { method: "POST" });
    if (!res.ok) {
      alert(`scan-all failed: ${res.statusText}`);
      return;
    }
    await fetchBots();
  } finally {
    scanAllBtn.disabled = false;
    scanAllBtn.textContent = original;
  }
});

// ─── helpers ─────────────────────────────────────────────────────────────────

function formatRelative(epoch: number): string {
  const diff = Date.now() / 1000 - epoch;
  if (diff < 60) return "just now";
  if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
  if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
  return `${Math.floor(diff / 86400)}d ago`;
}

// ─── negotiation modal ───────────────────────────────────────────────────────

interface NegotiationDraft {
  tone: "polite" | "direct" | "lowball";
  text: string;
}

interface NegotiationResponse {
  bot_id: string;
  listing_id: string;
  title: string;
  url: string | null;
  asking: number;
  median: number;
  p25: number;
  comparable_count: number;
  bucket: string;
  condition: string | null;
  target_offer: number;
  lowball: number;
  ceiling: number;
  discount_pct: number;
  reason: string;
  drafts: NegotiationDraft[];
}

const negModal = document.getElementById("vinted-negotiate-modal") as HTMLElement;
const negBackdrop = document.getElementById("vinted-negotiate-backdrop") as HTMLElement;
const negCloseBtn = document.getElementById("vinted-negotiate-close") as HTMLButtonElement;
const negTitle = document.getElementById("vinted-negotiate-title") as HTMLElement;
const negListingLink = document.getElementById("vinted-negotiate-listing") as HTMLAnchorElement;
const negLowball = document.getElementById("vinted-negotiate-lowball") as HTMLElement;
const negTarget = document.getElementById("vinted-negotiate-target") as HTMLElement;
const negCeiling = document.getElementById("vinted-negotiate-ceiling") as HTMLElement;
const negDiscount = document.getElementById("vinted-negotiate-discount") as HTMLElement;
const negContext = document.getElementById("vinted-negotiate-context") as HTMLElement;
const negReason = document.getElementById("vinted-negotiate-reason") as HTMLElement;
const negDraftsList = document.getElementById("vinted-negotiate-drafts-list") as HTMLUListElement;

function closeNegotiation() {
  negModal.classList.add("hidden");
}

negCloseBtn.addEventListener("click", closeNegotiation);
negBackdrop.addEventListener("click", closeNegotiation);
document.addEventListener("keydown", e => {
  if (e.key === "Escape" && !negModal.classList.contains("hidden")) closeNegotiation();
});

async function openNegotiation(listingId: string) {
  const bot = selectedBot();
  if (!bot) return;
  // Render the modal in a loading state immediately so the user gets feedback.
  negModal.classList.remove("hidden");
  negTitle.textContent = "Negotiation suggestion";
  negListingLink.textContent = "loading…";
  negListingLink.removeAttribute("href");
  negLowball.textContent = "—";
  negTarget.textContent = "—";
  negCeiling.textContent = "—";
  negDiscount.textContent = "";
  negContext.textContent = "";
  negReason.textContent = "";
  negDraftsList.replaceChildren();

  try {
    const res = await fetch(
      `${PIPER_BASE}/vinted/negotiate/${encodeURIComponent(bot.id)}/${encodeURIComponent(listingId)}`,
      { method: "POST" },
    );
    if (!res.ok) {
      const body = await res.json().catch(() => ({ error: res.statusText }));
      negContext.textContent = `error: ${body.error || res.statusText}`;
      return;
    }
    const n: NegotiationResponse = await res.json();
    renderNegotiation(n);
  } catch (e: any) {
    negContext.textContent = `error: ${e.message || e}`;
  }
}

function renderNegotiation(n: NegotiationResponse) {
  negListingLink.textContent = n.title;
  if (n.url) {
    negListingLink.href = n.url;
  } else {
    negListingLink.removeAttribute("href");
  }
  negLowball.textContent = `€${n.lowball.toFixed(0)}`;
  negTarget.textContent = `€${n.target_offer.toFixed(0)}`;
  negCeiling.textContent = `€${n.ceiling.toFixed(0)}`;
  negDiscount.textContent =
    n.discount_pct > 0
      ? `${n.discount_pct.toFixed(0)}% below asking €${n.asking.toFixed(0)}`
      : `at asking €${n.asking.toFixed(0)}`;
  const ctxBits: string[] = [
    `Asking €${n.asking.toFixed(0)}`,
    `median €${n.median.toFixed(0)}`,
    `${n.comparable_count} comparable`,
  ];
  if (n.condition) ctxBits.push(`condition ${n.condition.replace(/_/g, " ")}`);
  negContext.textContent = ctxBits.join(" · ");
  negReason.textContent = n.reason;

  negDraftsList.replaceChildren();
  for (const draft of n.drafts) {
    const li = document.createElement("li");
    li.className = "vinted-negotiate-draft";
    li.dataset.tone = draft.tone;

    const toneLabel = document.createElement("span");
    toneLabel.className = "vinted-negotiate-draft-tone";
    toneLabel.textContent = draft.tone;

    const text = document.createElement("p");
    text.className = "vinted-negotiate-draft-text";
    text.textContent = draft.text;

    const copyBtn = document.createElement("button");
    copyBtn.className = "vinted-negotiate-draft-copy";
    copyBtn.textContent = "Copy";
    copyBtn.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(draft.text);
        copyBtn.textContent = "Copied ✓";
        setTimeout(() => { copyBtn.textContent = "Copy"; }, 1500);
      } catch {
        copyBtn.textContent = "Copy failed";
      }
    });

    li.appendChild(toneLabel);
    li.appendChild(text);
    li.appendChild(copyBtn);
    negDraftsList.appendChild(li);
  }
}

// ─── boot ────────────────────────────────────────────────────────────────────

fetchBots();
