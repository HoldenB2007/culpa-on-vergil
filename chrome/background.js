// background.js — Handles CULPA lookups from the content script.
// Uses the live culpa.info internal API (discovered from the SPA bundle).

const CULPA_BASE = "https://culpa.info";
const CACHE_TTL  = 1000 * 60 * 60 * 24; // 24 h

// Nugget values from culpa.info source: 0=None, 1=Bronze, 2=Silver, 3=Gold
const NUGGET_LABEL = { 0: "None", 1: "Bronze", 2: "Silver", 3: "Gold" };

// Nicknames that aren't plain prefixes of the formal name (those are handled
// generically). Lowercase nickname → formal forms.
const NICKNAMES = {
  mike: ["michael"], bob: ["robert"], bobby: ["robert"], bill: ["william"],
  billy: ["william"], dick: ["richard"], rick: ["richard"], ricky: ["richard"],
  jim: ["james"], jimmy: ["james"], jack: ["john"], ted: ["theodore", "edward"],
  tony: ["anthony"], andy: ["andrew"], drew: ["andrew"], joey: ["joseph"],
  kate: ["katherine", "kathryn", "catherine"], katie: ["katherine", "kathryn", "catherine"],
  kathy: ["katherine", "kathryn", "catherine"], liz: ["elizabeth"], beth: ["elizabeth"],
  betsy: ["elizabeth"], peggy: ["margaret"], meg: ["margaret"], maggie: ["margaret"],
  steve: ["stephen"], hank: ["henry"], harry: ["henry", "harold"], larry: ["lawrence"],
  gene: ["eugene"], chuck: ["charles"], gabe: ["gabriel"], abby: ["abigail"],
  becky: ["rebecca"], cindy: ["cynthia"], sandy: ["sandra"], mandy: ["amanda"],
  frank: ["francis"], terry: ["terence"], jerry: ["gerald", "jerome"],
  toby: ["tobias"], nate: ["nathaniel"]
};

/* ── Cache helpers (chrome.storage.local) ───────────────── */

async function cacheGet(key) {
  return new Promise(resolve => {
    chrome.storage.local.get(key, r => {
      const e = r[key];
      resolve(e && Date.now() - e.ts < CACHE_TTL ? e.data : null);
    });
  });
}

async function cacheSet(key, data) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: { data, ts: Date.now() } }, resolve);
  });
}

/* ── CULPA API lookup ────────────────────────────────────── */

