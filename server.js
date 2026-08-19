// SupplierScout — server.js — v1.6.0
// Changelog v1.6.0:
//   - /api/search accepts excludeNames[] (sent by "Search More Sources"): already-found
//     suppliers are injected into the prompt as a DO-NOT-RETURN list, so follow-up searches
//     spend their result budget on NEW companies instead of re-finding the same top hits.
//   - Grounding sources: Gemini's groundingMetadata (the actual web pages it consulted) is
//     now extracted and returned as groundingSources[] — real evidence URLs, not discarded.
//   - Location rescue (company mode): suppliers that would be dropped for an unknown/
//     unclassifiable location are batched into one gemini-2.5-flash-lite lookup that resolves
//     their HQ; any that then pass the geo filters are recovered instead of silently lost.
//   - thinkingConfig.thinkingBudget=4096 on 2.5-family models so reasoning tokens stop eating
//     the 16384 maxOutputTokens budget (a cause of empty responses / follow-up calls).
//   - Empty-response follow-up call now sets responseMimeType application/json (allowed there
//     because the follow-up drops the googleSearch tool).
//   - /api/email no longer runs search grounding (emails don't need live web search) and uses
//     JSON response mode — faster, cheaper, more reliable parsing.
//   - callClaude() now has a 30s abort timeout (same Railway-edge hang protection Gemini has).
//   - isSelfOrSubsidiary() rewritten: token-based matching instead of raw substring. Target
//     "Ford" no longer excludes "Ford Meter Box"; "Walmart de Mexico" is still excluded for
//     target "Walmart" via corporate-suffix / geo-marker token analysis.
// Changelog v1.5.6:
//   - geminiFetch(): per-status retry budget. 503 "high demand" now retries once (400ms) then
//     falls through to the next model, instead of burning ~2s of backoff on a model that's down.
//     429/500 keep their 2-retry backoff. This cuts worst-case dead time when 2.5-pro is throttled.
//   - geminiFetch(): added a 30s per-call abort timeout so a single hung Gemini request aborts
//     and falls through, rather than running long enough for Railway's edge to return an HTML
//     timeout page (the root cause of the frontend "Unexpected token '<'" crash).
// Changelog v1.5.5:
//   - Removed dead gemini-1.5-flash (Google retired all 1.5 models; returns HTTP 404).
//   - New Gemini cascade: 2.5-pro -> 2.5-flash -> 2.5-flash-lite -> 3.5-flash -> Claude Haiku.
//   - Added geminiFetch() retry-with-backoff on transient 429/500/503 ("high demand") errors.
//   - Refactored /api/search provider section into a single loop over GEMINI_MODELS.
const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;
const APP_VERSION = 'v1.6.0';

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── JSON parser (shared) ───────────────────────────────────────────────────
function parseJSON(text) {
  text = text.replace(/```json[\s\S]*?```/g, m => m.slice(7, -3))
             .replace(/```[\s\S]*?```/g, m => m.slice(3, -3))
             .trim();
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');

  const firstBracket = text.indexOf('[');
  const firstBrace   = text.indexOf('{');
  if (firstBracket === -1 && firstBrace === -1)
    throw new Error('No JSON found in response. Raw text: ' + text.substring(0, 300));

  const isArray = firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace);
  const openChar  = isArray ? '[' : '{';
  const closeChar = isArray ? ']' : '}';
  const start = isArray ? firstBracket : firstBrace;

  let depth = 0, inString = false, escape = false, end = -1;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (escape) { escape = false; continue; }
    if (ch === '\\') { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === openChar)  depth++;
    if (ch === closeChar) { depth--; if (depth === 0) { end = i; break; } }
  }

  if (end === -1) throw new Error('Malformed JSON: no matching closing bracket');
  return JSON.parse(text.slice(start, end + 1));
}

// ── Geography filter ──────────────────────────────────────────────────────
const US_STATES = new Set([
  'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
  'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
  'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
  'VA','WA','WV','WI','WY','DC',
  'ALABAMA','ALASKA','ARIZONA','ARKANSAS','CALIFORNIA','COLORADO','CONNECTICUT',
  'DELAWARE','FLORIDA','GEORGIA','HAWAII','IDAHO','ILLINOIS','INDIANA','IOWA',
  'KANSAS','KENTUCKY','LOUISIANA','MAINE','MARYLAND','MASSACHUSETTS','MICHIGAN',
  'MINNESOTA','MISSISSIPPI','MISSOURI','MONTANA','NEBRASKA','NEVADA','NEW HAMPSHIRE',
  'NEW JERSEY','NEW MEXICO','NEW YORK','NORTH CAROLINA','NORTH DAKOTA','OHIO',
  'OKLAHOMA','OREGON','PENNSYLVANIA','RHODE ISLAND','SOUTH CAROLINA','SOUTH DAKOTA',
  'TENNESSEE','TEXAS','UTAH','VERMONT','VIRGINIA','WASHINGTON','WEST VIRGINIA',
  'WISCONSIN','WYOMING','UNITED STATES','USA','U.S.A','U.S'
]);

function isUSLocation(location) {
  if (!location || location === 'N/A' || location === 'Unknown') return false;
  const upper = location.toUpperCase();
  const parts = upper.split(',').map(p => p.trim());
  const last = parts[parts.length - 1];
  return US_STATES.has(last);
}

const JUNK_NAMES = ['vertex ai search', 'google search', 'web search', 'search results',
  'thomasnet search', 'bing search', 'yahoo search', 'duckduckgo', 'no specific company',
  'alibaba search result', 'globalsources search result', 'kompass search result',
  'search result', 'no company name', 'not provided', 'various suppliers'];

function isJunkSupplier(s) {
  const name = (s.name || '').toLowerCase().trim();
  if (!name) return true;
  if (JUNK_NAMES.some(j => name.includes(j))) return true;
  if (/search result/i.test(name)) return true;
  if (/no (specific|company|name)/i.test(name)) return true;
  return false;
}

const FOREIGN_INDICATORS = [
  'china', 'taiwan', 'germany', 'japan', 'korea', 'india', 'uk', 'united kingdom',
  'england', 'france', 'italy', 'spain', 'mexico', 'canada', 'australia', 'brazil',
  'poland', 'czech', 'sweden', 'netherlands', 'belgium', 'switzerland', 'austria',
  'turkey', 'indonesia', 'vietnam', 'thailand', 'malaysia', 'singapore', 'hong kong',
  'israel', 'uae', 'dubai', 'russia', 'ukraine', 'portugal', 'denmark', 'finland',
  'norway', 'hungary', 'romania', 'slovakia', 'croatia', 'serbia', 'bulgaria',
  'shandong', 'guangdong', 'zhejiang', 'jiangsu', 'fujian', 'hangzhou', 'shenzhen',
  'shanghai', 'beijing', 'dongguan', 'ningbo', 'tianjin', 'chongqing', 'wuhan'
];

function isForeignLocation(location) {
  if (!location) return false;
  const loc = location.toLowerCase();
  return FOREIGN_INDICATORS.some(f => loc.includes(f));
}

const DISTRIBUTOR_KEYWORDS = ['distributor', 'distribution', 'wholesale', 'wholesaler', 'reseller',
  'trader', 'trading company', 'stockist', 'master distributor', 'supplier of', 'supplies ',
  'retailer', 'retail', 'e-commerce', 'online store', 'marketplace', 'catalog', 'catalogue',
  'offers a wide range', 'wide range of', 'offering various', 'sells ', 'carries ', 'stocks '];
