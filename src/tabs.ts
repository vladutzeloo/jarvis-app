// Tab switching for the chat / workspace / brain views.

const tabs = document.querySelectorAll<HTMLButtonElement>(".tab");
const views = document.querySelectorAll<HTMLElement>(".view");

const input = document.getElementById("input") as HTMLTextAreaElement;
const brainSearch = document.getElementById("brain-search") as HTMLInputElement;

tabs.forEach(tab => {
  tab.addEventListener("click", () => {
    const target = tab.dataset.tab!;
    tabs.forEach(t => t.classList.toggle("active", t === tab));
    views.forEach(v => v.classList.toggle("active", v.dataset.view === target));
    if (target === "chat") input.focus();
    if (target === "brain") brainSearch.focus();
  });
});