async function searchProfessor(first, last, uni) {
  // The SPA calls /api/professor/search?queryString=...&maxResults=...
  const query = encodeURIComponent(`${first} ${last}`);
  const url = `${CULPA_BASE}/api/professor/search?queryString=${query}&maxResults=20`;
  // Let network/HTTP errors throw — caller distinguishes them from genuine misses
  const r = await fetch(url, { signal: AbortSignal.timeout(5000) });
  if (!r.ok) { console.error("[CULPA] search HTTP", r.status, url); throw new Error(`HTTP ${r.status}`); }
  const results = await r.json();
  if (!Array.isArray(results) || !results.length) return null;

  // CULPA sometimes collapses compound last names ("De Jesus" → "Dejesus"),
  // so last names compare with spaces/hyphens/apostrophes stripped; first
  // names keep spaces (the prefix tier relies on them) but treat hyphens
  // as spaces ("Mary-Ann" vs "Mary Ann")
  const normLast  = s => (s || "").toLowerCase().replace(/[\s'-]+/g, "");
  const normFirst = s => (s || "").toLowerCase().replace(/-/g, " ");
  const fl = normFirst(first);
  const ll = normLast(last);

  // 0. UNI match — exact and unambiguous, but CULPA's uni field is only
  //    partially populated, so the name tiers below remain as fallback
  if (uni) {
    const ul = uni.toLowerCase();
    const uniMatch = results.find(item =>
      item.professor_header.uni?.toLowerCase() === ul
    );
    if (uniMatch) return uniMatch.professor_header;
  }

  // 1. Exact match (full first name + last name)
  let match = results.find(item => {
    const ph = item.professor_header;
    return normFirst(ph.first_name) === fl &&
           normLast(ph.last_name)   === ll;
  });

  // 2. Partial first-name match — handles CULPA/Vergil storing different lengths
  //    e.g. Vergil "Mary Ann", CULPA "Mary" or vice versa
  if (!match) {
    const flFirst = fl.split(" ")[0];
    match = results.find(item => {
      const ph = item.professor_header;
      const phFirst = normFirst(ph.first_name);
      return normLast(ph.last_name) === ll &&
             (phFirst === flFirst ||
              phFirst.startsWith(flFirst + " ") ||
              fl.startsWith(phFirst + " "));
    });
  }

  // 2.5 Nickname / short-form first name — e.g. Vergil "Chris Murphy", CULPA
  //     "Christian Murphy". Generic rule: one first name is a prefix (≥3 chars)
  //     of the other; plus the NICKNAMES table for non-prefix pairs (Mike →
  //     Michael). Only when unambiguous (exactly 1 candidate with that last name).
  if (!match) {
    const flFirst = fl.split(" ")[0];
    const flAlts  = NICKNAMES[flFirst] || [];
    const cands = results.filter(item => {
      const ph = item.professor_header;
      if (normLast(ph.last_name) !== ll) return false;
      const phFirst = normFirst(ph.first_name).split(" ")[0];
      if (!phFirst || phFirst === flFirst) return false;
      const [shorter, longer] = flFirst.length <= phFirst.length
        ? [flFirst, phFirst] : [phFirst, flFirst];
      return (shorter.length >= 3 && longer.startsWith(shorter)) ||
             flAlts.includes(phFirst) ||
             (NICKNAMES[phFirst] || []).includes(flFirst);
    });
    if (cands.length === 1) match = cands[0];
  }

  // 3. Last-name-only — only when unambiguous (exactly 1 result with that last name)
  if (!match) {
    const lastMatches = results.filter(item =>
      normLast(item.professor_header.last_name) === ll
    );
    if (lastMatches.length === 1) match = lastMatches[0];
  }

  return match?.professor_header || null;
}

async function getProfessorCard(professorId) {
  try {
    const url = `${CULPA_BASE}/api/professor_page/card/${professorId}`;
    const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!r.ok) return null;
    const j = await r.json();
    return j.professor_summary || null;
  } catch (_) {
    return null;
  }
}

async function lookupCulpa(first, last, uni) {
  const prof = await searchProfessor(first, last, uni);
  if (!prof) return null;

  const card      = await getProfessorCard(prof.professor_id);
  const nuggetNum = prof.nugget ?? 0;
  const avgRating = card?.avg_rating ? Math.round(card.avg_rating * 10) / 10 : null;
  const reviewCount = card?.num_reviews || 0;

  return {
    id:          prof.professor_id,
    firstName:   prof.first_name,
    lastName:    prof.last_name,
    nugget:      NUGGET_LABEL[nuggetNum] || "None",
    nuggetNum,
    avgRating,
    reviewCount,
    culpaUrl:    `${CULPA_BASE}/professor/${prof.professor_id}`,
    source:      "culpa-api"
  };
}

/* ── Main lookup (with cache) ────────────────────────────── */

async function lookupProfessor(name, uni, first, last) {
  // "culpa2:" — v2 prefix invalidates pre-UNI-matching cache entries
  const key = uni ? `culpa2:uni:${uni}` : `culpa2:${name.toLowerCase().trim()}`;
  const cached = await cacheGet(key);
  if (cached) return cached;

  // Content script sends an explicit first/last split when Vergil's
  // "Last, First" comma form made it unambiguous (multi-word last names
  // like "De Jesus"). Otherwise split on the final word, keeping compound
  // first names e.g. "Mary Ann" intact.
  if (!first || !last) {
    const parts = name.trim().split(/\s+/);
    if (parts.length < 2) return null;
    first = parts.slice(0, -1).join(" ");
    last  = parts[parts.length - 1];
  }

  let result;
  try {
    result = await lookupCulpa(first, last, uni);
  } catch (err) {
    console.error("[CULPA] fetch failed:", err?.message || err);
    return { error: true }; // API down / network failure — don't cache
  }

  if (result) {
    console.log("[CULPA] found:", name, uni || "", "→", result.firstName, result.lastName, result.avgRating, `(${result.reviewCount} reviews)`);
    await cacheSet(key, result);
  } else {
    console.log("[CULPA] no match:", JSON.stringify({ name, uni, first, last }));
  }
  return result;
}

/* ── First-install onboarding ───────────────────────────── */

// Fresh install only (not updates/reloads): pop the normal popup open once
// with a one-time "pin me" note. popup.js resets to the plain popup the first
// time it's shown, so the note never appears again.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== chrome.runtime.OnInstalledReason.INSTALL) return;
  await chrome.action.setPopup({ popup: "popup.html?welcome=1" });
  try {
    await chrome.action.openPopup(); // Chrome 127+; anchors to the toolbar
  } catch (_) {
    // Couldn't auto-open (older Chrome / no focused window) — the note will
    // show the first time the user opens the popup themselves instead
  }
});

/* ── Message handler ────────────────────────────────────── */

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === "CULPA_LOOKUP") {
    lookupProfessor(msg.name, msg.uni, msg.first, msg.last).then(result => sendResponse({ result }));
    return true;
  }
  if (msg.type === "CULPA_CLEAR_CACHE") {
    chrome.storage.local.clear(() => sendResponse({ ok: true }));
    return true;
  }
});

