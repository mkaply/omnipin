"use strict";

const status = document.getElementById("status");

document.getElementById("restore").addEventListener("click", async () => {
  status.textContent = "Restoring…";
  try {
    // currentWindow in a browser_action popup = the window the button is in.
    const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
    await browser.runtime.sendMessage({ type: "restore", windowId: tab && tab.windowId });
    status.textContent = "Pins restored.";
    setTimeout(() => window.close(), 600);
  } catch (e) {
    status.textContent = "Couldn't restore.";
  }
});

document.getElementById("settings").addEventListener("click", () => {
  browser.runtime.openOptionsPage();
  window.close();
});
