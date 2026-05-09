// Brain SVG visualization — animated nodes that pulse to suggest activity, and
// matched nodes when search hits land. Driven by the chat busy state so the
// nodes fire faster while the model is generating.

import type { SearchHit } from "../types";
import { getVaultIndex, setVizHooks } from "./brain";

const SVG_NS = "http://www.w3.org/2000/svg";
const brainNodesGroup = document.querySelector(".brain-nodes") as SVGGElement | null;
const brainPulsesGroup = document.querySelector(".brain-pulses") as SVGGElement | null;
const brainStatNotes = document.getElementById("brain-stat-notes");
const brainStatWords = document.getElementById("brain-stat-words");
const brainStatActive = document.getElementById("brain-stat-active");

interface BrainNode {
  el: SVGCircleElement;
  docIndex: number;
  cx: number;
  cy: number;
}

let brainNodes: BrainNode[] = [];

const BRAIN_CX = 230;
const BRAIN_CY = 140;
const BRAIN_RINGS = [
  { r: 48,  cap: 8 },
  { r: 78,  cap: 14 },
  { r: 108, cap: 22 },
  { r: 132, cap: 28 },
];

function rebuildBrainNodes(noteCount: number) {
  if (!brainNodesGroup) return;
  brainNodesGroup.innerHTML = "";
  brainNodes = [];
  if (noteCount <= 0) return;

  const nodeBudget = Math.min(noteCount, BRAIN_RINGS.reduce((acc, r) => acc + r.cap, 0));
  let placed = 0;

  for (const ring of BRAIN_RINGS) {
    if (placed >= nodeBudget) break;
    const remainingRings = BRAIN_RINGS.slice(BRAIN_RINGS.indexOf(ring));
    const remainingCap = remainingRings.reduce((acc, r) => acc + r.cap, 0);
    const wantHere = Math.min(
      ring.cap,
      Math.ceil(((nodeBudget - placed) / remainingCap) * ring.cap),
    );
    const onRing = Math.max(1, wantHere);
    const angleStep = (Math.PI * 2) / onRing;
    const phase = Math.random() * Math.PI * 2;
    for (let i = 0; i < onRing && placed < nodeBudget; i++) {
      const angle = phase + i * angleStep;
      const jitter = (Math.random() - 0.5) * 6;
      const cx = BRAIN_CX + Math.cos(angle) * (ring.r + jitter);
      const cy = BRAIN_CY + Math.sin(angle) * (ring.r + jitter);
      const c = document.createElementNS(SVG_NS, "circle");
      c.setAttribute("cx", String(cx));
      c.setAttribute("cy", String(cy));
      c.setAttribute("r", "2.5");
      c.classList.add("brain-node");
      brainNodesGroup.appendChild(c);
      brainNodes.push({ el: c, docIndex: placed, cx, cy });
      placed++;
    }
  }
}

function highlightBrainNodes(activeIndices: Set<number>) {
  for (const n of brainNodes) {
    if (activeIndices.has(n.docIndex)) n.el.classList.add("matched");
    else n.el.classList.remove("matched");
  }
  if (brainStatActive) brainStatActive.textContent = String(activeIndices.size);
}

function clearBrainHighlights() {
  for (const n of brainNodes) n.el.classList.remove("matched");
  if (brainStatActive) brainStatActive.textContent = "0";
}

function fireRandomNode() {
  if (brainNodes.length === 0) return;
  const node = brainNodes[Math.floor(Math.random() * brainNodes.length)];
  node.el.classList.add("firing");
  setTimeout(() => node.el.classList.remove("firing"), 700);

  if (brainPulsesGroup && Math.random() < 0.55) {
    const pulse = document.createElementNS(SVG_NS, "circle");
    pulse.setAttribute("r", "2.5");
    pulse.setAttribute("cx", String(BRAIN_CX));
    pulse.setAttribute("cy", String(BRAIN_CY));
    pulse.classList.add("brain-pulse");
    brainPulsesGroup.appendChild(pulse);
    pulse.animate(
      [
        { cx: String(BRAIN_CX), cy: String(BRAIN_CY), opacity: 1 },
        { cx: String(node.cx), cy: String(node.cy), opacity: 0 },
      ] as any,
      { duration: 700, easing: "cubic-bezier(0.4, 0, 0.2, 1)" },
    ).onfinish = () => pulse.remove();
  }
}

let brainPulseTimer: number | undefined;
let brainPulseInterval = 480;

function startBrainPulse() {
  clearInterval(brainPulseTimer);
  brainPulseTimer = window.setInterval(fireRandomNode, brainPulseInterval);
}

function setBrainActivity(generating: boolean) {
  brainPulseInterval = generating ? 130 : 480;
  startBrainPulse();
}

const observer = new MutationObserver(() => {
  const busy = document.querySelector("header")?.classList.contains("busy");
  setBrainActivity(!!busy);
});
const headerEl = document.querySelector("header");
if (headerEl) observer.observe(headerEl, { attributes: true, attributeFilter: ["class"] });

startBrainPulse();

export function refreshBrainViz() {
  const vaultIndex = getVaultIndex();
  if (!vaultIndex) {
    if (brainStatNotes) brainStatNotes.textContent = "0";
    if (brainStatWords) brainStatWords.textContent = "0";
    rebuildBrainNodes(0);
    return;
  }
  const totalWords = vaultIndex.reduce(
    (acc, doc) => acc + (doc.content.match(/\S+/g)?.length || 0),
    0,
  );
  if (brainStatNotes) brainStatNotes.textContent = String(vaultIndex.length);
  if (brainStatWords) brainStatWords.textContent = totalWords > 999 ? `${(totalWords / 1000).toFixed(1)}k` : String(totalWords);
  rebuildBrainNodes(vaultIndex.length);
}

export function highlightFromHits(hits: SearchHit[]) {
  const vaultIndex = getVaultIndex();
  if (!vaultIndex) return;
  const matchedPaths = new Set(hits.map(h => h.doc.path));
  const indices = new Set<number>();
  for (let i = 0; i < vaultIndex.length; i++) {
    if (matchedPaths.has(vaultIndex[i].path)) indices.add(i);
  }
  highlightBrainNodes(indices);
}

setVizHooks({
  onIndexReady: refreshBrainViz,
  onSearchHits: highlightFromHits,
  onClearHighlights: clearBrainHighlights,
});
