const status = document.getElementById("server-status");

const TABS = ["workers", "work", "meeting", "stats"];
const DEFAULT_TAB = "work";

/* ------------------------------------------------------------------ */
/* small DOM helper                                                    */
/* ------------------------------------------------------------------ */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key === "html") node.innerHTML = value;
    else if (key.startsWith("on") && typeof value === "function") {
      node.addEventListener(key.slice(2), value);
    } else if (value === true) {
      node.setAttribute(key, "");
    } else {
      node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

/* ------------------------------------------------------------------ */
/* tabs                                                                */
/* ------------------------------------------------------------------ */

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

/* ------------------------------------------------------------------ */
/* api                                                                 */
/* ------------------------------------------------------------------ */

async function api(path, options = {}) {
  const res = await fetch(path, options);

  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }

  if (!res.ok) {
    throw new Error((data && data.error) || `Request failed (${res.status})`);
  }
  return data;
}

const WorkAPI = {
  list: () => api("/api/work"),
  create: (item) =>
    api("/api/work", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
    }),
  update: (id, item) =>
    api("/api/work/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(item),
    }),
  remove: (id) => api("/api/work/" + id, { method: "DELETE" }),
  duplicate: (id) => api("/api/work/" + id + "/duplicate", { method: "POST" }),
  uploadImage: (dataUrl) =>
    api("/api/images", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: dataUrl }),
    }),
};

/* ------------------------------------------------------------------ */
/* work pool                                                           */
/* ------------------------------------------------------------------ */

const workList = document.getElementById("work-list");
const dialog = document.getElementById("work-dialog");
const form = document.getElementById("work-form");
const imagePreview = document.getElementById("image-preview");
const demandOut = document.getElementById("demand-out");
const progressOut = document.getElementById("progress-out");

let editingId = null;
let existingImages = [];
let pendingImages = [];

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function renderWorkList(items) {
  workList.replaceChildren();

  if (!items.length) {
    workList.append(
      el(
        "div",
        { class: "empty" },
        el("p", { text: "No work in the pool yet." }),
        el("p", { class: "empty-sub", text: "Add your first job to get started." })
      )
    );
    return;
  }

  items.forEach((item) => workList.append(renderWorkCard(item)));
}

function renderWorkCard(item) {
  const card = el("article", { class: "work-item" });

  const thumb = el("div", { class: "work-thumb" });
  if (item.images && item.images.length) {
    thumb.append(el("img", { src: item.images[0], alt: item.name }));
    if (item.images.length > 1) {
      thumb.append(el("span", { class: "thumb-count", text: "+" + (item.images.length - 1) }));
    }
  } else {
    thumb.classList.add("empty");
    thumb.append(el("span", { text: "\u{1F4CB}" }));
  }
  card.append(thumb);

  const body = el("div", { class: "work-body" });
  body.append(el("h3", { text: item.name }));
  if (item.description) {
    body.append(el("p", { class: "work-desc", text: item.description }));
  }

  const badges = el("div", { class: "badges" });
  badges.append(
    el("span", { class: "badge", text: `Demand ${item.physicalDemand}/10` }),
    el("span", {
      class: "badge" + (item.autoAssign ? " auto" : ""),
      text: item.autoAssign ? "Auto assign" : "Manual",
    })
  );
  if (item.reassignEachMeeting) {
    badges.append(el("span", { class: "badge", text: "Reassigned each meeting" }));
  }
  (item.qualifications || []).forEach((q) => {
    badges.append(el("span", { class: "badge qual", text: q }));
  });
  body.append(badges);

  const progress = el("div", { class: "progress" },
    el("div", { class: "progress-fill", style: `width: ${item.progress}%` })
  );
  body.append(
    el("div", { class: "progress-row" },
      progress,
      el("span", { class: "progress-label", text: item.progress + "%" })
    )
  );

  const actions = el("div", { class: "work-actions" },
    el("button", { class: "btn small", type: "button", onclick: () => openDialog(item) }, "Edit"),
    el("button", { class: "btn small", type: "button", onclick: () => duplicateWork(item) }, "Duplicate"),
    el("button", { class: "btn small danger", type: "button", onclick: () => deleteWork(item) }, "Delete")
  );
  body.append(actions);

  card.append(body);
  return card;
}

async function refreshWork() {
  try {
    const items = await WorkAPI.list();
    renderWorkList(items);
  } catch (err) {
    workList.replaceChildren(el("div", { class: "empty" }, el("p", { class: "err", text: err.message })));
  }
}

/* ---- image previews ---- */

