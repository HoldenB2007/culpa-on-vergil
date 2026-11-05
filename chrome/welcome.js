// welcome.js — First-install onboarding page. Shows live pin status.

const statusEl = document.getElementById("pin-status");
const textEl   = document.getElementById("pin-text");
const stepEl   = document.getElementById("pin-step");
const numEl    = document.getElementById("pin-num");

function render(pinned) {
  statusEl.hidden = false;
  statusEl.className = "status " + (pinned ? "pinned" : "waiting");
  textEl.textContent = pinned ? "Pinned. You're all set" : "Not pinned yet";
  stepEl.classList.toggle("done", pinned);
  numEl.textContent = pinned ? "✓" : "1";
}

async function check() {
  try {
    const s = await chrome.action.getUserSettings(); // Chrome 91+
    render(!!s.isOnToolbar);
  } catch (_) {
    // API unavailable: leave the status chip hidden, instructions still apply
  }
}

check();
// Instant updates on Chrome 130+; polling covers older versions
chrome.action.onUserSettingsChanged?.addListener(s => render(!!s.isOnToolbar));
setInterval(check, 1500);
