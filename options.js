"use strict";

const DEFAULTS = {
  global: true,
  loadInBackground: true,
  openAtHome: true,
  protectFromClose: true,
  addressBarProtection: false,
};
const ORIGINS = { origins: ["<all_urls>"] };

const status = document.getElementById("status");
function setStatus(msg) { status.textContent = msg || ""; }

// ---- Behavior toggles ------------------------------------------------------

const PLAIN = ["global", "loadInBackground", "openAtHome", "protectFromClose"];

async function refreshToggles() {
  const data = await browser.storage.local.get(Object.keys(DEFAULTS));
  for (const k of PLAIN) {
    document.getElementById(k).checked = (k in data) ? data[k] !== false : DEFAULTS[k];
  }
  const granted = await browser.permissions.contains(ORIGINS);
  document.getElementById("addressBarProtection").checked = data.addressBarProtection === true && granted;
}

for (const k of PLAIN) {
  document.getElementById(k).addEventListener("change", (e) => {
    browser.storage.local.set({ [k]: e.target.checked });
    setStatus("Saved.");
  });
}

const abp = document.getElementById("addressBarProtection");
abp.addEventListener("change", async () => {
  setStatus("");
  if (abp.checked) {
    let granted = false;
    try { granted = await browser.permissions.request(ORIGINS); } catch (e) { granted = false; }
    if (!granted) {
      abp.checked = false;
      await browser.storage.local.set({ addressBarProtection: false });
      setStatus("Permission declined — left off.");
      return;
    }
    await browser.storage.local.set({ addressBarProtection: true });
    setStatus("Keeping pins on their page.");
  } else {
    await browser.storage.local.set({ addressBarProtection: false });
    try { await browser.permissions.remove(ORIGINS); } catch (e) { /* ignore */ }
    setStatus("Saved.");
  }
});

// ---- Manage pins -----------------------------------------------------------

const listEl = document.getElementById("pins");
const emptyEl = document.getElementById("pinsEmpty");

function faviconFor(p) {
  return p.favIconUrl || "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='16' height='16'%3E%3Crect width='16' height='16' rx='3' fill='%23999'/%3E%3C/svg%3E";
}

function btn(label, title, cls, onClick) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = label;
  if (title) b.title = title;
  if (cls) b.className = cls;
  b.addEventListener("click", onClick);
  return b;
}

async function renderPins() {
  const pins = (await browser.runtime.sendMessage({ type: "listPins" })) || [];
  listEl.textContent = "";
  emptyEl.hidden = pins.length > 0;

  pins.forEach((p, i) => {
    const li = document.createElement("li");
    li.className = "pin";

    const img = document.createElement("img");
    img.src = faviconFor(p);
    img.onerror = () => { img.src = faviconFor({}); };

    const meta = document.createElement("div");
    meta.className = "meta";
    const title = document.createElement("div");
    title.className = "ptitle";
    title.textContent = p.title || p.url;
    const url = document.createElement("input");
    url.className = "purl";
    url.type = "text";
    url.value = p.url;
    url.spellcheck = false;
    const commit = async () => {
      if (url.value === p.url) return;
      const res = await browser.runtime.sendMessage({ type: "updatePinUrl", pinId: p.pinId, url: url.value.trim() });
      if (res && res.ok) { p.url = url.value.trim(); setStatus("Pin URL updated."); }
      else { setStatus("That URL can't be used (needs http/https)."); url.value = p.url; }
    };
    url.addEventListener("change", commit);
    url.addEventListener("keydown", (e) => { if (e.key === "Enter") url.blur(); });
    meta.append(title, url);

    const up = btn("↑", "Move up", "", () => move(pins, i, i - 1));
    up.disabled = i === 0;
    const down = btn("↓", "Move down", "", () => move(pins, i, i + 1));
    down.disabled = i === pins.length - 1;
    const rm = btn("Remove", "Remove this pin everywhere", "rm", async () => {
      await browser.runtime.sendMessage({ type: "removePin", pinId: p.pinId });
      setStatus("Pin removed.");
      renderPins();
    });

    li.append(img, meta, up, down, rm);
    listEl.append(li);
  });
}

async function move(pins, from, to) {
  if (to < 0 || to >= pins.length) return;
  const order = pins.map((p) => p.pinId);
  const [moved] = order.splice(from, 1);
  order.splice(to, 0, moved);
  await browser.runtime.sendMessage({ type: "reorderPins", order });
  renderPins();
}

// Keep the list fresh if pins change elsewhere (pinning/unpinning a tab).
browser.storage.onChanged.addListener((changes, area) => {
  if (area === "local" && "pinnedTabs" in changes) renderPins();
});

// ---- Clear saved pins (two-click confirm) ----------------------------------

const clearBtn = document.getElementById("clear");
let armed = false;
let armTimer = null;
clearBtn.addEventListener("click", async () => {
  if (!armed) {
    armed = true;
    clearBtn.textContent = "Click again to clear";
    setStatus("This forgets every saved pin.");
    armTimer = setTimeout(() => { armed = false; clearBtn.textContent = "Clear saved pins"; setStatus(""); }, 4000);
    return;
  }
  clearTimeout(armTimer);
  armed = false;
  clearBtn.textContent = "Clear saved pins";
  await browser.runtime.sendMessage({ type: "clearPins" });
  setStatus("Saved pins cleared.");
  renderPins();
});

refreshToggles();
renderPins();
