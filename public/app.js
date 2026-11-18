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
  markDone: (id, done) =>
    api("/api/work/" + id + "/done", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ done }),
    }),
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

const WorkerAPI = {
  list: () => api("/api/workers"),
  create: (worker) =>
    api("/api/workers", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(worker),
    }),
  update: (id, worker) =>
    api("/api/workers/" + id, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(worker),
    }),
  remove: (id) => api("/api/workers/" + id, { method: "DELETE" }),
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
let allItems = [];
let poolMode = "active";
let poolQuery = "";

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

function visibleItems() {
  const q = poolQuery.trim().toLowerCase();
  return allItems.filter((item) => {
    const isActive = !item.done;
    if (poolMode === "active" && !isActive) return false;
    if (poolMode === "past" && isActive) return false;
    if (!q) return true;
    const haystack = [item.name, item.assignedTo || "", ...(item.qualifications || [])]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
}

function renderWorkList(items = visibleItems()) {
  workList.replaceChildren();

  if (!items.length) {
    const searching = poolQuery.trim() !== "";
    const heading = searching
      ? "No matching work."
      : poolMode === "past"
        ? "No completed work yet."
        : "No active work.";
    const sub = searching
      ? "Try a different title, worker, or qualification."
      : allItems.length
        ? "Switch modes or add a new job."
        : "Add your first job to get started.";
    workList.append(
      el("div", { class: "empty" }, el("p", { text: heading }), el("p", { class: "empty-sub", text: sub }))
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
  const card = el("article", {
    class: "work-item" + (item.done ? " is-done" : ""),
    tabindex: "0",
    role: "button",
  });
  const images = item.images || [];

  card.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    openDialog(item);
  });
  card.addEventListener("keydown", (event) => {
    if (event.target.closest("button")) return;
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

  const heading = el("div", { class: "work-heading" },
    el("h3", { text: item.name }),
    el("button", {
      class: "btn tiny" + (item.done ? "" : " primary"),
      type: "button",
      title: item.done ? "Reopen this work" : "Mark this work done",
      onclick: () => toggleDone(item),
    }, item.done ? "Reopen" : "Mark done")
  );
  body.append(heading);

  const badges = el("div", { class: "badges" });
  if (item.done) {
    const when = item.completedAt ? new Date(item.completedAt).toLocaleDateString() : "";
    badges.append(el("span", { class: "badge done", text: when ? `Done ${when}` : "Done" }));
  }
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
    allItems = items;
    renderWorkList();
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

async function toggleDone(item) {
  try {
    await WorkAPI.markDone(item.id, !item.done);
    await refreshWork();
  } catch (err) {
    alert("Could not update work: " + err.message);
  }
}

/* ---- wiring ---- */

function initWorkPool() {
  if (!workList) return;

  document.getElementById("add-work").addEventListener("click", () => openDialog(null));
  document.getElementById("work-cancel").addEventListener("click", () => dialog.close());
  form.addEventListener("submit", saveWork);

  const modeButtons = document.querySelectorAll("#pool-modes .seg");
  modeButtons.forEach((btn) => {
    btn.addEventListener("click", () => {
      poolMode = btn.dataset.mode;
      modeButtons.forEach((b) => b.classList.toggle("active", b === btn));
      renderWorkList();
    });
  });

  const search = document.getElementById("pool-search");
  if (search) {
    search.addEventListener("input", () => {
      poolQuery = search.value;
      renderWorkList();
    });
  }

  dialog.addEventListener("click", (event) => {
    if (event.target !== dialog) return;
    const box = form.getBoundingClientRect();
    const onBackdrop =
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom;
    if (onBackdrop) form.requestSubmit();
  });

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
/* workers                                                             */
/* ------------------------------------------------------------------ */

const workerList = document.getElementById("worker-list");
const workerDialog = document.getElementById("worker-dialog");
const workerForm = document.getElementById("worker-form");
const strengthOut = document.getElementById("strength-out");

let allWorkers = [];
let workerQuery = "";
let editingWorkerId = null;
let workerPhoto = "";

const workerQualInput = workerForm
  ? createTagInput(document.getElementById("worker-qual-input"), {
      options: () => qualificationNames,
      onCreate: (v) => {
        if (!qualificationNames.includes(v)) {
          qualificationNames.push(v);
          qualificationNames.sort((a, b) => a.localeCompare(b));
        }
      },
    })
  : null;

function renderWorkerList() {
  if (!workerList) return;
  workerList.replaceChildren();

  const q = workerQuery.trim().toLowerCase();
  const workers = allWorkers.filter((w) => {
    if (!q) return true;
    return [w.name, ...(w.qualifications || [])].join(" ").toLowerCase().includes(q);
  });

  if (!workers.length) {
    const searching = q !== "";
    workerList.append(
      el("div", { class: "empty" },
        el("p", { text: searching ? "No matching workers." : "No workers yet." }),
        el("p", {
          class: "empty-sub",
          text: searching ? "Try a different name or qualification." : "Add your first worker to get started.",
        })
      )
    );
    return;
  }

  workers.forEach((worker) => workerList.append(renderWorkerCard(worker)));
}

function renderWorkerCard(worker) {
  const card = el("article", { class: "work-item", tabindex: "0", role: "button" });
  card.addEventListener("click", (event) => {
    if (event.target.closest("button")) return;
    openWorkerDialog(worker);
  });
  card.addEventListener("keydown", (event) => {
    if (event.target.closest("button")) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      openWorkerDialog(worker);
    }
  });

  if (worker.photo) {
    card.append(
      el("div", { class: "worker-avatar has-photo" },
        el("img", { src: worker.photo, alt: worker.name })
      )
    );
  } else {
    const initial = (worker.name || "?").trim().charAt(0).toUpperCase() || "?";
    card.append(el("div", { class: "worker-avatar", text: initial }));
  }

  const body = el("div", { class: "work-body" });
  body.append(el("div", { class: "work-heading" }, el("h3", { text: worker.name })));

  const badges = el("div", { class: "badges" });
  badges.append(el("span", { class: "badge", text: `Physical capacity ${worker.strength}/10` }));
  (worker.qualifications || []).forEach((q) => {
    badges.append(el("span", { class: "badge qual", text: q }));
  });
  body.append(badges);

  const foot = el("div", { class: "work-foot" });
  foot.append(
    el("div", { class: "work-actions" },
      el("button", { class: "btn small", type: "button", onclick: () => openWorkerDialog(worker) }, "Edit / View"),
      el("button", { class: "btn small danger", type: "button", onclick: () => deleteWorker(worker) }, "Delete")
    )
  );
  body.append(foot);

  card.append(body);
  return card;
}

function updateStrengthOutput() {
  if (strengthOut && workerForm) strengthOut.textContent = workerForm.elements.strength.value;
}

function renderWorkerPhoto() {
  const box = document.getElementById("worker-photo-preview");
  if (!box) return;
  box.replaceChildren();

  if (!workerPhoto) {
    box.append(el("span", { class: "empty-sub", text: "No picture yet." }));
    return;
  }

  const tile = el("div", { class: "preview-tile" });
  tile.append(
    el("img", {
      src: workerPhoto,
      alt: "worker photo",
      class: "preview-img",
      title: "View",
      onclick: () => openLightbox([workerPhoto], 0, workerForm.elements.name.value),
    })
  );
  const actions = el("div", { class: "preview-actions" });
  actions.append(
    el("button", {
      type: "button",
      class: "preview-btn remove",
      title: "Remove picture",
      onclick: () => {
        workerPhoto = "";
        renderWorkerPhoto();
      },
    }, "\u2715")
  );
  tile.append(actions);
  box.append(tile);
}

function openWorkerDialog(worker) {
  editingWorkerId = worker ? worker.id : null;
  workerForm.reset();
  document.getElementById("worker-dialog-title").textContent = worker ? "Edit Worker" : "Add Worker";

  const f = workerForm.elements;
  if (worker) {
    f.name.value = worker.name || "";
    f.strength.value = worker.strength;
    workerQualInput.set(worker.qualifications || []);
    workerPhoto = worker.photo || "";
  } else {
    f.strength.value = 5;
    workerQualInput.set([]);
    workerPhoto = "";
  }
  updateStrengthOutput();
  renderWorkerPhoto();
  workerDialog.showModal();
}

async function saveWorker(event) {
  event.preventDefault();
  const saveBtn = document.getElementById("worker-save");
  const f = workerForm.elements;
  const payload = {
    name: f.name.value.trim(),
    strength: Number(f.strength.value),
    qualifications: workerQualInput.values,
    photo: workerPhoto || null,
  };

  saveBtn.disabled = true;
  saveBtn.textContent = "Saving\u2026";
  try {
    if (editingWorkerId) await WorkerAPI.update(editingWorkerId, payload);
    else await WorkerAPI.create(payload);
    workerDialog.close();
    await refreshWorkers();
    await loadWorkers();
    await refreshWork();
  } catch (err) {
    alert("Could not save: " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save";
  }
}

async function deleteWorker(worker) {
  if (!confirm(`Delete "${worker.name}"?`)) return;
  try {
    await WorkerAPI.remove(worker.id);
    await refreshWorkers();
    await loadWorkers();
    await refreshWork();
  } catch (err) {
    alert("Could not delete: " + err.message);
  }
}

async function refreshWorkers() {
  if (!workerList) return;
  try {
    allWorkers = await WorkerAPI.list();
    const fromWorkers = allWorkers.flatMap((w) => w.qualifications || []);
    qualificationNames = [...new Set([...qualificationNames, ...fromWorkers])]
      .sort((a, b) => a.localeCompare(b));
    renderWorkerList();
  } catch (err) {
    workerList.replaceChildren(el("div", { class: "empty" }, el("p", { class: "err", text: err.message })));
  }
}

function initWorkers() {
  if (!workerList) return;

  document.getElementById("add-worker").addEventListener("click", () => openWorkerDialog(null));
  document.getElementById("worker-cancel").addEventListener("click", () => workerDialog.close());
  workerForm.addEventListener("submit", saveWorker);
  workerForm.elements.strength.addEventListener("input", updateStrengthOutput);

  workerForm.elements.workerImage.addEventListener("change", async (event) => {
    const file = (event.target.files || [])[0];
    event.target.value = "";
    if (!file) return;
    const box = document.getElementById("worker-photo-preview");
    box.replaceChildren(el("span", { class: "empty-sub", text: "Uploading\u2026" }));
    try {
      const { url } = await WorkAPI.uploadImage(await fileToDataUrl(file));
      workerPhoto = url;
    } catch (err) {
      alert("Could not upload picture: " + err.message);
    }
    renderWorkerPhoto();
  });

  const search = document.getElementById("worker-search");
  if (search) {
    search.addEventListener("input", () => {
      workerQuery = search.value;
      renderWorkerList();
    });
  }

  workerDialog.addEventListener("click", (event) => {
    if (event.target !== workerDialog) return;
    const box = workerForm.getBoundingClientRect();
    const onBackdrop =
      event.clientX < box.left ||
      event.clientX > box.right ||
      event.clientY < box.top ||
      event.clientY > box.bottom;
    if (onBackdrop) workerForm.requestSubmit();
  });

  refreshWorkers();
}

/* ------------------------------------------------------------------ */
/* assignment meeting                                                  */
/* ------------------------------------------------------------------ */

const MeetingAPI = {
  list: () => api("/api/meetings"),
  create: (opts) =>
    api("/api/meetings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(opts || {}),
    }),
  get: (id) => api("/api/meetings/" + id),
  assign: (id) => api("/api/meetings/" + id + "/assign", { method: "POST" }),
  stats: (id) => api("/api/meetings/" + id + "/stats"),
  remove: (id) => api("/api/meetings/" + id, { method: "DELETE" }),
};

const meetingEmpty = document.getElementById("meeting-empty");
const meetingActive = document.getElementById("meeting-active");
const meetingQr = document.getElementById("meeting-qr");
const meetingLink = document.getElementById("meeting-link");
const meetingProgress = document.getElementById("meeting-progress");
const meetingCount = document.getElementById("meeting-count");
const meetingResults = document.getElementById("meeting-results");
const meetingMaxOut = document.getElementById("meeting-max-out");
const statsList = document.getElementById("stats-list");

let currentMeeting = null;
let meetingPoll = null;
let lastStats = null;

function meetingUrl(id) {
  return `${location.origin}/rate.html?session=${encodeURIComponent(id)}`;
}

function renderQr(container, text) {
  if (!container) return;
  container.replaceChildren();
  let qr;
  try {
    qr = QR.generate(text, "M");
  } catch (err) {
    container.append(el("p", { class: "err", text: "That link is too long to encode." }));
    return;
  }
  const quiet = 4;
  const total = qr.size + quiet * 2;
  const scale = Math.max(2, Math.floor(260 / total));
  const px = total * scale;
  const canvas = el("canvas", { class: "qr-canvas", width: px, height: px });
  const ctx = canvas.getContext("2d");
  ctx.fillStyle = "#ffffff";
  ctx.fillRect(0, 0, px, px);
  ctx.fillStyle = "#000000";
  for (let y = 0; y < qr.size; y++) {
    for (let x = 0; x < qr.size; x++) {
      if (qr.modules[y][x]) ctx.fillRect((x + quiet) * scale, (y + quiet) * scale, scale, scale);
    }
  }
  container.append(canvas);
}

function workerAvatar(worker, size) {
  if (worker.photo) {
    return el("div", { class: "worker-avatar" + (size ? " " + size : "") },
      el("img", { src: worker.photo, alt: worker.name }));
  }
  const initial = (worker.name || "?").trim().charAt(0).toUpperCase() || "?";
  return el("div", { class: "worker-avatar" + (size ? " " + size : ""), text: initial });
}

function renderMeetingProgress(meeting) {
  meetingProgress.replaceChildren();
  const workers = meeting.workers || [];
  const submitted = new Set(meeting.submitted || []);
  meetingCount.textContent = `${submitted.size}/${workers.length} rated`;

  if (!workers.length) {
    meetingProgress.append(el("p", { class: "empty-sub", text: "No workers yet." }));
    return;
  }

  workers.forEach((worker) => {
    const row = el("div", { class: "progress-row" + (submitted.has(worker.id) ? " done" : "") });
    row.append(workerAvatar(worker, "small"));
    row.append(el("span", { class: "progress-name", text: worker.name }));
    const rated = Object.keys((meeting.ratings || {})[worker.id] || {}).length;
    row.append(el("span", {
      class: "badge" + (submitted.has(worker.id) ? " done" : ""),
      text: submitted.has(worker.id) ? `${rated} rated` : "Waiting",
    }));
    meetingProgress.append(row);
  });
}

function renderMeetingResults(stats) {
  if (!meetingResults) return;
  if (!stats || !stats.length) {
    meetingResults.hidden = true;
    return;
  }
  meetingResults.hidden = false;
  meetingResults.replaceChildren(el("h3", { text: "Assignments" }));

  const list = el("div", { class: "assign-list" });
  stats.forEach((row) => {
    const item = el("div", { class: "assign-row" });
    item.append(el("span", { class: "assign-name", text: row.name }));
    item.append(
      el("span", {
        class: "badge " + (row.assignedTo ? "auto" : ""),
        text: row.assignedTo || "Unassigned",
      })
    );
    const desire = row.avgDesire == null ? "\u2014" : row.avgDesire.toFixed(1);
    item.append(el("span", { class: "assign-desire", text: `desire ${desire}` }));
    list.append(item);
  });
  meetingResults.append(list);
}

function renderMeeting() {
  const has = !!currentMeeting;
  meetingEmpty.hidden = has;
  meetingActive.hidden = !has;
  document.getElementById("meeting-new").hidden = !has;
  document.getElementById("meeting-assign").hidden = !has;
  if (!has) return;

  const url = meetingUrl(currentMeeting.id);
  meetingLink.href = url;
  meetingLink.textContent = url;
  renderQr(meetingQr, url);
  renderMeetingProgress(currentMeeting);
  renderMeetingResults(currentMeeting.status === "assigned" ? lastStats : null);
}

function stopMeetingPoll() {
  if (meetingPoll) {
    clearInterval(meetingPoll);
    meetingPoll = null;
  }
}

function startMeetingPoll() {
  stopMeetingPoll();
  meetingPoll = setInterval(async () => {
    if (!currentMeeting) return;
    try {
      const fresh = await MeetingAPI.get(currentMeeting.id);
      currentMeeting = fresh;
      renderMeeting();
    } catch (err) {
      /* keep polling quietly */
    }
  }, 3000);
}

async function refreshMeeting() {
  if (!currentMeeting) return;
  try {
    currentMeeting = await MeetingAPI.get(currentMeeting.id);
    if (currentMeeting.status === "assigned") {
      try {
        lastStats = (await MeetingAPI.stats(currentMeeting.id)).stats;
      } catch (err) {
        lastStats = null;
      }
    }
    renderMeeting();
  } catch (err) {
    currentMeeting = null;
    stopMeetingPoll();
    renderMeeting();
  }
}

async function startMeeting() {
  const btn = document.getElementById("meeting-start");
  btn.disabled = true;
  btn.textContent = "Starting\u2026";
  try {
    const meeting = await MeetingAPI.create({
      maxPerWorker: Number(document.getElementById("meeting-max").value),
    });
    currentMeeting = meeting;
    lastStats = null;
    renderMeeting();
    startMeetingPoll();
  } catch (err) {
    alert("Could not start meeting: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Start Meeting";
  }
}

async function runAssign() {
  if (!currentMeeting) return;
  if (!confirm("Auto-assign all the reviewed work now?")) return;
  const btn = document.getElementById("meeting-assign");
  btn.disabled = true;
  btn.textContent = "Assigning\u2026";
  try {
    const result = await MeetingAPI.assign(currentMeeting.id);
    lastStats = result.stats;
    await refreshMeeting();
    await refreshWork();
    await loadWorkers();
  } catch (err) {
    alert("Could not assign work: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Run Auto Assign";
  }
}

async function newMeeting() {
  if (currentMeeting) {
    if (!confirm("Discard this meeting and start a new one?")) return;
    try {
      await MeetingAPI.remove(currentMeeting.id);
    } catch (err) {
      /* ignore */
    }
  }
  currentMeeting = null;
  lastStats = null;
  stopMeetingPoll();
  renderMeeting();
}

function initMeeting() {
  if (!meetingEmpty) return;

  const maxSlider = document.getElementById("meeting-max");
  maxSlider.addEventListener("input", () => (meetingMaxOut.textContent = maxSlider.value));

  document.getElementById("meeting-start").addEventListener("click", startMeeting);
  document.getElementById("meeting-new").addEventListener("click", newMeeting);
  document.getElementById("meeting-assign").addEventListener("click", runAssign);

  const meetingTab = document.querySelector('.tab[data-tab="meeting"]');
  if (meetingTab) meetingTab.addEventListener("click", () => { if (currentMeeting) refreshMeeting(); });

  renderMeeting();
}

/* ------------------------------------------------------------------ */
/* stats                                                               */
/* ------------------------------------------------------------------ */

function renderStats(stats) {
  if (!statsList) return;
  statsList.replaceChildren();

  if (!stats || !stats.length) {
    statsList.append(
      el("div", { class: "empty" },
        el("p", { text: "No results yet." }),
        el("p", { class: "empty-sub", text: "Run an assignment meeting and the rankings will appear here." })
      )
    );
    return;
  }

  stats.forEach((row, index) => {
    const card = el("article", { class: "stat-row" });
    card.append(el("span", { class: "stat-rank", text: index + 1 }));

    const body = el("div", { class: "work-body" });
    body.append(el("div", { class: "work-heading" }, el("h3", { text: row.name })));

    const badges = el("div", { class: "badges" });
    const desire = row.avgDesire == null ? "\u2014" : row.avgDesire.toFixed(1);
    badges.append(el("span", { class: "badge", text: `Desire ${desire}` }));
    badges.append(el("span", { class: "badge", text: `Demand ${row.physicalDemand}/10` }));
    badges.append(
      el("span", { class: "badge " + (row.assignedTo ? "auto" : ""), text: row.assignedTo || "Unassigned" })
    );
    (row.qualifications || []).forEach((q) => badges.append(el("span", { class: "badge qual", text: q })));
    body.append(badges);

    if (row.ratings && row.ratings.length) {
      const chips = el("div", { class: "rating-chips" });
      row.ratings.forEach((entry) => {
        chips.append(el("span", { class: "rating-chip", text: `${entry.worker}: ${entry.score}` }));
      });
      body.append(chips);
    }

    card.append(body);
    statsList.append(card);
  });
}

async function loadStats() {
  if (!statsList) return;
  statsList.replaceChildren(el("div", { class: "empty" }, el("p", { class: "empty-sub", text: "Loading\u2026" })));
  try {
    const meetings = await MeetingAPI.list();
    const done = meetings.find((m) => m.status === "assigned");
    if (!done) {
      renderStats([]);
      return;
    }
    const { stats } = await MeetingAPI.stats(done.id);
    renderStats(stats);
  } catch (err) {
    statsList.replaceChildren(el("div", { class: "empty" }, el("p", { class: "err", text: err.message })));
  }
}

function initStats() {
  if (!statsList) return;
  const refresh = document.getElementById("stats-refresh");
  if (refresh) refresh.addEventListener("click", loadStats);
  const statsTab = document.querySelector('.tab[data-tab="stats"]');
  if (statsTab) statsTab.addEventListener("click", loadStats);
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

initTabs();
initLightbox();
initWorkPool();
initWorkers();
initMeeting();
initStats();
checkServer();
