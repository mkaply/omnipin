"use strict";

const PROTECT_KEY = "addressBarProtection";
const ORIGINS = { origins: ["<all_urls>"] };

const checkbox = document.getElementById("abp");
const status = document.getElementById("status");

function setStatus(msg) { status.textContent = msg || ""; }

// Reflect the true state: enabled only if both the setting and the permission hold.
async function refresh() {
  const data = await browser.storage.local.get(PROTECT_KEY);
  const granted = await browser.permissions.contains(ORIGINS);
  checkbox.checked = data[PROTECT_KEY] === true && granted;
}

checkbox.addEventListener("change", async () => {
  setStatus("");
  if (checkbox.checked) {
    // permissions.request() must run inside this user-gesture handler.
    let granted = false;
    try {
      granted = await browser.permissions.request(ORIGINS);
    } catch (e) {
      granted = false;
    }
    if (!granted) {
      checkbox.checked = false;
      await browser.storage.local.set({ [PROTECT_KEY]: false });
      setStatus("Permission declined — address bar protection stays off.");
      return;
    }
    await browser.storage.local.set({ [PROTECT_KEY]: true });
    setStatus("Address bar protection is on.");
  } else {
    await browser.storage.local.set({ [PROTECT_KEY]: false });
    // Give the permission back; we don't need all-sites access when it's off.
    try { await browser.permissions.remove(ORIGINS); } catch (e) { /* ignore */ }
    setStatus("Address bar protection is off.");
  }
});

// Clear saved pins — two-click confirm (native confirm() is unreliable in the
// embedded options iframe).
const clearBtn = document.getElementById("clear");
let armed = false;
let armTimer = null;
clearBtn.addEventListener("click", async () => {
  if (!armed) {
    armed = true;
    clearBtn.textContent = "Click again to clear";
    setStatus("This forgets every saved pin.");
    armTimer = setTimeout(() => { armed = false; clearBtn.textContent = "Clear"; setStatus(""); }, 4000);
    return;
  }
  clearTimeout(armTimer);
  armed = false;
  clearBtn.textContent = "Clear";
  await browser.runtime.sendMessage({ type: "clearPins" });
  setStatus("Saved pins cleared.");
});

refresh();
