const status = document.getElementById("server-status");

const TABS = ["workers", "work", "meeting", "stats"];
const DEFAULT_TAB = "work";

function showTab(name) {
  if (!TABS.includes(name)) name = DEFAULT_TAB;

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.classList.toggle("active", tab.dataset.tab === name);
  });

  TABS.forEach((key) => {
    const panel = document.getElementById("panel-" + key);
    if (panel) panel.hidden = key !== name;
  });

  history.replaceState(null, "", "#" + name);
}

function initTabs() {
  if (!document.querySelector(".tab")) return;

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.addEventListener("click", () => showTab(tab.dataset.tab));
  });

  showTab(location.hash.slice(1));
}

async function checkServer() {
  if (!status) return;
  try {
    const res = await fetch("/api/health");
    if (!res.ok) throw new Error(res.status);
    const data = await res.json();
    status.textContent = `Server ${data.status} \u00b7 v${data.version}`;
    status.className = "ok";
  } catch (err) {
    status.textContent = "Server unreachable";
    status.className = "err";
  }
}

document.querySelectorAll("[data-action]").forEach((btn) => {
  btn.addEventListener("click", () => {
    alert(`Coming soon: ${btn.dataset.action}`);
  });
});

initTabs();
checkServer();
