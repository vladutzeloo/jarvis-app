// Tab switching for the chat / workspace / brain / world views.

const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
const views = document.querySelectorAll<HTMLElement>(".view");

const input = document.getElementById("input") as HTMLTextAreaElement;
const brainSearch = document.getElementById("brain-search") as HTMLInputElement;
const agentsArgv = document.getElementById("agents-argv") as HTMLTextAreaElement | null;
const vintedNew = document.getElementById("vinted-new") as HTMLButtonElement | null;

// Body flags consumed by the stylesheets:
//   `.no-crt`        — suppress the CRT scanline + flicker overlay (it would
//                      muddy a 3D scene). On for World always, and on for
//                      Brain when its 3D mode is active.
//   `.world-active`  — additionally hide the SVG circuit + the ambient
//                      starfield so the World tab's 3D canvas owns every
//                      pixel and we don't burn the GPU rendering both.
function applyChromeFlags(target: string) {
  const body = document.body;
  body.classList.toggle("world-active", target === "world");

  // Brain 3D mode toggles `.viz3d-on` on `.brain-viz`; we read that to
  // decide whether to suppress the CRT overlay. Default to off.
  const brainViz3DOn = !!document.querySelector(".brain-viz.viz3d-on");
  body.classList.toggle("no-crt", target === "world" || (target === "brain" && brainViz3DOn));
}

tabs.forEach(tab => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab!;
    tabs.forEach(t => t.classList.toggle("active", t === tab));
    views.forEach(v => v.classList.toggle("active", v.dataset.view === target));
    applyChromeFlags(target);
    if (target === "chat") input.focus();
    if (target === "brain") brainSearch.focus();
    if (target === "agents") agentsArgv?.focus();
    if (target === "vinted") vintedNew?.focus();
  });
});

// Initial state — pick up the section that's already marked `.active` in
// HTML, so the body flags match the rendered tab on first paint.
const initialActive = document.querySelector<HTMLElement>(".view.active");
if (initialActive?.dataset.view) applyChromeFlags(initialActive.dataset.view);

// Keep the no-crt flag in sync if the Brain 3D toggle flips while the
// Brain tab is active.
const brainViz = document.querySelector(".brain-viz");
if (brainViz) {
  new MutationObserver(() => {
    const activeView = document.querySelector<HTMLElement>(".view.active");
    if (activeView?.dataset.view) applyChromeFlags(activeView.dataset.view);
  }).observe(brainViz, { attributes: true, attributeFilter: ["class"] });
}