const MANUFACTURER_KEYWORDS = ['manufactur', 'fabricat', 'oem ', 'oem,', 'original equipment',
  'production', 'machining', 'casting', 'forging', 'stamping', 'molding', 'moulding',
  'extru', 'assembl', 'produces ', 'producer', 'made in', 'custom made', 'custom manufacturer',
  'we make', 'we produce', 'we manufacture', 'in-house', 'contract manufacturer'];

const KNOWN_NON_MANUFACTURERS = ['mcmaster', 'grainger', 'fastenal', 'woodcraft', 'home depot',
  'amazon', 'lowes', "lowe's", 'ace hardware', 'northern tool', 'harbor freight', 'zoro',
  'global industrial', 'uline', 'staples', 'walmart', 'target', 'webstaurant'];

function isDistributor(s) {
  const name = (s.name || '').toLowerCase();
  const text = ((s.specialty || '') + ' ' + (s.tags || []).join(' ')).toLowerCase();
  if (KNOWN_NON_MANUFACTURERS.some(k => name.includes(k))) return true;
  const hasDist = DISTRIBUTOR_KEYWORDS.some(k => text.includes(k));
  const hasMfg = MANUFACTURER_KEYWORDS.some(k => text.includes(k));
  return hasDist && !hasMfg;
}

function isManufacturer(s) {
  const name = (s.name || '').toLowerCase();
  const text = ((s.specialty || '') + ' ' + (s.tags || []).join(' ')).toLowerCase();
  if (KNOWN_NON_MANUFACTURERS.some(k => name.includes(k))) return false;
  if (/\b(retailer|retail store|supplier of|reseller)\b/.test(text)) return false;
  if (MANUFACTURER_KEYWORDS.some(k => text.includes(k))) return true;
  return !DISTRIBUTOR_KEYWORDS.some(k => text.includes(k));
}

function filterBySupplierType(suppliers, supplierType) {
  if (supplierType === 'manufacturers') return suppliers.filter(s => isManufacturer(s));
  if (supplierType === 'distributors') return suppliers.filter(s => isDistributor(s));
  return suppliers;
}

function filterByScope(suppliers, scope, countries, selectedCountries) {
  if (!Array.isArray(suppliers)) return suppliers;
  suppliers = suppliers.filter(s => !isJunkSupplier(s));

  if (scope === 'domestic') {
    return suppliers.filter(s => {
      const loc = (s.location || '').trim();
      if (!loc || loc === 'N/A' || loc === 'Unknown' || loc === 'N/A, USA') return true;
      if (isForeignLocation(loc)) return false;
      if (isUSLocation(loc)) return true;
      const locUp = loc.toUpperCase();
      if (locUp.includes('USA') || locUp.includes('U.S') || locUp.includes('UNITED STATES')) return true;
      return false;
    });
  }
  if (scope === 'foreign') {
    return suppliers.filter(s => {
      if (!s.location || s.location === 'N/A' || s.location === 'Unknown') return true;
      return !isUSLocation(s.location);
    });
  }
  if (selectedCountries && selectedCountries.length) {
    const hasUSA = selectedCountries.includes('USA');
    const foreignSelected = selectedCountries.filter(c => c !== 'USA').map(c => c.toLowerCase());
    return suppliers.filter(s => {
      const loc = (s.location || '').toLowerCase();
      if (!loc || loc === 'n/a' || loc === 'unknown') return true;
      if (isUSLocation(s.location) && hasUSA) return true;
      if (foreignSelected.length && foreignSelected.some(c => loc.includes(c))) return true;
      if (isUSLocation(s.location) && !hasUSA) return false;
      return foreignSelected.length === 0;
    });
  }
  return suppliers;
}

// ── Continent / region classification ─────────────────────────────────────
// Used by company-mode continent filter. Country names are uppercased and matched
// against the trailing token of supplier.location (e.g. "Frankfurt, Germany" -> "GERMANY").
const CONTINENT_COUNTRIES = {
  north_america: new Set([
    'USA','UNITED STATES','UNITED STATES OF AMERICA','U.S.A','U.S','US',
    'CANADA','MEXICO','GUATEMALA','HONDURAS','EL SALVADOR','NICARAGUA',
    'COSTA RICA','PANAMA','BELIZE','CUBA','HAITI','DOMINICAN REPUBLIC',
    'JAMAICA','TRINIDAD AND TOBAGO','BAHAMAS','BARBADOS','PUERTO RICO'
  ]),
  south_america: new Set([
    'BRAZIL','ARGENTINA','CHILE','PERU','COLOMBIA','VENEZUELA','ECUADOR',
    'BOLIVIA','PARAGUAY','URUGUAY','GUYANA','SURINAME','FRENCH GUIANA'
  ]),
  europe: new Set([
    'UNITED KINGDOM','UK','GREAT BRITAIN','ENGLAND','SCOTLAND','WALES','IRELAND',
    'GERMANY','FRANCE','ITALY','SPAIN','PORTUGAL','NETHERLANDS','BELGIUM',
    'LUXEMBOURG','SWITZERLAND','AUSTRIA','POLAND','CZECH REPUBLIC','CZECHIA',
    'SLOVAKIA','HUNGARY','ROMANIA','BULGARIA','GREECE','SWEDEN','NORWAY',
    'DENMARK','FINLAND','ICELAND','ESTONIA','LATVIA','LITHUANIA','UKRAINE',
    'BELARUS','MOLDOVA','SERBIA','CROATIA','SLOVENIA','BOSNIA AND HERZEGOVINA',
    'BOSNIA','MONTENEGRO','NORTH MACEDONIA','MACEDONIA','ALBANIA','KOSOVO',
    'CYPRUS','MALTA','RUSSIA'
  ]),
  asia: new Set([
    'CHINA','JAPAN','SOUTH KOREA','KOREA','NORTH KOREA','TAIWAN','HONG KONG',
    'MACAU','MONGOLIA','INDIA','PAKISTAN','BANGLADESH','SRI LANKA','NEPAL',
    'BHUTAN','MALDIVES','THAILAND','VIETNAM','CAMBODIA','LAOS','MYANMAR',
    'BURMA','MALAYSIA','SINGAPORE','INDONESIA','PHILIPPINES','BRUNEI',
    'EAST TIMOR','TIMOR-LESTE','KAZAKHSTAN','UZBEKISTAN','TURKMENISTAN',
    'KYRGYZSTAN','TAJIKISTAN','AFGHANISTAN'
  ]),
  middle_east: new Set([
    'UAE','UNITED ARAB EMIRATES','DUBAI','ABU DHABI','SAUDI ARABIA','ISRAEL',
    'TURKEY','TÜRKIYE','IRAN','IRAQ','SYRIA','LEBANON','JORDAN','KUWAIT',
    'QATAR','BAHRAIN','OMAN','YEMEN','PALESTINE'
  ]),
  africa: new Set([
    'SOUTH AFRICA','EGYPT','MOROCCO','TUNISIA','ALGERIA','LIBYA','SUDAN',
    'ETHIOPIA','KENYA','TANZANIA','UGANDA','GHANA','NIGERIA','SENEGAL',
    'CÔTE D\'IVOIRE','IVORY COAST','CAMEROON','ANGOLA','MOZAMBIQUE','ZIMBABWE',
    'ZAMBIA','BOTSWANA','NAMIBIA','RWANDA','BURUNDI','MADAGASCAR','MAURITIUS',
    'SOMALIA','ERITREA','DJIBOUTI','MALI','BURKINA FASO','NIGER','CHAD',
    'CONGO','DEMOCRATIC REPUBLIC OF THE CONGO','DRC','GABON','BENIN','TOGO',
    'GUINEA','SIERRA LEONE','LIBERIA','GAMBIA','MAURITANIA'
  ]),
  oceania: new Set([
    'AUSTRALIA','NEW ZEALAND','PAPUA NEW GUINEA','FIJI','SAMOA','TONGA',
    'VANUATU','SOLOMON ISLANDS'
  ])
};

