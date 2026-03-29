/**
 * popup.js — Extension popup UI logic
 * Handles API key save/clear and visibility toggle.
 */

const apiKeyInput = document.getElementById("api-key");
const saveBtn = document.getElementById("save-btn");
const clearBtn = document.getElementById("clear-btn");
const statusEl = document.getElementById("status");
const toggleBtn = document.getElementById("toggle-visibility");

// Load existing key on open
chrome.runtime.sendMessage({ type: "GET_API_KEY" }, (response) => {
  if (response?.apiKey) {
    apiKeyInput.value = response.apiKey;
    showStatus("API key loaded.", false);
  }
});

// Save key
saveBtn.addEventListener("click", () => {
  const key = apiKeyInput.value.trim();
  if (!key) {
    showStatus("Please enter an API key.", true);
    return;
  }
  chrome.runtime.sendMessage({ type: "SAVE_API_KEY", apiKey: key }, (response) => {
    if (response?.success) {
      showStatus("API key saved.", false);
    } else {
      showStatus("Failed to save key.", true);
    }
  });
});

// Clear key
clearBtn.addEventListener("click", () => {
  apiKeyInput.value = "";
  chrome.runtime.sendMessage({ type: "SAVE_API_KEY", apiKey: "" }, () => {
    showStatus("API key cleared.", false);
  });
});

// Toggle visibility
toggleBtn.addEventListener("click", () => {
  const isPassword = apiKeyInput.type === "password";
  apiKeyInput.type = isPassword ? "text" : "password";
  toggleBtn.textContent = isPassword ? "Hide" : "Show";
});

function showStatus(msg, isError) {
  statusEl.textContent = msg;
  statusEl.className = "status" + (isError ? " error" : "");
  setTimeout(() => { statusEl.textContent = ""; }, 3000);
}
