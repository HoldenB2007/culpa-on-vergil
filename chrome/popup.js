// One-time install note: show it, then switch back to the plain popup for good
if (new URLSearchParams(location.search).has("welcome")) {
  document.getElementById("welcome").hidden = false;
  chrome.action.setPopup({ popup: "popup.html" });
}

// Status check
chrome.tabs.query({ active: true, currentWindow: true }, tabs => {
  const url = tabs[0]?.url || "";
  if (url.includes("vergil.columbia.edu") || url.includes("vergil.registrar.columbia.edu")) {
    const s = document.getElementById("status");
    s.className = "status active";
    s.innerHTML = '<div class="dot"></div><span>Active on this page</span>';
  }
});

// Cache clear
document.getElementById("clear").addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CULPA_CLEAR_CACHE" }, () => {
    const btn = document.getElementById("clear");
    btn.textContent = "Cache cleared ✓";
    btn.style.color = "#81c784";
    setTimeout(() => {
      btn.textContent = "Clear cached data (refresh ratings)";
      btn.style.color = "";
    }, 2000);
  });
});