const CONTINENT_LABELS = {
  north_america: 'North America',
  south_america: 'South America',
  europe: 'Europe',
  asia: 'Asia',
  middle_east: 'Middle East',
  africa: 'Africa',
  oceania: 'Oceania'
};

// Determine which continent (if any) a location belongs to.
function classifyContinent(location) {
  if (!location) return null;
  const upper = location.toUpperCase();
  const parts = upper.split(',').map(p => p.trim()).filter(Boolean);
  const candidates = parts.slice(-2);
  for (const candidate of candidates.reverse()) {
    for (const [continent, countries] of Object.entries(CONTINENT_COUNTRIES)) {
      if (countries.has(candidate)) return continent;
    }
  }
  for (const [continent, countries] of Object.entries(CONTINENT_COUNTRIES)) {
    for (const country of countries) {
      const rx = new RegExp(`\\b${country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (rx.test(upper)) return continent;
    }
  }
  return null;
}

// ── Non-supplier exclusion patterns for company-search mode ─────────────────
const NON_SUPPLIER_PATTERNS = [
  /\buniversity (of|at)\b/i, /\bof [a-z\- ]{3,40} university\b/i,
  /\b(community |state |technical )?college\b/i, /\binstitute of technology\b/i,
  /\bschool of (engineering|business|medicine|law|public health)\b/i,
  /\b(state|technical) polytechnic\b/i, /\bpolytechnic university\b/i,
  /\bnational lab(oratory|oratories)?\b/i, /\b(research|teaching) hospital\b/i,
  /\bfraunhofer\b/i, /\b(mit|caltech|stanford|berkeley|harvard) (university|laboratory|lab)\b/i,
  /^(u\.?s\.? )?department of\b/i, /\bu\.?s\.? department of\b/i,
  /\bministry of\b/i,
  /^(federal|state|us|u\.s\.) (bureau|administration|agency|commission|department)\b/i,
  /\b(faa|fcc|fda|epa|nasa|usda|gsa|nih|nsf|doe|dod|dol|dot|nrc|sec\.gov|irs)\b/i,
  /\b(us|u\.s\.|united states) (army|navy|air force|marine corps|coast guard|space force)\b/i,
  /\bdefense logistics agency\b/i, /\bpentagon\b/i,
  /^government of\b/i, /^city of\b/i, /^state of\b/i, /^county of\b/i,
  /\b(port|housing|transit|water) authority\b/i, /\bcity council\b/i,
  /\b(iso|astm international|ieee|sae international|ansi|underwriters laboratories|ul llc)\b/i,
  /\bnon-?profit\b/i, /\bcharitable foundation\b/i,
  /\b[a-z ]+ trade association\b/i, /\b[a-z ]+ industry association\b/i,
  /\b(reuters|bloomberg news|bloomberg l\.?p\.?|cnbc|wsj|wall street journal|new york times|nyt|forbes|fortune magazine|bbc|cnn|axios|the guardian|financial times|barron'?s)\b/i,
  /\b(gartner|forrester research|idc research|moody'?s|s&p global|fitch ratings|morningstar)\b/i,
  /\b(importyeti|panjiva|datamyne|thomasnet|kompass|global ?sources|sec\.gov|crunchbase|dun ?& ?bradstreet)\b/i,
  /^(various|multiple) (suppliers|vendors)$/i, /^(undisclosed|confidential)$/i, /^n\/?a$/i,
  /^supplier #?\d+$/i, /^vendor #?\d+$/i
];

function isNonSupplierEntity(name) {
  if (!name) return true;
  const n = name.trim();
  if (!n) return true;
  for (const rx of NON_SUPPLIER_PATTERNS) {
    if (rx.test(n)) {
      console.log(`  [exclude] "${n}" matched pattern ${rx}`);
      return true;
    }
  }
  return false;
}

// Corporate suffixes that carry no identity ("Tesla Inc" === "Tesla").
const CORP_SUFFIX_TOKENS = new Set(['inc','incorporated','llc','llp','lp','corp','corporation',
  'co','company','companies','ltd','limited','group','holdings','holding','plc','gmbh','sa',
  'srl','ag','bv','nv','kk','pty','pte','sas','spa','ab','oy','the','enterprises']);
// Geo / subsidiary markers: "Walmart de Mexico", "Siemens USA" are the same entity family.
const GEO_MARKER_TOKENS = new Set(['de','del','da','of','usa','us','america','americas','north',
  'south','europe','emea','asia','apac','pacific','international','intl','global','worldwide',
  'canada','mexico','uk','japan','china','india','brasil','brazil','deutschland','latam']);

function coreTokens(s) {
  return (s || '').toLowerCase().replace(/[^a-z0-9 ]/g, ' ').split(/\s+/)
    .filter(t => t && !CORP_SUFFIX_TOKENS.has(t));
}

// True only when the candidate is the target itself or an obvious regional arm/subsidiary.
// Token-based on purpose: the old substring check ("a.includes(b)") excluded any company whose
// name merely CONTAINED the target — e.g. target "Ford" wrongly killed "Ford Meter Box".
// Now: exact core-token match, OR target tokens as a prefix where every leftover token is a
// corporate/geo marker ("Walmart de Mexico" → leftovers [de, mexico] → excluded;
// "Ford Meter Box" → leftovers [meter, box] → kept).
function isSelfOrSubsidiary(name, targetCompany) {
  if (!name || !targetCompany) return false;
  const a = coreTokens(name);
  const b = coreTokens(targetCompany);
  if (!a.length || !b.length) return false;
  if (a.join(' ') === b.join(' ')) return true;
  if (a.length > b.length && b.every((t, i) => a[i] === t)) {
    const leftovers = a.slice(b.length);
    if (leftovers.every(t => GEO_MARKER_TOKENS.has(t))) return true;
  }
  return false;
}


// ── Gemini model cascade ───────────────────────────────────────────────────
// Quality-first, all live models (as of 2026):
//   gemini-2.5-pro       — empirically strongest for our prompt structure (primary)
//   gemini-2.5-flash     — same family, smaller/faster
//   gemini-2.5-flash-lite— cheapest live tier; different pool, often up when 2.5 is throttled
//   gemini-3.5-flash     — newest GA flash, no announced shutdown (future-proof tail)
// gemini-1.5-flash was REMOVED — Google retired all 1.5 models and the endpoint now 404s.
// Used in-order by /api/search (per-model fall-through to Claude) and by callGemini (/api/email).
const GEMINI_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-3.5-flash'];

// Per-attempt hard timeout (ms). If a single Gemini call hangs past this, we abort and
// fall through to the next model in the cascade — rather than letting the request run long
// enough for Railway's edge to return an HTML timeout page (which the browser then can't
// parse as JSON, surfacing as the cryptic "Unexpected token '<'").
const GEMINI_TIMEOUT_MS = 30000;

// Retry budget by HTTP status. A 503 "high demand" is a capacity problem on THAT specific
// model and rarely clears in a second or two, so we retry it at most once (short) before
// falling through to the next model — the whole point of the cascade is having alternatives.
// 429 (rate limit) and 500 (transient) do tend to clear, so they keep a longer backoff budget.
function retryBudget(status) {
  if (status === 503) return { max: 1, base: 400 };          // one quick retry, then fall through
  if (status === 429 || status === 500) return { max: 2, base: 700 }; // 700ms, then 1400ms
  return { max: 0, base: 0 };                                // anything else: non-retryable
}

// HTTP wrapper that retries transient Gemini failures with a per-status budget and enforces
// a hard per-call timeout. On timeout / network error we throw so the caller falls through
// to the next model, instead of hanging.
async function geminiFetch(url, body, model, label = 'request') {
  let lastErr;
  let attempt = 0;
  for (;;) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS);
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      });
    } catch (e) {
      clearTimeout(timer);
      const aborted = e.name === 'AbortError';
      console.error(`  [${model}] ${label} ${aborted ? `aborted after ${GEMINI_TIMEOUT_MS}ms` : 'network error: ' + e.message}`);
      // A hung call is unlikely to recover on retry — fall through to the next model.
      throw new Error(`Gemini ${aborted ? 'timeout' : 'network error'} (${model})`);
    }
    clearTimeout(timer);
    if (res.ok) return res;
    const errText = await res.text();
    console.error(`  [${model}] HTTP ${res.status} (${label}): ${errText.substring(0, 400)}`);
    lastErr = new Error(`Gemini API error ${res.status}: ${errText.substring(0, 200)}`);
    const { max, base } = retryBudget(res.status);
    if (attempt >= max) throw lastErr;
    attempt++;
    const delay = base * Math.pow(2, attempt - 1);
    console.log(`  [${model}] retrying ${label} (attempt ${attempt}/${max}) after ${delay}ms (HTTP ${res.status})`);
    await new Promise(r => setTimeout(r, delay));
  }
}

async function callGemini(prompt, geminiKey, scope='', countries='', systemInstruction='', useSearch=true) {
  for (const model of GEMINI_MODELS) {
    try {
      console.log(`Trying Gemini model: ${model}`);
      const result = await callGeminiModel(prompt, geminiKey, model, scope, countries, systemInstruction, useSearch);
      if (result && result.text) return result.text;
    } catch (err) {
      console.warn(`${model} failed: ${err.message}. Trying next model...`);
    }
  }
  throw new Error('All Gemini models failed');
}

// Pull the real web sources Gemini consulted out of groundingMetadata. These are the
// evidence pages behind the answer — previously discarded, now surfaced to the frontend.
function extractGroundingSources(candidate) {
  const chunks = candidate?.groundingMetadata?.groundingChunks;
  if (!Array.isArray(chunks)) return [];
  const out = [];
  for (const c of chunks) {
    if (c?.web?.uri) out.push({ title: c.web.title || c.web.uri, uri: c.web.uri });
  }
  return out;
}

// Build generationConfig per model. 2.5-family models spend "thinking" tokens out of the same
// maxOutputTokens budget; uncapped, 2.5-pro can think its way to an empty visible response
// (finishReason MAX_TOKENS) — which is what triggers our expensive follow-up call. Cap it.
function buildGenConfig(model, jsonMode = false) {
  const cfg = { temperature: 0.1, maxOutputTokens: 16384 };
  if (model.startsWith('gemini-2.5')) cfg.thinkingConfig = { thinkingBudget: 4096 };
  if (jsonMode) cfg.responseMimeType = 'application/json'; // NOT combinable with googleSearch tool
  return cfg;
}

// Returns { text, sources } — sources are grounding URLs (empty when useSearch=false or
// the model didn't ground).
async function callGeminiModel(prompt, geminiKey, model, scope='', countries='', systemInstruction='', useSearch=true) {
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;

  const body = {
    system_instruction: { parts: [{ text: systemInstruction || 'You are a Lead Sourcing & Procurement Analyst. Return a valid JSON array of suppliers only. No preamble. No markdown.' }] },
    contents: [{ parts: [{ text: prompt }] }],
    generationConfig: buildGenConfig(model, !useSearch)
  };
  if (useSearch) body.tools = [{ googleSearch: {} }];

  const res = await geminiFetch(url, body, model, 'primary');

  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason || 'unknown';
  const text = candidate?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join('') || '';

  if (!text) {
    console.warn(`${model} returned empty content. finishReason: ${finishReason}. Trying follow-up...`);
    // Diagnostic: log the full candidate so we can see what came back
    try {
      console.warn(`  [${model}] full candidate:`, JSON.stringify(candidate || {}).substring(0, 600));
    } catch (e) { /* ignore */ }
    const geoReminder = scope === 'foreign'
      ? (countries ? `IMPORTANT: Only include suppliers from: ${countries}. Exclude ALL US companies.`
                   : `IMPORTANT: Only include non-US international suppliers. Exclude ALL US/American companies.`)
      : scope === 'domestic' ? `IMPORTANT: Only include US-based suppliers. Exclude ALL foreign companies.` : '';
    // Follow-up has no googleSearch tool, so JSON response mode is allowed here — the model
    // is forced to emit parseable JSON instead of prose.
    const followUp = await geminiFetch(url, {
      contents: [{ parts: [{ text: prompt + `\n\nReturn the JSON array now. ${geoReminder} Return ONLY a valid JSON array.` }] }],
      generationConfig: buildGenConfig(model, true)
    }, model, 'follow-up');
    const followData = await followUp.json();
    const followCandidate = followData?.candidates?.[0];
    const followText = followCandidate?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join('') || '';
    if (followText) {
      console.log(`Follow-up on ${model} succeeded`);
      return { text: followText, sources: extractGroundingSources(followCandidate) };
    }
    throw new Error(`${model} returned empty response (finishReason: ${finishReason})`);
  }
  console.log(`${model} response received (first 200 chars):`, text.substring(0, 200));
  return { text, sources: extractGroundingSources(candidate) };
}

// ── Claude fallback ────────────────────────────────────────────────────────
async function callClaude(prompt, anthropicKey, expectArray = true) {
  const system = expectArray
    ? 'Return only a valid JSON array. No markdown. No preamble.'
    : 'Return only a valid JSON object. No markdown. No preamble.';
  // Same hard timeout Gemini calls get: a hung request must abort before Railway's edge
  // returns an HTML timeout page.
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30000);
  let res;
  try {
    res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8000,
        system,
        messages: [{ role: 'user', content: prompt }]
      }),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    throw new Error(e.name === 'AbortError' ? 'Claude timeout after 30s' : 'Claude network error: ' + e.message);
  }
  clearTimeout(timer);
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Claude error');
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

function cleanCommodity(commodity) {
  return commodity
    .replace(/wholesale\s*only/gi, '').replace(/no\s*retail/gi, '')
    .replace(/retail\s*only/gi, '').replace(/domestic\s*only/gi, '')
    .replace(/usa\s*only/gi, '').replace(/us\s*only/gi, '')
    .replace(/\bonly\b/gi, '').replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ').trim().replace(/^,|,$/g, '').trim();
}

// ── Location rescue ─────────────────────────────────────────────────────────
// Company-mode geo filters used to silently DROP any supplier whose location came back as
// "N/A"/"Unknown" — real finds thrown away over a missing field. This batches those
// candidates into ONE cheap flash-lite grounded lookup ("where is each HQ?") so they can be
// re-tested against the geo filters instead of lost. Failure here is non-fatal: on any error
// we just return an empty map and the candidates stay dropped (previous behavior).
async function resolveLocations(names, geminiKey) {
  if (!names.length || !geminiKey) return {};
  const model = 'gemini-2.5-flash-lite';
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`;
  const prompt = `For each company below, return its headquarters location as "City, ST" (US) or "City, Country" (non-US). If you cannot determine it, use "Unknown".\n\nCompanies:\n${names.map(n => `- ${n}`).join('\n')}\n\nReturn ONLY a JSON array: [{"name":"<exact name as given>","location":"City, ST or City, Country or Unknown"}]. No markdown. No preamble.`;
  try {
    const res = await geminiFetch(url, {
      contents: [{ parts: [{ text: prompt }] }],
      tools: [{ googleSearch: {} }],
      generationConfig: { temperature: 0, maxOutputTokens: 4096, thinkingConfig: { thinkingBudget: 0 } }
    }, model, 'location-rescue');
    const data = await res.json();
    const text = data?.candidates?.[0]?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join('') || '';
    if (!text) return {};
    const arr = parseJSON(text);
    const map = {};
    if (Array.isArray(arr)) {
      for (const item of arr) {
        if (item && item.name && item.location) map[item.name.toLowerCase().trim()] = String(item.location).trim();
      }
    }
    return map;
  } catch (e) {
    console.warn(`Location rescue failed (non-fatal): ${e.message}`);
    return {};
  }
}

// ── /api/search ────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const geminiKey    = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!geminiKey && !anthropicKey) {
    return res.status(500).json({ error: 'No API keys configured' });
  }

  try {
    const { commodity, scope, certs, countries, hts, sources, selectedCountries, supplierType, imageData, imageType, mode, companyName, companyGeoScope, companyGeoCountries, companyContinents, dateFrom, dateTo, excludeNames } = req.body;
    const cleanedCommodity = cleanCommodity(commodity || '');

    // "Search More Sources" sends the names already on screen. Injecting them as a
    // DO-NOT-RETURN list makes the model spend its 10–20 result budget on NEW companies
    // instead of re-finding the same top hits (which the frontend would dedupe to zero).
    const excludeList = Array.isArray(excludeNames)
      ? excludeNames.filter(n => typeof n === 'string' && n.trim()).map(n => n.trim()).slice(0, 80)
      : [];
    const excludeBlock = excludeList.length
      ? `\n[ALREADY FOUND — DO NOT RETURN]\nThe following companies have ALREADY been found in a previous search. Do NOT include them or their subsidiaries again. Find DIFFERENT companies — dig into less obvious sources (regional directories, trade records, smaller firms, page-2+ results):\n${excludeList.map(n => `- ${n}`).join('\n')}\n`
      : '';
    const searchMode = (mode === 'company') ? 'company' : 'commodity';
    const targetCompany = (companyName || '').trim();

    const dateRx = /^\d{4}-\d{2}-\d{2}$/;
    const validDateFrom = (dateFrom && dateRx.test(dateFrom)) ? dateFrom : '';
    const validDateTo   = (dateTo   && dateRx.test(dateTo))   ? dateTo   : '';
    const hasDateRange  = searchMode === 'company' && validDateFrom && validDateTo && validDateFrom <= validDateTo;

    let geoSelected;
    let validContinents = [];

    if (searchMode === 'company') {
      const extraCountries = (companyGeoCountries || '').trim();
      validContinents = Array.isArray(companyContinents)
        ? companyContinents.filter(c => CONTINENT_LABELS[c])
        : [];
      const continentLabel = validContinents.length
        ? validContinents.map(c => CONTINENT_LABELS[c]).join(', ')
        : '';

      const parts = [];
      if (companyGeoScope === 'domestic') parts.push('United States ONLY');
      else if (companyGeoScope === 'foreign') parts.push('foreign countries (NOT the United States)');
      if (continentLabel) parts.push(`continents: ${continentLabel}`);
      if (extraCountries) parts.push(`countries: ${extraCountries}`);

      geoSelected = parts.length ? parts.join('; ') : 'Global (no restriction)';
    } else {
      const countryList = selectedCountries && selectedCountries.length ? selectedCountries : [];
      const hasUSA = countryList.includes('USA');
      const foreignCountries = countryList.filter(c => c !== 'USA');
      const allDomestic = hasUSA && foreignCountries.length === 0;
      const allForeign = foreignCountries.length > 0 && !hasUSA;
      const mixed = hasUSA && foreignCountries.length > 0;

      geoSelected = allDomestic ? 'United States'
        : allForeign ? foreignCountries.join(', ')
        : mixed ? `United States, ${foreignCountries.join(', ')}`
        : 'Global (no restriction)';
    }

    const certText = certs ? certs : 'None';
    const supplierTypeText = supplierType === 'manufacturers'
      ? 'SUPPLIER TYPE: Return manufacturers and OEMs ONLY. Exclude all distributors, resellers, traders, and wholesalers.'
      : supplierType === 'distributors'
      ? 'SUPPLIER TYPE: Return distributors and wholesalers ONLY. Exclude direct-only manufacturers.'
      : 'SUPPLIER TYPE: Include both manufacturers and distributors.';
    const htsText = hts ? hts : 'None';

    const sourceInstructions = sources && sources.length
      ? sources.map(s => `"${cleanedCommodity}" site:${s.toLowerCase().replace(/\s/g,'')}.com`).join(', ')
      : `"${cleanedCommodity}" site:thomasnet.com`;

    // Build prompt for Gemini (strict "HARD-FAIL" language works well) or Claude (no live search).
    function buildPrompts(engine) {
      const isClaude = engine === 'claude';

      const hardFail = 'are HARD-FAILS';
      const zeroTolerance = '[OUTPUT RULES - ZERO TOLERANCE]';
      const mustCiteEvidence = 'Each entry needs specific evidence (named in a filing, listed on a supplier diversity page, appears in import records).';
      const refusalGuard = `Returning an empty array or a diagnostic explanation of why you couldn't find suppliers is a failure mode — research harder.`;

      let sysInstruction, prompt;

      if (searchMode === 'company') {
        if (!targetCompany) return null;

        sysInstruction = `You are a Supply Chain Intelligence Analyst. Your job is to research and return a JSON array of verified VENDORS and SUPPLIERS — companies that sell to a target company and appear in the target's accounts payable.

RESEARCH METHODOLOGY: Run multiple independent searches across different source types before concluding. If your first search returns only the target's customers/distributors, search again with different queries. Try at least these angles${isClaude ? ' from your training knowledge' : ''}:
1. Target's own supplier diversity / approved vendor pages
2. SEC filings: "[target] 10-K principal suppliers" / "[target] 10-K key suppliers"
3. Trade records: ImportYeti / Panjiva entries naming the target as consignee
4. Press releases announcing supplier partnerships
5. News articles naming specific vendors who supply the target
6. Industry reports identifying the target's supply chain

Major companies (publicly traded, large private firms) typically have publicly disclosed supplier information. If your initial searches return only retailers/distributors of the target's products, pivot to the sources above.

Aim for 10–20 verified suppliers per query. ${refusalGuard}

Exclude: customers (entities the target sells to), competitors, government agencies, military branches, universities, research labs, non-profits, news outlets, analyst firms, and aggregator websites themselves (ImportYeti, Panjiva, ThomasNet, Bloomberg, etc.).

Output format: raw JSON array only. No markdown code blocks. No preamble. No explanatory notes. Start with [ and end with ].`;

        let geoDirective = '';
        if (companyGeoScope === 'domestic') {
          geoDirective = `\n[GEOGRAPHY — HARD CONSTRAINT]\nReturn ONLY suppliers headquartered or with primary manufacturing in the UNITED STATES. Foreign suppliers — even if they have US offices — ${hardFail}. The location field of every result must end with a US state (e.g. "Detroit, MI" or "Detroit, MI, USA").`;
        } else if (companyGeoScope === 'foreign') {
          geoDirective = `\n[GEOGRAPHY — HARD CONSTRAINT]\nReturn ONLY suppliers headquartered OUTSIDE the United States. US-based suppliers ${hardFail}. The location field must clearly indicate a non-US country.`;
        }
        if (validContinents.length) {
          const continentNames = validContinents.map(c => CONTINENT_LABELS[c]).join(', ');
          geoDirective += `\nGeographic scope is further restricted to these continents/regions: ${continentNames}. Suppliers outside these regions ${hardFail}.`;
        }
        if (companyGeoCountries && companyGeoCountries.trim()) {
          geoDirective += `\nFocus particularly on these countries: ${companyGeoCountries.trim()}.`;
        }

        const dateRangeSection = hasDateRange
          ? `\n[DATE RANGE — EVIDENCE PREFERENCE]\nStrongly prefer evidence (bills of lading, SEC filings, press releases, news articles, supplier diversity pages) dated between ${validDateFrom} and ${validDateTo}.\n- Rank suppliers with evidence in this window highest.\n- It is acceptable to include a strongly-supported supplier whose only public mention is outside this window, but rank it lower and note the evidence date in fitReason.\n- Do NOT fabricate dates. If you cannot determine when the evidence is from, do not invent one.\n`
          : '';

        prompt = `[GOAL]
Perform deep web research to identify verified VENDORS that "${targetCompany}" PAYS — i.e., companies that appear on ${targetCompany}'s purchase orders or accounts payable.

[TARGET COMPANY]
- Company Name: "${targetCompany}"
- Required Certs: ${certText}
- HTS Code (commodity hint): ${htsText}
- Geography Scope: ${geoSelected}
${geoDirective}
${dateRangeSection}
${excludeBlock}[DIRECTION OF MONEY — CRITICAL]
Money must flow FROM ${targetCompany} TO the supplier. ${targetCompany} is the BUYER; the supplier is the SELLER receiving payment.
This means: for retailers (Walmart, Target, Costco), the brands they stock (P&G, Coca-Cola, Tyson, Mattel, etc.) ARE valid suppliers — Walmart pays those brands wholesale. For manufacturers (Boeing, Tesla), the parts and material suppliers are valid. For service companies, IT vendors, contract manufacturers, logistics firms, and packaging suppliers are valid.
What is NOT valid: ${targetCompany}'s customers (entities ${targetCompany} sells to), competitors, or end consumers.
Test: "Does ${targetCompany} write a check or wire payment to this entity?" If yes, valid. If no, exclude.

[HARD EXCLUSIONS]
Do not return any of the following, regardless of how often they co-occur with "${targetCompany}":
- Customers of ${targetCompany} (entities that BUY from ${targetCompany})
- Competitors or peer companies
- Government agencies, military branches, universities, research labs
- Non-profits, foundations, industry associations, standards bodies
- News outlets, analyst firms, trade publications
- The aggregator websites themselves (ImportYeti, Panjiva, ThomasNet, Bloomberg)
- ${targetCompany} itself, its subsidiaries, or its parent company

[RESEARCH PROTOCOL]
1. Search across these angles:
   - "${targetCompany}" supplier
   - "${targetCompany}" vendor
   - "${targetCompany}" "supplied by" OR "manufactured by" OR "contract manufacturer"
   - site:importyeti.com "${targetCompany}"
   - site:panjiva.com "${targetCompany}"
   - "${targetCompany}" 10-K "principal suppliers" OR "key suppliers" OR "raw materials"
   - "${targetCompany}" press release partnership manufacturer
   - "${targetCompany}" bill of lading OR shipment records OR consignor${hasDateRange ? `
   - When useful, narrow queries with date operators (e.g. \`"${targetCompany}" supplier after:${validDateFrom} before:${validDateTo}\`).` : ''}
2. SOURCE PRIORITY: Bills of lading naming ${targetCompany} as CONSIGNEE, SEC 10-K "principal suppliers" sections, press releases announcing supplier agreements, and the target's own supplier diversity pages.
3. VALIDATE EACH CANDIDATE: confirm it's a for-profit company that sells goods or services, confirm money flows from ${targetCompany} to it, confirm it's not in the exclusion list.
4. EVIDENCE: ${mustCiteEvidence}

${zeroTolerance}
- RETURN ONLY A JSON ARRAY.
- NO MARKDOWN: Do not use \`\`\`json or any backticks. Start with [ and end with ].
- TARGET 10–20 RESULTS: Major buyers like Walmart, Tesla, Boeing, P&G, Apple have publicly-disclosed supplier lists, supplier diversity pages, ImportYeti records, and 10-K filings — use them.
- TOKEN MANAGEMENT: Once you have identified 20 verified suppliers, stop searching and generate the JSON output.

[JSON SCHEMA]
[
  {
    "id": 1,
    "name": "Exact Legal Supplier Name",
    "location": "City, ST or City, Country",
    "website": "domain.com",
    "source": "ImportYeti / Panjiva / SEC 10-K / Press Release / Web Search",
    "specialty": "One sentence on what they supply to ${targetCompany}.",
    "tags": ["component or service", "relationship type"],
    "certs": [],
    "fit": "high | medium | low",
    "fitReason": "Cite the specific evidence and direction of relationship.",
    "contactEmail": "",
    "contactName": ""
  }
]

${supplierTypeText} Begin JSON output now.`;

      } else {
        // ─── COMMODITY SEARCH ──────────────────────────────────────────────
        sysInstruction = `You are a Lead Sourcing & Procurement Analyst. You provide raw data in JSON format.
CRITICAL: You are currently restricted to ${geoSelected} suppliers only. If a company is not headquartered or manufacturing in ${geoSelected}, it ${hardFail}; do not include it.
${refusalGuard}
No preamble. No conversational filler. No markdown formatting blocks (no \`\`\`json). Output the raw JSON array immediately.`;

        prompt = `[GOAL]
Perform deep web research to identify verified ${geoSelected} manufacturers/distributors for the following commodity.

${excludeBlock}[COMMODITY DATA]
- Commodity: "${cleanedCommodity}"
- Required Certs: ${certText}
- HTS Code: ${htsText}
- Geography Scope: ${geoSelected} ONLY. (Strictly exclude all entities outside ${geoSelected}).

[RESEARCH PROTOCOL]
1. Search across these angles: "${cleanedCommodity} manufacturer ${geoSelected}", "${cleanedCommodity} domestic supplier", and ${sourceInstructions}.
2. VALIDATE ENTITY: Identify the SPECIFIC COMPANY NAME. If a search result is a list or directory (Alibaba, ThomasNet, Kompass), extract the names of the companies within that list.
3. VERIFY LOCATION: Confirm the Contact or About page lists a physical address in ${geoSelected}. Discard results outside ${geoSelected}.
4. PRIORITIZE: Rank Manufacturer first, then Distributor/Master Distributor.

${zeroTolerance}
- RETURN ONLY A JSON ARRAY.
- NO MARKDOWN: Do not use \`\`\`json or any backticks. Start with [ and end with ].
- TARGET 10–15 RESULTS: ${mustCiteEvidence}
- NO EXPLANATIONS: Do not explain why a search failed or succeeded. If 0 results are found, return [].
- TOKEN MANAGEMENT: Once you have identified 15 verified companies, stop searching immediately and generate the JSON output.

[JSON SCHEMA]
[
  {
    "id": 1,
    "name": "Exact Legal Company Name",
    "location": "City, ST or City, Country",
    "website": "domain.com",
    "source": "ThomasNet / Web Search / Direct",
    "specialty": "One sentence on specific manufacturing capabilities.",
    "tags": ["tag1", "tag2"],
    "certs": [],
    "fit": "high | medium | low",
    "fitReason": "Concise reason for fit score.",
    "contactEmail": "",
    "contactName": ""
  }
]

GEOGRAPHY REQUIREMENT: Return ONLY ${geoSelected} suppliers. Do NOT include any companies outside ${geoSelected}. ${supplierTypeText} Begin JSON output now.`;
      }

      return { systemInstruction: sysInstruction, supplierPrompt: prompt };
    }

    if (searchMode === 'company' && !targetCompany) {
      return res.status(400).json({ error: 'companyName is required for company search mode' });
    }

    let responseText;
    let usedProvider = null;
    let groundingSources = [];

    async function tryGeminiModel(modelName) {
      const prompts = buildPrompts('gemini');
      console.log(`Trying Gemini model: ${modelName}`);
      const result = await callGeminiModel(prompts.supplierPrompt, geminiKey, modelName, scope, countries, prompts.systemInstruction);
      return result; // { text, sources }
    }

    // Providers 1..N: Gemini cascade (live-search grounded). Each model gets transient-error
    // retries inside geminiFetch; on a hard failure we fall through to the next model in order.
    if (geminiKey) {
      for (const model of GEMINI_MODELS) {
        try {
          const result = await tryGeminiModel(model);
          if (result && result.text) {
            responseText = result.text;
            groundingSources = result.sources || [];
            usedProvider = 'gemini';
            console.log(`${model} grounding sources: ${groundingSources.length}`);
            break;
          }
        } catch (err) {
          console.warn(`${model} failed: ${err.message}. Trying next model...`);
        }
      }
    }

    // Final provider: Claude Haiku — offline-knowledge fallback (no live web search → degraded mode).
    if (!responseText && anthropicKey) {
      const prompts = buildPrompts('claude');
      console.log('Using Claude fallback...');
      responseText = await callClaude(prompts.supplierPrompt, anthropicKey, true);
      usedProvider = 'claude';
    }

    if (!responseText) throw new Error('All AI providers failed');

    let suppliers;
    try {
      suppliers = parseJSON(responseText);
      if (Array.isArray(suppliers)) {
        const before = suppliers.length;
        if (searchMode !== 'company') {
          suppliers = filterByScope(suppliers, scope, countries, selectedCountries);
        } else {
          const beforeExcl = suppliers.length;
          suppliers = suppliers.filter(s => {
            if (!s || !s.name) return false;
            if (/search result|no specific company|not provided/i.test(s.name)) return false;
            if (isNonSupplierEntity(s.name)) {
              console.log(`Excluding non-supplier: ${s.name}`);
              return false;
            }
            if (isSelfOrSubsidiary(s.name, targetCompany)) {
              console.log(`Excluding target/subsidiary: ${s.name}`);
              return false;
            }
            const reason = (s.fitReason || '') + ' ' + (s.specialty || '');
            if (/\b(customer of|rather than a supplier|not a supplier|is a customer|sells .* products|distributor of|reseller of|retailer of|buys from)\b/i.test(reason)) {
              console.log(`  [self-incriminating fitReason] excluding "${s.name}": ${s.fitReason?.substring(0,100)}`);
              return false;
            }
            return true;
          });
          console.log(`Company-mode exclusion filter: ${beforeExcl} → ${suppliers.length}`);

          const isUnknownLocation = (loc) => {
            const t = (loc || '').trim().toLowerCase();
            return !t || t === 'n/a' || t === 'na' || t === 'unknown' || t === 'not specified' || t === 'not provided' || t === '-' || t === 'tbd';
          };

          // Pull unknown-location suppliers ASIDE (instead of letting the filters below drop
          // them) so they can be location-rescued after filtering. Only worth doing when a
          // geo filter is actually active and Gemini is available for the lookup.
          const geoFilterActive = companyGeoScope === 'domestic' || companyGeoScope === 'foreign' || (validContinents && validContinents.length > 0);
          let rescueCandidates = [];
          if (geoFilterActive && geminiKey) {
            rescueCandidates = suppliers.filter(s => isUnknownLocation(s.location)).slice(0, 15);
            if (rescueCandidates.length) {
              suppliers = suppliers.filter(s => !isUnknownLocation(s.location));
              console.log(`Location rescue: ${rescueCandidates.length} unknown-location candidates set aside`);
            }
          }

          if (companyGeoScope === 'domestic') {
            suppliers = suppliers.filter(s => {
              const loc = s.location || '';
              if (isUnknownLocation(loc)) {
                console.log(`  [domestic filter] excluding "${s.name}" — unknown location`);
                return false;
              }
              const passes = isUSLocation(loc);
              if (!passes) console.log(`  [domestic filter] excluding "${s.name}" — non-US location: ${loc}`);
              return passes;
            });
          } else if (companyGeoScope === 'foreign') {
            suppliers = suppliers.filter(s => {
              const loc = s.location || '';
              if (isUnknownLocation(loc)) {
                console.log(`  [foreign filter] excluding "${s.name}" — unknown location`);
                return false;
              }
              const passes = !isUSLocation(loc);
              if (!passes) console.log(`  [foreign filter] excluding "${s.name}" — US location: ${loc}`);
              return passes;
            });
          }

          if (validContinents && validContinents.length > 0) {
            const allowedContinents = new Set(validContinents);
            suppliers = suppliers.filter(s => {
              const loc = s.location || '';
              if (isUnknownLocation(loc)) {
                console.log(`  [continent filter] excluding "${s.name}" — unknown location`);
                return false;
              }
              const continent = classifyContinent(loc);
              if (!continent) {
                console.log(`  [continent filter] excluding "${s.name}" — could not classify location: ${loc}`);
                return false;
              }
              if (!allowedContinents.has(continent)) {
                console.log(`  [continent filter] excluding "${s.name}" — ${CONTINENT_LABELS[continent]} not in allowed list: ${loc}`);
                return false;
              }
              return true;
            });
            console.log(`Continent filter (${validContinents.join(',')}): ${suppliers.length} remaining`);
          }

          // Rescue pass: resolve HQs for the set-aside candidates in one batch call, then
          // re-test them against the SAME geo constraints. Passers rejoin the results.
          if (rescueCandidates.length) {
            const locMap = await resolveLocations(rescueCandidates.map(s => s.name), geminiKey);
            const passesCompanyGeo = (loc) => {
              if (isUnknownLocation(loc)) return false;
              if (companyGeoScope === 'domestic' && !isUSLocation(loc)) return false;
              if (companyGeoScope === 'foreign' && isUSLocation(loc)) return false;
              if (validContinents && validContinents.length > 0) {
                const continent = classifyContinent(loc);
                if (!continent || !validContinents.includes(continent)) return false;
              }
              return true;
            };
            let rescued = 0;
            for (const s of rescueCandidates) {
              const resolved = locMap[s.name.toLowerCase().trim()];
              if (resolved && passesCompanyGeo(resolved)) {
                s.location = resolved;
                suppliers.push(s);
                rescued++;
                console.log(`  [rescued] "${s.name}" — resolved location: ${resolved}`);
              } else {
                console.log(`  [rescue failed] "${s.name}" — ${resolved ? 'resolved to out-of-scope: ' + resolved : 'location still unknown'}`);
              }
            }
            console.log(`Location rescue: ${rescued}/${rescueCandidates.length} recovered`);
          }
        }
        if (supplierType && supplierType !== 'both') {
          suppliers = filterBySupplierType(suppliers, supplierType);
          console.log(`Supplier type filter (${supplierType}): ${suppliers.length} remaining`);
        }
        console.log(`Filter (${searchMode} mode): ${before} → ${suppliers.length} suppliers (scope: ${scope})`);
        suppliers.forEach((s, i) => s.id = i + 1);
      }
      responseText = JSON.stringify(suppliers);
    } catch(e) {
      console.warn('Could not apply filters:', e.message);
    }

    const usedLiveSearch = usedProvider === 'gemini';

    // Dedupe grounding sources by URI, cap at 15 — these are the actual web pages Gemini
    // consulted, surfaced to the UI as clickable evidence.
    const seenUris = new Set();
    const uniqueSources = groundingSources.filter(s => {
      if (!s || !s.uri || seenUris.has(s.uri)) return false;
      seenUris.add(s.uri);
      return true;
    }).slice(0, 15);

    res.json({
      claudeData: {
        content: [{ type: 'text', text: responseText }]
      },
      usedSerpApi: usedLiveSearch,
      usedGemini: usedProvider === 'gemini',
      usedProvider,
      groundingSources: uniqueSources
    });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/email ─────────────────────────────────────────────────────────────
app.post('/api/email', async (req, res) => {
  const geminiKey    = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!geminiKey && !anthropicKey) {
    return res.status(500).json({ error: 'No API keys configured' });
  }

  try {
    const { commodity, includeAttach, attachList, dueDate, emailContext } = req.body;
    const attachNote = includeAttach && attachList
      ? ` Reference that attachments are included: ${attachList}.` : '';

    let dueDateNote = '';
    let formattedDueDate = '';
    if (dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      const [y, m, d] = dueDate.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      formattedDueDate = dt.toLocaleDateString('en-US', {
        timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric'
      });
      dueDateNote = ` Include a short pricing-by line near the end of the email (its own line or short closing paragraph, not buried inside another paragraph) using this exact date: "${formattedDueDate}".`;
    }

    let contextBlock = '';
    if (typeof emailContext === 'string' && emailContext.trim()) {
      const cleaned = emailContext.trim().slice(0, 2000);
      contextBlock = `

The sender provided the following sourcing context. Use it like this:
1. PUBLIC-FACING DETAILS (specific product category/sub-types, target volumes, part numbers): fold into the body where they sharpen the supplier's understanding of the opportunity. The specific product category (e.g. "industrial-strength and HVAC duct tapes" rather than just "duct tape") should be stated ONCE, in paragraph 1's "we're sourcing X" clause — do NOT restate the same product category in later paragraphs.
2. URLS: place each URL on its own line under a short label like "Current products for reference:" or "Reference:" — never inline in prose, never bare without a label, and never in a bulleted list with a single item. Preserve URLs exactly as written.
3. INTERNAL PROCEDURAL LANGUAGE (instructions on filling out forms, color-coded cells, internal SKU conventions, internal team workflows): paraphrase or omit. This belongs in the attached document, not the outreach email body.
---
${cleaned}
---`;
    }

    const emailPrompt = `Write a professional supplier outreach email template for sourcing: "${commodity}"${attachNote}${dueDateNote}${contextBlock}

Use these exact placeholders — do not substitute them with example text:
- [SUPPLIER_NAME] — the supplier company name
- [Your Name] — the sender's name
- [Your Title] — the sender's job title
- [Your Company] — the sender's company (use this exact string, not "[Your Company Name]")

Return a JSON object with:
- subject (string — professional subject line, may include [Your Company])
- body (string — short, scannable. Separate paragraphs with \\n\\n. Standalone labeled lines (e.g. a URL under "Current products for reference:") use a single \\n between the label and the URL, and \\n\\n to separate from surrounding paragraphs. Structure:
    Para 1: Introduce [Your Name], [Your Title] from [Your Company] and the sourcing need (use the specific product category from context if provided), referencing [SUPPLIER_NAME] specialty. Keep to 2 sentences.
    Para 2: Single-purpose pointer to the RFQ / quote request${includeAttach && attachList ? ', mentioning the attached documents' : ''}. Do NOT restate the product category from para 1. Keep to 1–2 sentences.${contextBlock ? `
    Labeled URL line(s): If the sourcing context contains URLs, place them here under a short label, each URL on its own line.` : ''}${dueDateNote ? `
    Pricing-by line: A short standalone line "Please return the completed RFQ with pricing by ${formattedDueDate}." (or similar phrasing).` : ''}
    Final para: Polite closing / call to action. Keep to 1–2 sentences.
  Do NOT include a signature block.)

Return ONLY a valid JSON object. No markdown. No preamble.`;

    let responseText;

    if (geminiKey) {
      try {
        // useSearch=false: drafting an email needs no live web search — skipping the
        // googleSearch tool cuts latency and lets JSON response mode kick in.
        responseText = await callGemini(emailPrompt, geminiKey, '', '',
          'You are a professional procurement communications writer. Return only a valid JSON object. No markdown. No preamble.', false);
      } catch (e) {
        console.warn('Gemini email failed, falling back to Claude:', e.message);
        responseText = null;
      }
    }

    if (!responseText && anthropicKey) {
      responseText = await callClaude(emailPrompt, anthropicKey, false);
    }

    if (!responseText) throw new Error('All AI providers failed');

    res.json({
      content: [{ type: 'text', text: responseText }]
    });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ── Start ──────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  const hasGemini    = !!process.env.GEMINI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  console.log(`SupplierScout ${APP_VERSION} running on port ${PORT}`);
  console.log(`Gemini cascade: ${GEMINI_MODELS.join(' -> ')} -> Claude Haiku`);
  console.log(`Gemini: ${hasGemini    ? '✓ configured (primary)'  : '✗ not set'}`);
  console.log(`Claude: ${hasAnthropic ? '✓ configured (fallback)' : '✗ not set'}`);
  if (!hasGemini) console.log('⚠ Add GEMINI_API_KEY to Railway for live search grounding');
});
