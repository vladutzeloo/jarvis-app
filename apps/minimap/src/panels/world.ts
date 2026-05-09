import type { Api, OrcState, OrcRecent, OrcWaypoint } from "../api.ts";
import { escapeHtml } from "../escape.ts";

const SVG_NS = "http://www.w3.org/2000/svg";

// Anchor points for each card-themed waypoint, in the SVG's 400x140 viewBox.
const POSITIONS: Record<OrcWaypoint, { x: number; y: number }> = {
  system: { x: 60, y: 96 },
  jobs: { x: 160, y: 96 },
  log: { x: 250, y: 96 },
  chat: { x: 340, y: 96 },
};

const WAYPOINTS: OrcWaypoint[] = ["system", "jobs", "log", "chat"];

export interface WorldPanel {
  refresh: () => void;
  stop: () => void;
}

export function mountWorld(api: Api, getPollMs: () => number): WorldPanel {
  const stage = document.getElementById("world-stage") as HTMLDivElement;
  const wpGroup = document.getElementById("world-waypoints") as SVGGElement | null;
  const orcGroup = document.getElementById("world-orc") as SVGGElement | null;
  const bubble = document.getElementById("world-bubble") as SVGGElement | null;
  const status = document.getElementById("world-status") as HTMLSpanElement | null;
  const current = document.getElementById("world-current") as HTMLDivElement | null;
  const recent = document.getElementById("world-recent") as HTMLDivElement | null;
  const runBtn = document.getElementById("orc-run-now") as HTMLButtonElement | null;
  const badge = document.getElementById("orc-badge") as HTMLButtonElement | null;
  const badgeCount = document.getElementById("orc-badge-count") as HTMLSpanElement | null;

  if (!stage || !wpGroup || !orcGroup || !bubble || !status || !current || !recent) {
    return { refresh: () => {}, stop: () => {} };
  }

  // Render the four named waypoints once. We just toggle .active on each tick.
  for (const name of WAYPOINTS) {
    const pos = POSITIONS[name];
    const g = document.createElementNS(SVG_NS, "g");
    g.setAttribute("class", "world-waypoint");
    g.setAttribute("data-name", name);
    g.setAttribute("transform", `translate(${pos.x} ${pos.y})`);
    const marker = document.createElementNS(SVG_NS, "circle");
    marker.setAttribute("class", "wp-marker");
    marker.setAttribute("cx", "0");
    marker.setAttribute("cy", "14");
    marker.setAttribute("r", "5");
    g.appendChild(marker);
    const label = document.createElementNS(SVG_NS, "text");
    label.setAttribute("class", "wp-label");
    label.setAttribute("x", "0");
    label.setAttribute("y", "32");
    label.setAttribute("text-anchor", "middle");
    label.textContent = name;
    g.appendChild(label);
    wpGroup.appendChild(g);
  }

  // Animation state. We linearly interpolate the orc's x/y between
  // (lastWaypoint, nextWaypoint) over walkDurationMs while phase==='walking'.
  let orcX = POSITIONS.system.x;
  let orcY = POSITIONS.system.y;
  let walkFrom: OrcWaypoint = "system";
  let walkTo: OrcWaypoint = "system";
  let walkStart = performance.now();
  let walkDurationMs = 2400;
  let phase: "idle" | "walking" | "thinking" = "idle";

  function setOrcTransform(x: number, y: number) {
    if (!orcGroup) return;
    orcGroup.setAttribute("transform", `translate(${x} ${y})`);
  }

  function setBubbleVisible(visible: boolean) {
    if (!bubble) return;
    if (visible) {
      bubble.classList.remove("hidden");
      bubble.setAttribute("transform", `translate(${orcX} ${orcY})`);
    } else {
      bubble.classList.add("hidden");
    }
  }

  function applyPhase(next: OrcState) {
    const newPhase = next.phase;
    const target = next.next_waypoint as OrcWaypoint;
    const settled = next.waypoint as OrcWaypoint;

    if (newPhase === "walking") {
      // Start a fresh interpolation if we just transitioned in.
      if (phase !== "walking" || walkTo !== target) {
        walkFrom = settled in POSITIONS ? settled : walkTo;
        walkTo = target in POSITIONS ? target : walkTo;
        walkStart = performance.now();
        // Walk takes about as long as the server's cosmetic walk pause (2.5s).
        walkDurationMs = 2400;
      }
    } else if (newPhase === "thinking" || newPhase === "idle") {
      // Snap to the settled waypoint when not walking — server already updated
      // `waypoint` to the destination at this point.
      const pos = POSITIONS[settled in POSITIONS ? settled : walkTo];
      orcX = pos.x;
      orcY = pos.y;
      walkFrom = settled in POSITIONS ? settled : walkTo;
      walkTo = walkFrom;
    }
    phase = newPhase;

    // Highlight the active waypoint.
    if (wpGroup) {
      for (const child of Array.from(wpGroup.children)) {
        const name = child.getAttribute("data-name");
        if (name === settled) child.classList.add("active");
        else child.classList.remove("active");
      }
    }
    setBubbleVisible(newPhase === "thinking");
  }

  function tickAnimation(now: number) {
    if (phase === "walking") {
      const t = Math.min(1, (now - walkStart) / Math.max(1, walkDurationMs));
      const a = POSITIONS[walkFrom];
      const b = POSITIONS[walkTo];
      orcX = a.x + (b.x - a.x) * t;
      // Add a small parabolic hop so the walk reads as movement, not slide.
      const hop = Math.sin(t * Math.PI) * 6;
      orcY = a.y + (b.y - a.y) * t - hop;
    } else if (phase === "idle") {
      // Gentle bob.
      orcY = POSITIONS[walkTo].y + Math.sin(now / 500) * 1.2;
    }
    setOrcTransform(orcX, orcY);
    if (phase === "thinking") {
      // Keep bubble pinned even if the SVG resizes; cheap to update.
      bubble?.setAttribute("transform", `translate(${orcX} ${orcY})`);
    }
    rafId = requestAnimationFrame(tickAnimation);
  }

  let rafId = requestAnimationFrame(tickAnimation);

  function renderRecent(list: OrcRecent[]) {
    if (!recent) return;
    if (!list.length) {
      recent.innerHTML = `<div class="muted">orc has not finished a cycle yet.</div>`;
      return;
    }
    recent.innerHTML = list
      .slice(0, 6)
      .map((r) => {
        const when = new Date(r.finished_at * 1000).toLocaleTimeString();
        const klass = r.error ? "world-recent-item error" : "world-recent-item";
        const body = r.error
          ? `error: ${escapeHtml(r.error)}`
          : escapeHtml(r.answer || "(empty)");
        return `
          <div class="${klass}">
            <div class="world-recent-prompt" title="${escapeHtml(r.prompt)}">${escapeHtml(r.prompt)}</div>
            <div class="world-recent-answer">${body}</div>
            <div class="world-recent-meta"><span>${escapeHtml(r.model)}</span><span>${escapeHtml(when)}</span></div>
          </div>
        `;
      })
      .join("");
  }

  function renderStatus(next: OrcState) {
    if (!status) return;
    const verb = next.phase === "thinking" ? "thinking" : next.phase === "walking" ? "walking" : "idle";
    const next_in = next.phase === "idle" ? ` · next in ${Math.round(next.seconds_until_next)}s` : "";
    const enabled = next.enabled ? "" : " · paused";
    status.textContent = `orc · ${verb}${next_in}${enabled}`;
  }

  function renderCurrent(next: OrcState) {
    if (!current) return;
    if (next.phase === "thinking" && next.current) {
      const partial = (next.current.partial || "").slice(-180);
      current.classList.add("thinking");
      current.textContent = partial
        ? `> ${partial}`
        : `> ${next.current.prompt}`;
    } else if (next.phase === "walking" && next.current) {
      current.classList.remove("thinking");
      current.textContent = `walking to ${next.next_waypoint} · prompt: ${next.current.prompt}`;
    } else {
      current.classList.remove("thinking");
      current.textContent = "no active prompt";
    }
  }

  function renderBadge(next: OrcState) {
    if (!badge || !badgeCount) return;
    badgeCount.textContent = String(next.unread);
    badge.dataset.unread = String(next.unread);
    badge.dataset.thinking = next.phase === "thinking" ? "true" : "false";
  }

  let timer: number | undefined;
  let aborter: AbortController | undefined;

  async function tick() {
    if (timer != null) {
      window.clearTimeout(timer);
      timer = undefined;
    }
    aborter?.abort();
    const local = new AbortController();
    aborter = local;
    try {
      const next = await api.orcState(local.signal);
      if (local.signal.aborted) return;
      applyPhase(next);
      renderStatus(next);
      renderCurrent(next);
      renderRecent(next.recent);
      renderBadge(next);
    } catch (e: unknown) {
      if (local.signal.aborted) return;
      if ((e as { name?: string }).name === "AbortError") return;
      if (status) status.textContent = "orc · offline";
      if (badge && badgeCount) {
        badgeCount.textContent = "0";
        badge.dataset.unread = "0";
        badge.dataset.thinking = "false";
      }
    } finally {
      if (!local.signal.aborted) {
        // Faster polling when orc is active so the partial answer streams in.
        const base = getPollMs();
        const eager = phase === "thinking" || phase === "walking" ? 1000 : base;
        timer = window.setTimeout(tick, Math.min(base, eager));
      }
    }
  }

  runBtn?.addEventListener("click", async () => {
    runBtn.disabled = true;
    try {
      await api.orcRunNow();
    } catch {
      /* ignore — tick() will surface offline state */
    } finally {
      runBtn.disabled = false;
      tick();
    }
  });

  badge?.addEventListener("click", async () => {
    try {
      await api.orcAck();
    } catch {
      /* ignore */
    }
    tick();
  });

  tick();

  return {
    refresh: tick,
    stop() {
      aborter?.abort();
      if (timer != null) window.clearTimeout(timer);
      cancelAnimationFrame(rafId);
    },
  };
}
