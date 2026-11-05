// background.js — Handles CULPA lookups from the content script.
// Uses the live culpa.info internal API (discovered from the SPA bundle).

const CULPA_BASE = "https://culpa.info";
const CACHE_TTL  = 1000 * 60 * 60 * 24; // 24 h — found professors
const MISS_TTL   = 1000 * 60 * 60 * 6;  // 6 h — "not found" (new faculty get added)
const CACHE_PREFIX = "culpa3:";          // bump when matching rules change

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
      const ttl = e?.data?.notFound ? MISS_TTL : CACHE_TTL;
      resolve(e && Date.now() - e.ts < ttl ? e.data : null);
    });
  });
}

async function cacheSet(key, data) {
  return new Promise(resolve => {
    chrome.storage.local.set({ [key]: { data, ts: Date.now() } }, resolve);
  });
}

// Remove only our cache entries ("culpa…" keys), never other stored state
function removeCacheKeys(filter = () => true) {
  return new Promise(resolve => {
    chrome.storage.local.get(null, all => {
      const keys = Object.keys(all).filter(k => k.startsWith("culpa") && filter(k));
      if (!keys.length) return resolve();
      chrome.storage.local.remove(keys, resolve);
    });
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
  const ul = uni ? uni.toLowerCase() : null;
  if (ul) {
    const uniMatch = results.find(item =>
      item.professor_header.uni?.toLowerCase() === ul
    );
    if (uniMatch) return uniMatch.professor_header;
  }

  // A candidate whose CULPA uni is set and differs from Vergil's is a
  // different person, however well the name matches — drop it
  const pool = results.filter(item => {
    const pu = item.professor_header.uni?.toLowerCase();
    return !(ul && pu && pu !== ul);
  });

  // 1. Exact match (full first name + last name)
  let match = pool.find(item => {
    const ph = item.professor_header;
    return normFirst(ph.first_name) === fl &&
           normLast(ph.last_name)   === ll;
  });

  // 2. Partial first-name match — handles CULPA/Vergil storing different lengths
  //    e.g. Vergil "Mary Ann", CULPA "Mary" or vice versa. Only when
  //    unambiguous ("Mary" vs CULPA "Mary Ann" + "Mary Beth" → no match)
  if (!match) {
    const flFirst = fl.split(" ")[0];
    const cands = pool.filter(item => {
      const ph = item.professor_header;
      const phFirst = normFirst(ph.first_name);
      return normLast(ph.last_name) === ll &&
             (phFirst === flFirst ||
              phFirst.startsWith(flFirst + " ") ||
              fl.startsWith(phFirst + " "));
    });
    if (cands.length === 1) match = cands[0];
  }

  // 2.5 Nickname / short-form first name — e.g. Vergil "Chris Murphy", CULPA
  //     "Christian Murphy". Generic rule: one first name is a prefix (≥3 chars)
  //     of the other; plus the NICKNAMES table for non-prefix pairs (Mike →
  //     Michael). Only when unambiguous (exactly 1 candidate with that last name).
  if (!match) {
    const flFirst = fl.split(" ")[0];
    const flAlts  = NICKNAMES[flFirst] || [];
    const cands = pool.filter(item => {
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

  // 3. Last name + first initial — only when unambiguous (exactly 1 result
  //    with that last name) and the first initial agrees, so a new lecturer
  //    "Sarah Klein" never inherits CULPA's only "Robert Klein"
  if (!match) {
    const lastMatches = pool.filter(item =>
      normLast(item.professor_header.last_name) === ll
    );
    if (lastMatches.length === 1 &&
        normFirst(lastMatches[0].professor_header.first_name)[0] === fl[0]) {
      match = lastMatches[0];
    }
  }

  return match?.professor_header || null;
}

// Throws on network/HTTP/parse failure so the caller reports an error
// (not cached, retried later) instead of caching a bogus "0 reviews"
async function getProfessorCard(professorId) {
  const url = `${CULPA_BASE}/api/professor_page/card/${professorId}`;
  const r = await fetch(url, { signal: AbortSignal.timeout(4000) });
  if (!r.ok) { console.error("[CULPA] card HTTP", r.status, url); throw new Error(`HTTP ${r.status}`); }
  const j = await r.json();
  // A card with no summary is a real (empty) professor page, not a failure
  return j?.professor_summary || {};
}

async function lookupCulpa(first, last, uni) {
  const prof = await searchProfessor(first, last, uni);
  if (!prof) return null;

  const card      = await getProfessorCard(prof.professor_id);
  const nuggetNum = prof.nugget ?? 0;
  const avgRating = card.avg_rating ? Math.round(card.avg_rating * 10) / 10 : null;
  const reviewCount = card.num_reviews || 0;

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

// In-flight lookups by cache key: a professor teaching 10 sections on one
// page triggers one API round trip, not 10
const inflight = new Map();

function lookupProfessor(name, uni, first, last) {
  const key = uni ? `${CACHE_PREFIX}uni:${uni}` : `${CACHE_PREFIX}${name.toLowerCase().trim()}`;
  if (!inflight.has(key)) {
    inflight.set(key, doLookup(key, name, uni, first, last)
      .finally(() => inflight.delete(key)));
  }
  return inflight.get(key);
}

async function doLookup(key, name, uni, first, last) {
  const cached = await cacheGet(key);
  if (cached) return cached.notFound ? null : cached;

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
    await cacheSet(key, { notFound: true }); // shorter MISS_TTL applies
  }
  return result;
}

/* ── First-install onboarding ───────────────────────────── */

// Fresh install only (not updates/reloads): pop the normal popup open once
// with a one-time "pin me" note. popup.js resets to the plain popup the first
// time it's shown, so the note never appears again.
chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === chrome.runtime.OnInstalledReason.UPDATE) {
    removeCacheKeys(k => !k.startsWith(CACHE_PREFIX)); // old-prefix leftovers
    return;
  }
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
    removeCacheKeys().then(() => sendResponse({ ok: true }));
    return true;
  }
});

