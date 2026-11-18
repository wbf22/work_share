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
/* rich text (description with embedded images)                        */
/* ------------------------------------------------------------------ */

const IMAGE_MD_RE = /!\[([^\]]*)\]\(([^)\s]+)\)/g;

function safeUrl(url) {
  if (/^\/[^/]/.test(url)) return url;
  if (/^https?:\/\//i.test(url)) return url;
  if (/^data:image\//i.test(url)) return url;
  return null;
}

const ALLOWED_TAGS = new Set(["IMG", "BR", "B", "STRONG", "I", "EM", "U", "P", "DIV", "SPAN"]);

function sanitizeNode(node) {
  if (node.nodeType === Node.TEXT_NODE) {
    return document.createTextNode(node.textContent);
  }
  if (node.nodeType !== Node.ELEMENT_NODE) {
    return document.createTextNode("");
  }

  const tag = node.tagName;
  if (tag === "SCRIPT" || tag === "STYLE") {
    return document.createTextNode("");
  }
  if (tag === "IMG") {
    const src = safeUrl(node.getAttribute("src") || "");
    if (!src) return document.createTextNode("");
    return el("img", { class: "desc-img", src, alt: node.getAttribute("alt") || "" });
  }

  const keep = ALLOWED_TAGS.has(tag);
  const target = keep ? document.createElement(tag.toLowerCase()) : document.createDocumentFragment();
  for (const child of node.childNodes) target.append(sanitizeNode(child));
  return target;
}

function sanitizeHtml(html) {
  const source = new DOMParser().parseFromString(String(html), "text/html");
  const output = document.createElement("div");
  for (const node of source.body.childNodes) output.append(sanitizeNode(node));
  return output.innerHTML;
}

function mdToHtml(text) {
  const escaped = String(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");

  return escaped
    .replace(IMAGE_MD_RE, (full, alt, url) => {
      const src = safeUrl(url);
      if (!src) return full;
      return `<img class="desc-img" src="${src}" alt="${alt.replace(/"/g, "&quot;")}">`;
    })
    .replace(/\n/g, "<br>");
}

function descriptionToHtml(raw) {
  if (!raw) return "";
  if (/<(img|br|div|p|b|strong|i|em|u|span)\b/i.test(raw)) {
    return sanitizeHtml(raw);
  }
  return sanitizeHtml(mdToHtml(raw));
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
  listWorkers: () => api("/api/workers"),
  listGroups: () => api("/api/groups"),
  listQualifications: () => api("/api/qualifications"),
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
let currentTitle = "";
let existingImages = [];
let pendingImages = [];
const expandedGroups = new Set();

function fileToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

/* ---- lightbox ---- */

const lightbox = document.getElementById("lightbox");
const lightboxImg = document.getElementById("lightbox-img");
const lightboxCount = document.getElementById("lightbox-count");
let lbImages = [];
let lbIndex = 0;
let lbTitle = "";

function openLightbox(images, index, title) {
  if (!lightbox || !images.length) return;
  lbImages = images;
  lbIndex = index || 0;
  lbTitle = title || "";
  updateLightbox();
  lightbox.showModal();
}

function updateLightbox() {
  lightboxImg.src = lbImages[lbIndex];
  lightboxImg.alt = lbTitle || "attachment";
  lightboxCount.textContent =
    `${lbIndex + 1} / ${lbImages.length}` + (lbTitle ? ` \u00b7 ${lbTitle}` : "");
  const single = lbImages.length < 2;
  document.getElementById("lightbox-prev").hidden = single;
  document.getElementById("lightbox-next").hidden = single;
}

function stepLightbox(delta) {
  lbIndex = (lbIndex + delta + lbImages.length) % lbImages.length;
  updateLightbox();
}

function initLightbox() {
  if (!lightbox) return;
  document.getElementById("lightbox-close").addEventListener("click", () => lightbox.close());
  document.getElementById("lightbox-prev").addEventListener("click", () => stepLightbox(-1));
  document.getElementById("lightbox-next").addEventListener("click", () => stepLightbox(1));
  lightbox.addEventListener("click", (event) => {
    if (event.target === lightbox) lightbox.close();
  });
  lightbox.addEventListener("keydown", (event) => {
    if (event.key === "ArrowLeft") stepLightbox(-1);
    if (event.key === "ArrowRight") stepLightbox(1);
  });
}

/* ---- list ---- */

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

  const groups = new Map();
  items.forEach((item) => {
    const key = (item.group || "").trim();
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(item);
  });

  const named = [...groups.keys()].filter((k) => k).sort((a, b) => a.localeCompare(b));
  const hasGroups = named.length > 0;
  const order = hasGroups ? named.concat(groups.has("") ? [""] : []) : [""];

  order.forEach((key) => {
    const groupItems = groups.get(key);
    if (!groupItems) return;

    if (!hasGroups) {
      groupItems.forEach((item) => workList.append(renderWorkCard(item)));
      return;
    }

    const open = expandedGroups.has(key);
    const head = el("button", { class: "group-head" + (open ? " open" : ""), type: "button" },
      el("span", { class: "group-chevron", text: "\u25b8" }),
      el("h3", { class: "group-name", text: key || "Ungrouped" }),
      el("span", { class: "group-count", text: groupItems.length })
    );

    const body = el("div", { class: "group-body" });
    body.hidden = !open;
    groupItems.forEach((item) => body.append(renderWorkCard(item)));

    head.addEventListener("click", () => {
      const nowOpen = !expandedGroups.has(key);
      if (nowOpen) expandedGroups.add(key);
      else expandedGroups.delete(key);
      body.hidden = !nowOpen;
      head.classList.toggle("open", nowOpen);
    });

    workList.append(el("div", { class: "group" }, head, body));
  });
}

function renderWorkCard(item) {
  const card = el("article", { class: "work-item", tabindex: "0", role: "button" });
  const images = item.images || [];

  card.addEventListener("click", (event) => {
    if (event.target.closest(".work-actions")) return;
    openDialog(item);
  });
  card.addEventListener("keydown", (event) => {
    if (event.target.closest(".work-actions")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openDialog(item);
    }
  });

  const thumb = el("div", { class: "work-thumb" + (images.length ? "" : " empty") });
  if (images.length) {
    thumb.append(el("img", { src: images[0], alt: item.name }));
    if (images.length > 1) {
      thumb.append(el("span", { class: "thumb-count", text: "+" + (images.length - 1) }));
    }
  } else {
    thumb.append(el("span", { text: "\u{1F4CB}" }));
  }
  card.append(thumb);

  const body = el("div", { class: "work-body" });

  const heading = el("div", { class: "work-heading" });
  heading.append(el("h3", { text: item.name }));
  body.append(heading);

  const badges = el("div", { class: "badges" });
  if (item.group) {
    badges.append(el("span", { class: "badge group", text: `\u{1F4C1} ${item.group}` }));
  }
  badges.append(el("span", { class: "badge", text: `Demand ${item.physicalDemand}/10` }));
  if (item.assignedTo) {
    badges.append(el("span", { class: "badge auto", text: `Assigned: ${item.assignedTo}` }));
  } else if (item.autoAssign) {
    badges.append(el("span", { class: "badge auto", text: "Auto assign" }));
  } else {
    badges.append(el("span", { class: "badge", text: "Manual" }));
  }
  if (item.reassignEachMeeting) {
    badges.append(el("span", { class: "badge", text: "Reassigned each meeting" }));
  }
  (item.qualifications || []).forEach((q) => {
    badges.append(el("span", { class: "badge qual", text: q }));
  });
  body.append(badges);

  const row = el("div", { class: "work-foot" });
  row.append(
    el("div", { class: "progress" },
      el("div", { class: "progress-fill", style: `width: ${item.progress}%` })
    ),
    el("span", { class: "progress-label", text: item.progress + "%" })
  );

  const actions = el("div", { class: "work-actions" },
    el("button", { class: "btn small", type: "button", onclick: () => openDialog(item) }, "Edit / View"),
    el("button", { class: "btn small", type: "button", onclick: () => duplicateWork(item) }, "Duplicate"),
    el("button", { class: "btn small danger", type: "button", onclick: () => deleteWork(item) }, "Delete")
  );
  row.append(actions);

  body.append(row);
  card.append(body);
  return card;
}

async function refreshWork() {
  try {
    const [items, serverGroups, serverQuals] = await Promise.all([
      WorkAPI.list(),
      WorkAPI.listGroups().catch(() => []),
      WorkAPI.listQualifications().catch(() => []),
    ]);
    const names = (list) =>
      (list || []).map((entry) => (typeof entry === "string" ? entry : entry && entry.name));
    const fromItems = items.map((i) => (i.group || "").trim()).filter(Boolean);
    groupNames = [...new Set([...names(serverGroups), ...fromItems].filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    const fromQuals = items.flatMap((i) => i.qualifications || []);
    qualificationNames = [...new Set([...names(serverQuals), ...fromQuals].filter(Boolean))]
      .sort((a, b) => a.localeCompare(b));
    renderWorkList(items);
  } catch (err) {
    workList.replaceChildren(el("div", { class: "empty" }, el("p", { class: "err", text: err.message })));
  }
}

/* ---- image previews ---- */

function allDialogImages() {
  return existingImages.concat(pendingImages.map((entry) => entry.dataUrl));
}

function renderImagePreview() {
  imagePreview.replaceChildren();

  existingImages.forEach((url, index) => {
    imagePreview.append(previewTile(url, {
      index,
      onEmbed: () => insertImageIntoEditor(url),
      onRemove: () => {
        existingImages.splice(index, 1);
        renderImagePreview();
      },
    }));
  });

  pendingImages.forEach((entry, index) => {
    imagePreview.append(previewTile(entry.dataUrl, {
      index: existingImages.length + index,
      onRemove: () => {
        pendingImages.splice(index, 1);
        renderImagePreview();
      },
    }));
  });

  if (!existingImages.length && !pendingImages.length) {
    imagePreview.append(el("span", { class: "empty-sub", text: "No pictures yet." }));
  }
}

function previewTile(src, opts = {}) {
  const tile = el("div", { class: "preview-tile" });
  tile.append(
    el("img", {
      src,
      alt: "attached picture",
      class: "preview-img",
      title: "View",
      onclick: () => openLightbox(allDialogImages(), opts.index || 0, currentTitle),
    })
  );

  const actions = el("div", { class: "preview-actions" });
  if (opts.onEmbed) {
    actions.append(
      el("button", { type: "button", class: "preview-btn", title: "Insert into description", onclick: opts.onEmbed }, "\u29c9")
    );
  }
  if (opts.onRemove) {
    actions.append(
      el("button", { type: "button", class: "preview-btn remove", title: "Remove", onclick: opts.onRemove }, "\u00d7")
    );
  }

  tile.append(actions);
  return tile;
}

/* ---- rich description editor ---- */

const descriptionEditor = document.getElementById("description-editor");

function insertImageIntoEditor(url, alt) {
  if (!descriptionEditor) return;
  const img = el("img", { class: "desc-img", src: url, alt: alt || "picture" });

  descriptionEditor.focus();
  const selection = window.getSelection();
  if (!selection || !selection.rangeCount || !descriptionEditor.contains(selection.anchorNode)) {
    descriptionEditor.append(img);
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  range.insertNode(img);
  range.setStartAfter(img);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
}

function getDescriptionHtml() {
  if (!descriptionEditor) return "";
  return sanitizeHtml(descriptionEditor.innerHTML).trim();
}

function setDescriptionHtml(raw) {
  if (descriptionEditor) descriptionEditor.innerHTML = descriptionToHtml(raw);
}

/* ---- searchable comboboxes ---- */

function createCombo(root, input, opts) {
  const menu = root.querySelector(".combo-menu");
  let value = "";
  let index = -1;
  let cache = [];

  const display = (v) => (opts.display ? opts.display(v) : v || "");

  function optionsFor(query) {
    const base = opts.options();
    const q = (query || "").trim().toLowerCase();
    const matches = q ? base.filter((o) => o.label.toLowerCase().includes(q)) : base.slice();
    if (q && opts.createLabel && !base.some((o) => o.label.toLowerCase() === q)) {
      matches.push({ value: query.trim(), label: opts.createLabel(query.trim()), create: true });
    }
    return matches;
  }

  function open(query) {
    cache = optionsFor(query);
    index = Math.max(0, cache.findIndex((o) => o.value === value));
    menu.replaceChildren(
      ...cache.map((option) => {
        const item = el("div", {
          class: "combo-option" + (option.value === value ? " selected" : ""),
          role: "option",
        }, option.label);
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          select(option.value);
        });
        return item;
      })
    );
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight();
  }

  function close() {
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }

  function highlight() {
    const items = menu.querySelectorAll(".combo-option");
    items.forEach((item, i) => item.classList.toggle("active", i === index));
    if (items[index]) items[index].scrollIntoView({ block: "nearest" });
  }

  function select(v) {
    value = v || "";
    input.value = display(value);
    close();
  }

  input.addEventListener("focus", () => {
    input.value = value;
    open("");
  });
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("blur", () => {
    setTimeout(() => {
      close();
      const typed = input.value.trim();
      if (typed !== display(value).trim()) value = typed;
      input.value = display(value);
      if (opts.onCommit) opts.onCommit(value);
    }, 120);
  });
  input.addEventListener("keydown", (event) => {
    const items = menu.querySelectorAll(".combo-option");
    if (event.key === "ArrowDown") {
      event.preventDefault();
      index = Math.min(index + 1, items.length - 1);
      highlight();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      index = Math.max(index - 1, 0);
      highlight();
    } else if (event.key === "Enter") {
      if (!menu.hidden && cache[index]) {
        event.preventDefault();
        select(cache[index].value);
      }
    } else if (event.key === "Escape") {
      close();
      input.value = display(value);
    }
  });

  return {
    get value() {
      return value;
    },
    set(v) {
      value = v || "";
      input.value = display(value);
    },
  };
}

function createTagInput(root, opts) {
  const list = root.querySelector(".tag-list");
  const input = root.querySelector("input");
  const menu = root.querySelector(".combo-menu");
  let values = [];
  let index = -1;
  let cache = [];

  function render() {
    list.replaceChildren(
      ...values.map((value) => {
        const remove = el("button", {
          type: "button",
          class: "tag-remove",
          "aria-label": `Remove ${value}`,
        }, "\u00d7");
        remove.addEventListener("click", () => {
          values = values.filter((v) => v !== value);
          render();
        });
        return el("span", { class: "tag" }, value, remove);
      })
    );
  }

  function optionsFor(query) {
    const q = (query || "").trim().toLowerCase();
    const pool = opts.options().filter((name) => !values.includes(name));
    const matches = q ? pool.filter((name) => name.toLowerCase().includes(q)) : pool;
    const out = matches.map((name) => ({ value: name, label: name }));
    if (q && !pool.some((name) => name.toLowerCase() === q)) {
      out.push({ value: query.trim(), label: `Create "${query.trim()}"`, create: true });
    }
    return out;
  }

  function open(query) {
    cache = optionsFor(query);
    index = cache.length ? 0 : -1;
    menu.replaceChildren(
      ...cache.map((option) => {
        const item = el("div", {
          class: "combo-option" + (option.create ? " create" : ""),
          role: "option",
        }, option.label);
        item.addEventListener("mousedown", (event) => {
          event.preventDefault();
          add(option.value);
        });
        return item;
      })
    );
    menu.hidden = false;
    input.setAttribute("aria-expanded", "true");
    highlight();
  }

  function close() {
    menu.hidden = true;
    input.setAttribute("aria-expanded", "false");
  }

  function highlight() {
    const items = menu.querySelectorAll(".combo-option");
    items.forEach((item, i) => item.classList.toggle("active", i === index));
    if (items[index]) items[index].scrollIntoView({ block: "nearest" });
  }

  function add(value) {
    const text = (value || "").trim();
    if (!text) return;
    if (!values.includes(text)) values.push(text);
    if (opts.onCreate && !opts.options().includes(text)) opts.onCreate(text);
    input.value = "";
    render();
    open("");
    input.focus();
  }

  input.addEventListener("focus", () => open(input.value));
  input.addEventListener("input", () => open(input.value));
  input.addEventListener("blur", () => {
    setTimeout(() => {
      close();
      input.value = "";
    }, 120);
  });
  input.addEventListener("keydown", (event) => {
    const typed = input.value.trim();
    if (event.key === "Enter" || event.key === ",") {
      event.preventDefault();
      if (typed) add(typed);
      else if (!menu.hidden && cache[index]) add(cache[index].value);
    } else if (event.key === "ArrowDown") {
      event.preventDefault();
      index = Math.min(index + 1, cache.length - 1);
      highlight();
    } else if (event.key === "ArrowUp") {
      event.preventDefault();
      index = Math.max(index - 1, 0);
      highlight();
    } else if (event.key === "Backspace" && !typed && values.length) {
      values.pop();
      render();
    } else if (event.key === "Escape") {
      close();
    }
  });

  return {
    get values() {
      return values.slice();
    },
    set(next) {
      values = Array.isArray(next)
        ? next.map((v) => String(v).trim()).filter(Boolean)
        : [];
      render();
    },
  };
}

let workerNames = [];
let groupNames = [];
let qualificationNames = [];

const assignCombo = form && form.elements.assignment
  ? createCombo(document.getElementById("assign-combo"), form.elements.assignment, {
      display: (v) => v || "Auto assign",
      options: () => [
        { value: "", label: "Auto assign" },
        ...workerNames.map((name) => ({ value: name, label: name })),
      ],
      createLabel: (q) => `Assign to "${q}"`,
    })
  : null;

const groupCombo = form && form.elements.group
  ? createCombo(document.getElementById("group-combo"), form.elements.group, {
      display: (v) => v || "",
      options: () => [
        { value: "", label: "No group" },
        ...groupNames.map((name) => ({ value: name, label: name })),
      ],
      createLabel: (q) => `Create group "${q}"`,
      onCommit: (v) => {
        if (v && !groupNames.includes(v)) {
          groupNames.push(v);
          groupNames.sort((a, b) => a.localeCompare(b));
        }
      },
    })
  : null;

const qualInput = form && document.getElementById("qual-input")
  ? createTagInput(document.getElementById("qual-input"), {
      options: () => qualificationNames,
      onCreate: (v) => {
        if (!qualificationNames.includes(v)) {
          qualificationNames.push(v);
          qualificationNames.sort((a, b) => a.localeCompare(b));
        }
      },
    })
  : null;

/* ---- dialog ---- */

function openDialog(item) {
  editingId = item ? item.id : null;
  existingImages = item && item.images ? [...item.images] : [];
  pendingImages = [];

  form.reset();
  currentTitle = item ? item.name : "";
  document.getElementById("work-dialog-title").textContent = item ? "Edit Work" : "Add Work";

  const f = form.elements;
  if (item) {
    f.name.value = item.name || "";
    f.physicalDemand.value = item.physicalDemand;
    f.progress.value = item.progress;
    f.reassignEachMeeting.checked = !!item.reassignEachMeeting;
    groupCombo.set(item.group || "");
    assignCombo.set(item.assignedTo || "");
    qualInput.set(item.qualifications || []);
    setDescriptionHtml(item.description || "");
  } else {
    f.physicalDemand.value = 5;
    f.progress.value = 0;
    groupCombo.set("");
    assignCombo.set("");
    qualInput.set([]);
    setDescriptionHtml("");
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
      group: groupCombo.value.trim(),
      description: getDescriptionHtml(),
      qualifications: qualInput.values,
      physicalDemand: Number(f.physicalDemand.value),
      progress: Number(f.progress.value),
      autoAssign: !assignCombo.value,
      assignedTo: assignCombo.value || null,
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

  if (descriptionEditor) {
    descriptionEditor.addEventListener("paste", (event) => {
      const html = event.clipboardData && event.clipboardData.getData("text/html");
      const text = event.clipboardData ? event.clipboardData.getData("text/plain") : "";
      event.preventDefault();
      if (html) {
        document.execCommand("insertHTML", false, sanitizeHtml(html));
      } else {
        document.execCommand("insertText", false, text);
      }
    });
  }

  loadWorkers();
  refreshWork();
}

async function loadWorkers() {
  try {
    const list = await WorkAPI.listWorkers();
    workerNames = (list || [])
      .map((w) => (typeof w === "string" ? w : w && w.name))
      .filter(Boolean);
  } catch (err) {
    workerNames = [];
  }
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
initLightbox();
initWorkPool();
checkServer();
