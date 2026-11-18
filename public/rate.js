/* Worker rating page. Opened by scanning the meeting QR code. */

function el(tag, attrs = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value == null || value === false) continue;
    if (key === "class") node.className = value;
    else if (key === "text") node.textContent = value;
    else if (key.startsWith("on") && typeof value === "function") node.addEventListener(key.slice(2), value);
    else if (value === true) node.setAttribute(key, "");
    else node.setAttribute(key, value);
  }
  for (const child of children) {
    if (child == null) continue;
    node.append(child.nodeType ? child : document.createTextNode(child));
  }
  return node;
}

async function api(path, options) {
  const res = await fetch(path, options);
  let data = null;
  try {
    data = await res.json();
  } catch (err) {
    data = null;
  }
  if (!res.ok) throw new Error((data && data.error) || `Request failed (${res.status})`);
  return data;
}

const pickSection = document.getElementById("rate-pick");
const itemsSection = document.getElementById("rate-items");
const doneSection = document.getElementById("rate-done");
const errorSection = document.getElementById("rate-error");
const pickerEl = document.getElementById("worker-picker");
const itemList = document.getElementById("item-list");
const whoEl = document.getElementById("rate-who");

const sessionId = new URLSearchParams(location.search).get("session");

let meeting = null;
let worker = null;
let scores = new Map();

function show(section) {
  [pickSection, itemsSection, doneSection, errorSection].forEach((s) => {
    if (s) s.hidden = s !== section;
  });
}

function fail(message) {
  document.getElementById("rate-error-msg").textContent = message;
  show(errorSection);
}

function initials(name) {
  return (name || "?").trim().charAt(0).toUpperCase() || "?";
}

function needsMet(w, item) {
  const have = new Set(w.qualifications || []);
  return (item.qualifications || []).every((q) => have.has(q));
}

function shuffle(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
  return array;
}

function pickItems(w) {
  const max = meeting.maxPerWorker || 5;
  const fits = meeting.work.filter((item) => needsMet(w, item));
  const rest = meeting.work.filter((item) => !needsMet(w, item));
  return shuffle(fits).concat(shuffle(rest)).slice(0, max);
}

function renderPicker() {
  pickerEl.replaceChildren();
  const workers = meeting.workers || [];
  if (!workers.length) {
    fail("There are no workers in this meeting yet.");
    return;
  }
  workers.forEach((w) => {
    const btn = el("button", { class: "picker-btn", type: "button" });
    if (w.photo) {
      btn.append(el("span", { class: "worker-avatar small" }, el("img", { src: w.photo, alt: w.name })));
    } else {
      btn.append(el("span", { class: "worker-avatar small", text: initials(w.name) }));
    }
    btn.append(el("span", { class: "picker-name", text: w.name }));
    btn.addEventListener("click", () => chooseWorker(w));
    pickerEl.append(btn);
  });
}

function chooseWorker(w) {
  worker = w;
  whoEl.textContent = w.name;
  const prior = (meeting.ratings || {})[w.id] || {};
  const items = pickItems(w);
  scores = new Map();

  itemList.replaceChildren();
  if (!items.length) {
    itemList.append(el("p", { class: "empty-sub", text: "No work to review right now." }));
  }

  items.forEach((item) => {
    const value = prior[item.id] != null ? prior[item.id] : 5;
    scores.set(item.id, value);

    const card = el("div", { class: "rate-item" });
    const head = el("div", { class: "rate-item-head" });
    head.append(el("h3", { text: item.name }));
    if (item.group) head.append(el("span", { class: "badge group", text: item.group }));
    head.append(el("span", { class: "badge", text: `Demand ${item.physicalDemand}/10` }));
    card.append(head);

    if ((item.qualifications || []).length) {
      const badges = el("div", { class: "badges" });
      item.qualifications.forEach((q) => badges.append(el("span", { class: "badge qual", text: q })));
      card.append(badges);
    }

    const out = el("output", { class: "rate-value", text: value });
    const slider = el("input", {
      type: "range",
      min: "0",
      max: "10",
      step: "1",
      value: String(value),
      class: "rate-slider",
    });
    slider.addEventListener("input", () => {
      scores.set(item.id, Number(slider.value));
      out.textContent = slider.value;
    });
    card.append(el("div", { class: "rate-control" }, slider, out));
    itemList.append(card);
  });

  show(itemsSection);
}

async function submit() {
  const btn = document.getElementById("rate-submit");
  btn.disabled = true;
  btn.textContent = "Sending\u2026";
  try {
    const ratings = {};
    scores.forEach((v, k) => (ratings[k] = v));
    await api(`/api/meetings/${sessionId}/ratings`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ workerId: worker.id, ratings }),
    });
    show(doneSection);
  } catch (err) {
    alert("Could not send ratings: " + err.message);
  } finally {
    btn.disabled = false;
    btn.textContent = "Submit ratings";
  }
}

async function init() {
  if (!sessionId) {
    fail("No meeting was specified. Please scan the QR code again.");
    return;
  }
  try {
    meeting = await api("/api/meetings/" + encodeURIComponent(sessionId));
  } catch (err) {
    fail("Could not load this meeting: " + err.message);
    return;
  }
  if (meeting.status === "assigned") {
    fail("This meeting has already been assigned. Ask your host for a new code.");
    return;
  }
  renderPicker();
  show(pickSection);
}

document.getElementById("rate-back").addEventListener("click", () => show(pickSection));
document.getElementById("rate-submit").addEventListener("click", submit);
document.getElementById("rate-again").addEventListener("click", () => show(pickSection));

init();