function renderImagePreview() {
  imagePreview.replaceChildren();

  existingImages.forEach((url, index) => {
    imagePreview.append(previewTile(url, () => {
      existingImages.splice(index, 1);
      renderImagePreview();
    }));
  });

  pendingImages.forEach((entry, index) => {
    imagePreview.append(previewTile(entry.dataUrl, () => {
      pendingImages.splice(index, 1);
      renderImagePreview();
    }));
  });

  if (!existingImages.length && !pendingImages.length) {
    imagePreview.append(el("span", { class: "empty-sub", text: "No pictures yet." }));
  }
}

function previewTile(src, onRemove) {
  return el("div", { class: "preview-tile" },
    el("img", { src, alt: "preview" }),
    el("button", { type: "button", class: "preview-remove", title: "Remove", onclick: onRemove }, "\u00d7")
  );
}

/* ---- dialog ---- */

function openDialog(item) {
  editingId = item ? item.id : null;
  existingImages = item && item.images ? [...item.images] : [];
  pendingImages = [];

  form.reset();
  document.getElementById("work-dialog-title").textContent = item ? "Edit Work" : "Add Work";

  const f = form.elements;
  if (item) {
    f.name.value = item.name || "";
    f.description.value = item.description || "";
    f.qualifications.value = (item.qualifications || []).join(", ");
    f.physicalDemand.value = item.physicalDemand;
    f.progress.value = item.progress;
    f.autoAssign.value = item.autoAssign ? "auto" : "manual";
    f.reassignEachMeeting.checked = !!item.reassignEachMeeting;
  } else {
    f.physicalDemand.value = 5;
    f.progress.value = 0;
    f.autoAssign.value = "auto";
  }

  updateOutputs();
  renderImagePreview();
  dialog.showModal();
}

function updateOutputs() {
  const f = form.elements;
  demandOut.textContent = f.physicalDemand.value;
  progressOut.textContent = f.progress.value + "%";
}

async function saveWork(event) {
  event.preventDefault();

  const saveBtn = document.getElementById("work-save");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving\u2026";

  try {
    const uploaded = await Promise.all(
      pendingImages.map((entry) => WorkAPI.uploadImage(entry.dataUrl).then((r) => r.url))
    );

    const f = form.elements;
    const payload = {
      name: f.name.value.trim(),
      description: f.description.value.trim(),
      qualifications: f.qualifications.value,
      physicalDemand: Number(f.physicalDemand.value),
      progress: Number(f.progress.value),
      autoAssign: f.autoAssign.value === "auto",
      reassignEachMeeting: f.reassignEachMeeting.checked,
      images: existingImages.concat(uploaded),
    };

    if (editingId) {
      await WorkAPI.update(editingId, payload);
    } else {
      await WorkAPI.create(payload);
    }

    dialog.close();
    await refreshWork();
  } catch (err) {
    alert("Could not save: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
  }
}

async function deleteWork(item) {
  if (!confirm(`Delete "${item.name}"?`)) return;
  try {
    await WorkAPI.remove(item.id);
    await refreshWork();
  } catch (err) {
    alert("Could not delete: " + err.message);
  }
}

async function duplicateWork(item) {
  try {
    await WorkAPI.duplicate(item.id);
    await refreshWork();
  } catch (err) {
    alert("Could not duplicate: " + err.message);
  }
}

/* ---- wiring ---- */

function initWorkPool() {
  if (!workList) return;

  document.getElementById("add-work").addEventListener("click", () => openDialog(null));
  document.getElementById("work-cancel").addEventListener("click", () => dialog.close());
  form.addEventListener("submit", saveWork);

  const f = form.elements;
  f.physicalDemand.addEventListener("input", updateOutputs);
  f.progress.addEventListener("input", updateOutputs);

  f.images.addEventListener("change", async (event) => {
    const files = Array.from(event.target.files || []);
    for (const file of files) {
      pendingImages.push({ dataUrl: await fileToDataUrl(file) });
    }
    event.target.value = "";
    renderImagePreview();
  });

  refreshWork();
}

/* ------------------------------------------------------------------ */
/* server status                                                       */
/* ------------------------------------------------------------------ */

async function checkServer() {
  if (!status) return;
  try {
    const data = await api("/api/health");
    status.textContent = `Server ${data.status} \u00b7 v${data.version}`;
    status.className = "ok";
  } catch (err) {
    status.textContent = "Server unreachable";
    status.className = "err";
  }
}

document.querySelectorAll("[data-action]").forEach((btn) => {
  btn.addEventListener("click", () => alert(`Coming soon: ${btn.dataset.action}`));
});

initTabs();
initWorkPool();
checkServer();
