// content.js — Injected into Vergil. Finds instructor names and injects CULPA badges.

(function () {
  "use strict";

  const ATTR = "data-culpa";
  const KEY_ATTR = "data-culpa-key"; // which instructor the stamp belongs to —
  // Angular recycles elements (swaps text, keeps the node), so a bare ATTR
  // check would leave another instructor's badge on the reused element
  const FOR_ATTR = "data-culpa-for"; // on row badges: key of their wrapper
  const DEBOUNCE_MS = 250; // short: scans are cheap (attribute checks; network
  // only for genuinely new instructors) and dropdown recycling needs fast rescans

  /* ── Nugget config ───────────────────────────────────── */

  const NUGGETS = {
    Gold:   { emoji: "🥇", label: "Gold Nugget",   cls: "culpa-gold" },
    Silver: { emoji: "🥈", label: "Silver Nugget", cls: "culpa-silver" },
    Bronze: { emoji: "🥉", label: "Bronze Nugget", cls: "culpa-bronze" },
    None:   { emoji: "",   label: "",              cls: "" }
  };

  /* ── Messaging ───────────────────────────────────────── */

  function lookup(name, uni, first, last) {
    return new Promise(resolve => {
      try {
        chrome.runtime.sendMessage({ type: "CULPA_LOOKUP", name, uni, first, last }, r => {
          // Messaging failure (e.g. orphaned content script after an extension
          // reload) is an error, NOT a "not found" — never show a false miss
          if (chrome.runtime.lastError) resolve({ error: true });
          else resolve(r?.result ?? null);
        });
      } catch (_) {
        resolve({ error: true }); // "Extension context invalidated" throw
      }
    });
  }

  function extractUni(raw) {
    const m = raw.match(/\(([a-z]+\d+)\)/i);
    return m ? m[1].toLowerCase() : null;
  }

  // UNI from the wrapper's data-uni span (trusted only on a genuine instructor
  // wrapper — a loose parent may contain other instructors' UNIs), else from text
  function wrapperUni(wrapper, raw) {
    const attr = wrapper.matches("span.ins-display, span.instructor")
      ? wrapper.querySelector(".instructor-uni[data-uni]")?.getAttribute("data-uni")
      : null;
    return attr ? attr.toLowerCase() : extractUni(raw);
  }

  // Identity of an instructor rendering — used to detect element recycling
  function culpaKey(uni, name) {
    return uni || name.toLowerCase();
  }

  // Element text minus any badge we previously injected into it
  function textWithoutBadges(el) {
    let s = "";
    el.childNodes.forEach(n => {
      if (n.nodeType === Node.TEXT_NODE) s += n.textContent;
      else if (n.nodeType === Node.ELEMENT_NODE && !n.classList.contains("culpa-badge")) s += n.textContent;
    });
    return s;
  }

  function makeErrorBadge() {
    const badge = document.createElement("span");
    badge.className = "culpa-badge culpa-error";
    badge.textContent = "CULPA ?";
    badge.title = "Could not reach culpa.info";
    return badge;
  }

  function makeNotFoundBadge() {
    const badge = document.createElement("span");
    badge.className = "culpa-badge culpa-not-found";
    badge.innerHTML = `<span class="culpa-label">CULPA</span><span class="culpa-count">not found</span>`;
    return badge;
  }

  /* ── Shared tooltip (appended to body to escape parent opacity) ── */

  const tooltip = document.createElement("div");
  tooltip.className = "culpa-tooltip";
  document.body.appendChild(tooltip);

  function showTooltip(badge, html) {
    tooltip.innerHTML = html;
    tooltip.style.visibility = "hidden";
    tooltip.style.display = "block";
    // Measure after layout
    const rect = badge.getBoundingClientRect();
    let left = rect.left + rect.width / 2 - tooltip.offsetWidth / 2;
    left = Math.max(8, Math.min(left, window.innerWidth - tooltip.offsetWidth - 8));
    const top = rect.top - tooltip.offsetHeight - 10;
    tooltip.style.left = left + "px";
    tooltip.style.top  = top + "px";
    tooltip.style.visibility = "visible";
  }

  function hideTooltip() {
    tooltip.style.display = "none";
  }

  /* ── Badge creation ──────────────────────────────────── */

  // CULPA API data is third-party: escape it before it touches innerHTML,
  // or a crafted professor name would run script inside Vergil
  function esc(s) {
    return String(s ?? "").replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  function makeBadge(raw) {
    const data = {
      ...raw,
      avgRating:   Number.isFinite(Number(raw.avgRating)) && raw.avgRating != null ? Number(raw.avgRating) : null,
      reviewCount: Number(raw.reviewCount) || 0,
    };

    const badge = document.createElement("a");
    badge.className = "culpa-badge";
    badge.href = data.culpaUrl;
    badge.target = "_blank";
    badge.rel = "noopener";
    badge.addEventListener("click", e => e.stopPropagation());

    const nug = NUGGETS[data.nugget] || NUGGETS.None;
    if (nug.cls) badge.classList.add(nug.cls);

    let html = "";
    if (data.avgRating != null) html += `<span class="culpa-rating">${data.avgRating.toFixed(1)}</span>`;
    if (nug.emoji) html += `<span class="culpa-nugget">${nug.emoji}</span>`;
    html += `<span class="culpa-label">CULPA</span>`;

    if (data.reviewCount > 0) {
      html += `<span class="culpa-count">${data.reviewCount} review${data.reviewCount !== 1 ? "s" : ""}</span>`;
    } else {
      html += `<span class="culpa-count">0 reviews</span>`;
    }

    badge.innerHTML = html;

    if (data.reviewCount > 0) {
      let tipHTML = `
        <div class="culpa-tip-header">
          <strong>${esc(data.firstName)} ${esc(data.lastName)}</strong>
          ${nug.emoji ? `<span class="culpa-tip-nugget">${nug.emoji} ${nug.label}</span>` : ""}
        </div>
        ${data.avgRating != null ? `<div class="culpa-tip-rating"><span class="culpa-tip-rating-num">${data.avgRating.toFixed(1)}</span><span class="culpa-tip-rating-max"> / 5</span></div>` : ""}
        <div class="culpa-tip-stats">${data.reviewCount} review${data.reviewCount !== 1 ? "s" : ""} on CULPA</div>
      `;



      tipHTML += `<div class="culpa-tip-cta">Click box to view on CULPA</div>`;

      badge.addEventListener("mouseenter", () => showTooltip(badge, tipHTML));
      badge.addEventListener("mouseleave", hideTooltip);
    }

    return badge;
  }

  /* ── Name parsing ────────────────────────────────────── */

  const NAME_CONNECTORS = new Set([
    "de","di","von","van","el","al","la","le","du","da","dos","del","bin","ibn",
    "der","den","ten","ter","af","av","op","zum","zur","y","e","o"
  ]);

  // Vergil format: "Last, First  (uni)" → { name: "First Last", first, last }
  // first/last are only set when the comma form makes the split unambiguous
  // (handles multi-word last names like "De Jesus, Joey"); otherwise null and
  // the background falls back to splitting on the final word.
  function parseVergilName(raw) {
    // Strip UNI in parentheses e.g. " (lp2149)"
    let t = raw.trim().replace(/\s*\([^)]+\)\s*$/, "").trim();
    let first = null, last = null;

    // Convert "Last, First" → "First Last"
    if (/^[^,]+,\s*\S/.test(t)) {
      const commaIdx = t.indexOf(",");
      last  = t.slice(0, commaIdx).trim();
      first = t.slice(commaIdx + 1).trim();
      t = `${first} ${last}`;
    }

    return { name: t, first, last };
  }

  function isValidName(text) {
    if (!text || text.length < 4 || text.length > 80) return false;
    const words = text.split(/\s+/);
    if (words.length < 2 || words.length > 6) return false;
    return words.every(w =>
      /^\p{Lu}/u.test(w) ||                // Unicode uppercase (handles É, Ñ, Ö, etc.)
      NAME_CONNECTORS.has(w.toLowerCase()) ||
      /^[a-z]'\p{Lu}/u.test(w)             // d'Alembert, l'Hôpital style
    );
  }

  /* ── Vergil DOM scanning ─────────────────────────────── */

  // Instructor names anywhere on the page. Vergil renders every instructor
  // through one shared component:
  //   <span class="ins-display"><a>…<div class="text">Last, First </div>
  //     <span class="instructor-uni" data-uni="lg233"></span>…</a></span>
  // (The visible "(uni)" is CSS-generated from data-uni — not in the text.)
  // Legacy markup (span.instructor with the UNI in the text) is kept as a
  // fallback. div.text is generic Angular Material, so bare ones must look
  // instructor-shaped ("Last, First" or a "(uni)" in the text) to qualify.
  function findInstructorElements() {
    const found = [];
    document.querySelectorAll("div.text").forEach(textEl => {
      const raw = textEl.textContent || "";
      let wrapper = textEl.closest("span.ins-display, span.instructor");
      if (!wrapper) {
        // Bare div.text (no instructor wrapper): qualifies only with a "(uni)"
        // in its own text — comma form alone matches too much ("New York, NY")
        if (!/\([a-z]+\d+\)/i.test(raw)) return;
        wrapper = textEl.parentElement;
      }
      if (!wrapper) return;

      const hasUniAttr = !!wrapper.querySelector(".instructor-uni[data-uni]");
      if (!hasUniAttr &&
          !/^[^,]+,\s*\S/.test(raw.trim()) &&
          !/\([a-z]+\d+\)/i.test(raw)) return;
      const parsed = parseVergilName(raw);
      if (!isValidName(parsed.name)) return;

      // Skip only if the stamp belongs to THIS instructor (recycled elements
      // carry another instructor's stamp and must be re-processed)
      if (wrapper.getAttribute(ATTR) &&
          wrapper.getAttribute(KEY_ATTR) === culpaKey(wrapperUni(wrapper, raw), parsed.name)) return;

      found.push({ wrapper, textEl });
    });
    return found;
  }

  // Instructor autocomplete dropdown: mat-option containing a UNI pattern
  function findDropdownElements() {
    const found = [];
    document.querySelectorAll("mat-option").forEach(el => {
      const raw = textWithoutBadges(el);
      if (!/\([a-z]+\d+\)/i.test(raw)) return;
      // Re-process recycled mat-options whose text changed under our stamp
      if (el.getAttribute(ATTR) &&
          el.getAttribute(KEY_ATTR) === culpaKey(extractUni(raw), parseVergilName(raw).name)) return;
      found.push(el);
    });
    return found;
  }

  /* ── Process a single element ─────────────────────────── */

  async function processElement({ wrapper: el, textEl }) {
    const raw = textEl.textContent || "";
    const uni = wrapperUni(el, raw);
    const { name, first, last } = parseVergilName(raw);
    const key = culpaKey(uni, name);
    if (el.getAttribute(ATTR) && el.getAttribute(KEY_ATTR) === key) return;

    el.setAttribute(ATTR, "pending");
    el.setAttribute(KEY_ATTR, key);
    // Recycled element: drop the previous instructor's badge (our badge is
    // inserted as the wrapper's next sibling)
    if (el.nextElementSibling?.classList?.contains("culpa-badge")) {
      el.nextElementSibling.remove();
    }

    if (!isValidName(name)) {
      el.setAttribute(ATTR, "skip");
      return;
    }

    const data = await lookup(name, uni, first, last);
    // Element recycled to another instructor while we awaited — stale result
    if (el.getAttribute(KEY_ATTR) !== key) return;
    if (!data) {
      el.setAttribute(ATTR, "miss");
      insertRowBadge(el, makeNotFoundBadge(), key);
      return;
    }
    if (data.error) {
      el.setAttribute(ATTR, "error");
      insertRowBadge(el, makeErrorBadge(), key);
      return;
    }

    el.setAttribute(ATTR, "done");
    insertRowBadge(el, makeBadge(data), key);
  }

  // Row badges live OUTSIDE Angular's wrapper (as its next sibling), so
  // Angular never cleans them up. Tag each with the instructor it belongs to…
  function insertRowBadge(el, badge, key) {
    badge.classList.add("culpa-badge-row");
    badge.setAttribute(FOR_ATTR, key);
    el.insertAdjacentElement("afterend", badge);
  }

  // …and on every scan drop any whose wrapper is gone, re-rendered, or now
  // shows someone else — otherwise a stale badge sits under the wrong name
  function sweepOrphanBadges() {
    document.querySelectorAll(".culpa-badge-row").forEach(b => {
      const prev = b.previousElementSibling;
      if (!prev || prev.getAttribute(KEY_ATTR) !== b.getAttribute(FOR_ATTR)) b.remove();
    });
  }

  async function processDropdownElement(el) {
    const raw  = textWithoutBadges(el);
    const uni  = extractUni(raw);
    const { name, first, last } = parseVergilName(raw);
    const key  = culpaKey(uni, name);
    if (el.getAttribute(ATTR) && el.getAttribute(KEY_ATTR) === key) return;

    el.setAttribute(ATTR, "pending");
    el.setAttribute(KEY_ATTR, key);
    // Recycled element: drop the previous instructor's badge (appended inside)
    el.querySelectorAll(":scope > .culpa-badge").forEach(b => b.remove());

    if (!isValidName(name)) { el.setAttribute(ATTR, "skip"); return; }

    const data = await lookup(name, uni, first, last);
    // Element recycled to another instructor while we awaited — stale result
    if (el.getAttribute(KEY_ATTR) !== key) return;
    if (!data) {
      el.setAttribute(ATTR, "miss");
      el.appendChild(makeNotFoundBadge());
      return;
    }
    if (data.error) {
      el.setAttribute(ATTR, "error");
      el.appendChild(makeErrorBadge());
      return;
    }

    el.setAttribute(ATTR, "done");
    const badge = makeBadge(data);
    el.appendChild(badge);
  }

  /* ── Main scan loop ──────────────────────────────────── */

  async function scan() {
    sweepOrphanBadges();
    await Promise.allSettled([
      ...findInstructorElements().map(el => processElement(el)),
      ...findDropdownElements().map(el => processDropdownElement(el)),
    ]);
  }

  // Initial scan with a small delay to let Vergil render
  setTimeout(scan, 1000);

  // Watch for SPA navigation & dynamic content
  let timer;
  const observer = new MutationObserver(() => {
    clearTimeout(timer);
    timer = setTimeout(scan, DEBOUNCE_MS);
  });
  observer.observe(document.body, { childList: true, subtree: true });

})();
