const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

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
// Returns continent key like 'europe', or null if it can't be classified.
function classifyContinent(location) {
  if (!location) return null;
  const upper = location.toUpperCase();
  // Check trailing comma-separated token first (most common: "City, Country")
  const parts = upper.split(',').map(p => p.trim()).filter(Boolean);
  const candidates = parts.slice(-2); // last two tokens, in case it's "City, State, Country"
  for (const candidate of candidates.reverse()) {
    for (const [continent, countries] of Object.entries(CONTINENT_COUNTRIES)) {
      if (countries.has(candidate)) return continent;
    }
  }
  // Fall back to substring match against the full uppercased string
  for (const [continent, countries] of Object.entries(CONTINENT_COUNTRIES)) {
    for (const country of countries) {
      // Use word boundaries to avoid false matches (e.g. "Indiana" matching "INDIA")
      const rx = new RegExp(`\\b${country.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
      if (rx.test(upper)) return continent;
    }
  }
  return null;
}

// ── Non-supplier exclusion patterns for company-search mode ─────────────────
// These match entities that show up in search results around a target company
// but are not vendors (customers, regulators, schools, news, etc).
//
// IMPORTANT: Patterns must be specific enough that they don't false-match real
// industrial suppliers. Generic single words like "institute", "authority",
// "agency", "news", "journal" are too broad on their own — anchor them to
// type-indicator positions or distinctive phrases.
const NON_SUPPLIER_PATTERNS = [
  // Education & research — match only when these words clearly indicate the entity type
  /\buniversity (of|at)\b/i, /\bof [a-z\- ]{3,40} university\b/i,
  /\b(community |state |technical )?college\b/i, /\binstitute of technology\b/i,
  /\bschool of (engineering|business|medicine|law|public health)\b/i,
  /\b(state|technical) polytechnic\b/i, /\bpolytechnic university\b/i,
  /\bnational lab(oratory|oratories)?\b/i, /\b(research|teaching) hospital\b/i,
  /\bfraunhofer\b/i, /\b(mit|caltech|stanford|berkeley|harvard) (university|laboratory|lab)\b/i,
  // Government — US (specific named agencies and clear type prefixes)
  /^(u\.?s\.? )?department of\b/i, /\bu\.?s\.? department of\b/i,
  /\bministry of\b/i,
  /^(federal|state|us|u\.s\.) (bureau|administration|agency|commission|department)\b/i,
  /\b(faa|fcc|fda|epa|nasa|usda|gsa|nih|nsf|doe|dod|dol|dot|nrc|sec\.gov|irs)\b/i,
  /\b(us|u\.s\.|united states) (army|navy|air force|marine corps|coast guard|space force)\b/i,
  /\bdefense logistics agency\b/i, /\bpentagon\b/i,
  // Government — generic / foreign
  /^government of\b/i, /^city of\b/i, /^state of\b/i, /^county of\b/i,
  /\b(port|housing|transit|water) authority\b/i, /\bcity council\b/i,
  // Standards / certification / non-profit (prefer named bodies + clear type indicators)
  /\b(iso|astm international|ieee|sae international|ansi|underwriters laboratories|ul llc)\b/i,
  /\bnon-?profit\b/i, /\bcharitable foundation\b/i,
  /\b[a-z ]+ trade association\b/i, /\b[a-z ]+ industry association\b/i,
  // Media / analyst / publishing (specific outlets only)
  /\b(reuters|bloomberg news|bloomberg l\.?p\.?|cnbc|wsj|wall street journal|new york times|nyt|forbes|fortune magazine|bbc|cnn|axios|the guardian|financial times|barron'?s)\b/i,
  /\b(gartner|forrester research|idc research|moody'?s|s&p global|fitch ratings|morningstar)\b/i,
  // Aggregators / directories themselves
  /\b(importyeti|panjiva|datamyne|thomasnet|kompass|global ?sources|sec\.gov|crunchbase|dun ?& ?bradstreet)\b/i,
  // Generic placeholders / non-entities
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

function isSelfOrSubsidiary(name, targetCompany) {
  if (!name || !targetCompany) return false;
  const a = name.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  const b = targetCompany.toLowerCase().replace(/[^a-z0-9 ]/g, '').replace(/\s+/g, ' ').trim();
  if (!a || !b) return false;
  if (a === b) return true;
  // "Boeing" matches "Boeing Company" / "The Boeing Company" / "Boeing Defense"
  if (a.includes(b) && b.length >= 4) return true;
  if (b.includes(a) && a.length >= 4) return true;
  return false;
}


// ── Gemini call with model cascade ────────────────────────────────────────
// Quality-first cascade. Pro leads — Flash variants only kick in if Pro is rate-limited
// or fails. Flash-Lite was removed because its grounded-search behavior on long prompts
// is unreliable (token exhaustion, empty content blocks).
const GEMINI_MODELS = ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-1.5-flash'];

async function callGemini(prompt, geminiKey, scope='', countries='', systemInstruction='') {
  for (const model of GEMINI_MODELS) {
    try {
      console.log(`Trying Gemini model: ${model}`);
      const text = await callGeminiModel(prompt, geminiKey, model, scope, countries, systemInstruction);
      if (text) return text;
    } catch (err) {
      console.warn(`${model} failed: ${err.message}. Trying next model...`);
    }
  }
  throw new Error('All Gemini models failed');
}

async function callGeminiModel(prompt, geminiKey, model, scope='', countries='', systemInstruction='') {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemInstruction || 'You are a Lead Sourcing & Procurement Analyst. Return a valid JSON array of suppliers only. No preamble. No markdown.' }] },
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: { temperature: 0.1, maxOutputTokens: 16384 }
      })
    }
  );
  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Gemini API error ${res.status}: ${err.substring(0, 200)}`);
  }
  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason || 'unknown';
  const text = candidate?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join('') || '';

  if (!text) {
    console.warn(`${model} returned empty content. finishReason: ${finishReason}. Trying follow-up...`);
    const geoReminder = scope === 'foreign'
      ? (countries ? `IMPORTANT: Only include suppliers from: ${countries}. Exclude ALL US companies.`
                   : `IMPORTANT: Only include non-US international suppliers. Exclude ALL US/American companies.`)
      : scope === 'domestic' ? `IMPORTANT: Only include US-based suppliers. Exclude ALL foreign companies.` : '';
    const followUp = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt + `\n\nReturn the JSON array now. ${geoReminder} Return ONLY a valid JSON array.` }] }],
          generationConfig: { temperature: 0.1, maxOutputTokens: 16384 }
        })
      }
    );
    const followData = await followUp.json();
    const followText = followData?.candidates?.[0]?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join('') || '';
    if (followText) { console.log(`Follow-up on ${model} succeeded`); return followText; }
    throw new Error(`${model} returned empty response (finishReason: ${finishReason})`);
  }
  console.log(`${model} response received (first 200 chars):`, text.substring(0, 200));
  return text;
}

// ── Claude fallback ────────────────────────────────────────────────────────
async function callClaude(prompt, anthropicKey, expectArray = true) {
  const system = expectArray
    ? 'Return only a valid JSON array. No markdown. No preamble.'
    : 'Return only a valid JSON object. No markdown. No preamble.';
  const res = await fetch('https://api.anthropic.com/v1/messages', {
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
    })
  });
  const data = await res.json();
  if (data.error) throw new Error(data.error.message || 'Claude error');
  return (data.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
}

// ── Perplexity Sonar API call ──────────────────────────────────────────────
// Sonar's grounded retrieval is purpose-built for "find all entities matching
// these criteria." Returns text + a separate citations array we splice into
// supplier source fields downstream.
async function callPerplexity(prompt, perplexityKey, systemInstruction = '') {
  // Sonar Pro: base was returning empty arrays / refusals on the elaborate prompt.
  // Pro does deeper multi-source retrieval and handles long structured prompts better.
  // Cost: ~$3 input / $15 output per 1M tokens — roughly 2-3¢ per search at our prompt sizes.
  const PERPLEXITY_MODEL = 'sonar-pro';
  const messages = [];
  if (systemInstruction) messages.push({ role: 'system', content: systemInstruction });
  messages.push({ role: 'user', content: prompt });

  const res = await fetch('https://api.perplexity.ai/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${perplexityKey}`
    },
    body: JSON.stringify({
      model: PERPLEXITY_MODEL,
      messages,
      max_tokens: 4000,
      temperature: 0.1,
      // search_recency_filter could be added later if we want a hard date floor
      return_citations: true
    })
  });
  const data = await res.json();
  if (!res.ok) {
    const msg = (data && (data.error?.message || data.message)) || `HTTP ${res.status}`;
    throw new Error(`Perplexity: ${msg}`);
  }
  const text = data.choices?.[0]?.message?.content || '';
  const citations = data.citations || [];
  if (!text.trim()) throw new Error('Perplexity returned empty content');
  console.log(`Perplexity returned ${text.length} chars, ${citations.length} citations`);
  return { text, citations };
}

function cleanCommodity(commodity) {
  return commodity
    .replace(/wholesale\s*only/gi, '').replace(/no\s*retail/gi, '')
    .replace(/retail\s*only/gi, '').replace(/domestic\s*only/gi, '')
    .replace(/usa\s*only/gi, '').replace(/us\s*only/gi, '')
    .replace(/\bonly\b/gi, '').replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ').trim().replace(/^,|,$/g, '').trim();
}

// ── /api/search ────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const geminiKey     = process.env.GEMINI_API_KEY;
  const anthropicKey  = process.env.ANTHROPIC_API_KEY;
  const perplexityKey = process.env.PERPLEXITY_API_KEY;

  if (!perplexityKey && !geminiKey && !anthropicKey) {
    return res.status(500).json({ error: 'No API keys configured' });
  }

  try {
    const { commodity, scope, certs, countries, hts, sources, selectedCountries, supplierType, imageData, imageType, mode, companyName, companyGeoScope, companyGeoCountries, companyContinents, dateFrom, dateTo } = req.body;
    const cleanedCommodity = cleanCommodity(commodity || '');
    const searchMode = (mode === 'company') ? 'company' : 'commodity';
    const targetCompany = (companyName || '').trim();

    // Validate date range — accept only YYYY-MM-DD strings; ignore otherwise
    const dateRx = /^\d{4}-\d{2}-\d{2}$/;
    const validDateFrom = (dateFrom && dateRx.test(dateFrom)) ? dateFrom : '';
    const validDateTo   = (dateTo   && dateRx.test(dateTo))   ? dateTo   : '';
    const hasDateRange  = searchMode === 'company' && validDateFrom && validDateTo && validDateFrom <= validDateTo;

    let geoSelected;
    let validContinents = [];

    if (searchMode === 'company') {
      // Company mode geo: scope (domestic/foreign/both) + optional continents + optional country list
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
      // 'both' adds nothing — implies global

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

    // Build engine-specific prompts. Different models respond differently to the same
    // instructions: Gemini does well with strict "HARD-FAIL" framing, Perplexity Sonar
    // applies it too literally and returns []. Claude has no live search so multi-search
    // instructions are wasted on it.
    function buildPrompts(engine) {
      const isPerplexity = engine === 'perplexity';
      const isClaude = engine === 'claude';

      // Strict-vs-permissive language toggles
      const hardFail = isPerplexity ? 'should not be included' : 'are HARD-FAILS';
      const zeroTolerance = isPerplexity ? '[INCLUSION CRITERIA]' : '[OUTPUT RULES - ZERO TOLERANCE]';
      const mustCiteEvidence = isPerplexity
        ? 'Each entry should describe evidence found (e.g. mention in 10-K, ImportYeti record, press release).'
        : 'Each entry needs specific evidence (named in a filing, listed on a supplier diversity page, appears in import records).';
      const refusalGuard = isPerplexity
        ? `If your first search returns mostly the target's customers or distributors, run 2-3 more searches with different queries before concluding. It is acceptable to include suppliers with moderate evidence (single press release, single news mention) ranked as "low" or "medium" fit. Returning fewer than 5 suppliers when the target has any public supplier disclosures suggests insufficient research depth.`
        : `Returning an empty array or a diagnostic explanation of why you couldn't find suppliers is a failure mode — research harder.`;

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

        // Build geography directive — make this a hard rule, not a hint
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

        // Build optional date-range section
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
[DIRECTION OF MONEY — CRITICAL]
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

[COMMODITY DATA]
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

    // Validate company mode has a target
    if (searchMode === 'company' && !targetCompany) {
      return res.status(400).json({ error: 'companyName is required for company search mode' });
    }


    let responseText;
    let perplexityCitations = [];
    let usedProvider = null;
    let perplexityRaw = null; // keep raw output around for diagnostic & fallback

    // Image searches must use Gemini (Perplexity API doesn't accept images).
    const hasImage = !!(imageData && imageType);

    // Helper that runs a single Gemini model with engine='gemini' prompts
    async function tryGeminiModel(modelName) {
      const prompts = buildPrompts('gemini');
      console.log(`Trying Gemini model: ${modelName}`);
      const text = await callGeminiModel(prompts.supplierPrompt, geminiKey, modelName, scope, countries, prompts.systemInstruction);
      if (text) {
        console.log(`${modelName} response received (first 200 chars): ${text.substring(0, 200)}`);
      }
      return text;
    }

    // Provider 1: Gemini 2.5 Pro — empirically the strongest for our prompt structure.
    // Returns 10-20 suppliers consistently on both modes.
    if (geminiKey) {
      try {
        responseText = await tryGeminiModel('gemini-2.5-pro');
        if (responseText) usedProvider = 'gemini';
      } catch (err) {
        console.warn(`gemini-2.5-pro failed: ${err.message}. Trying Perplexity next...`);
      }
    }

    // Provider 2: Perplexity Sonar Pro with permissive prompt — strong when it works,
    // and a different retrieval pipeline that may surface suppliers Gemini missed.
    // Skipped for image searches (Perplexity API doesn't accept images).
    if (!responseText && !hasImage && perplexityKey) {
      try {
        const prompts = buildPrompts('perplexity');
        console.log('Calling Perplexity Sonar Pro...');
        const result = await callPerplexity(prompts.supplierPrompt, perplexityKey, prompts.systemInstruction);
        perplexityRaw = result.text;
        perplexityCitations = result.citations || [];
        console.log('=== PERPLEXITY RAW (first 800 chars) ===');
        console.log(perplexityRaw.substring(0, 800));
        console.log('=== END PERPLEXITY RAW ===');
        let preflightSuppliers = null;
        try { preflightSuppliers = parseJSON(perplexityRaw); }
        catch (parseErr) { console.warn('Perplexity output failed JSON pre-flight parse:', parseErr.message); }
        const preflightCount = Array.isArray(preflightSuppliers) ? preflightSuppliers.length : -1;
        console.log(`Perplexity pre-flight supplier count: ${preflightCount}`);
        if (preflightCount > 0) {
          responseText = perplexityRaw;
          usedProvider = 'perplexity';
        } else {
          console.warn('Perplexity returned 0 parseable suppliers — falling through to Gemini Flash');
        }
      } catch (perplexityErr) {
        console.error('Perplexity failed:', perplexityErr.message);
      }
    }

    // Provider 3: Gemini 2.5 Flash — same family as Pro, smaller. Good when Pro is overloaded.
    if (!responseText && geminiKey) {
      try {
        responseText = await tryGeminiModel('gemini-2.5-flash');
        if (responseText) usedProvider = 'gemini';
      } catch (err) {
        console.warn(`gemini-2.5-flash failed: ${err.message}. Trying Gemini 1.5 Flash...`);
      }
    }

    // Provider 4: Gemini 1.5 Flash — last live-search fallback.
    if (!responseText && geminiKey) {
      try {
        responseText = await tryGeminiModel('gemini-1.5-flash');
        if (responseText) usedProvider = 'gemini';
      } catch (err) {
        console.warn(`gemini-1.5-flash failed: ${err.message}.`);
      }
    }

    // If everything failed but we have Perplexity raw output, use it anyway
    if (!responseText && perplexityRaw) {
      console.log('All Gemini models failed — using Perplexity raw output despite low pre-flight count');
      responseText = perplexityRaw;
      usedProvider = 'perplexity';
    }

    // Provider 5: Claude Haiku — offline-knowledge final fallback (no live web).
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
        // Geography filter is for commodity searches only.
        // In company-search mode, real vendors can be anywhere — don't filter them out.
        if (searchMode !== 'company') {
          suppliers = filterByScope(suppliers, scope, countries, selectedCountries);
        } else {
          // Strip junk + non-supplier entities (universities, agencies, etc) + the target itself
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
            // Self-incriminating fitReason: AI sometimes returns an entity while admitting in
            // the same field that it's a customer/distributor/reseller, not a supplier
            const reason = (s.fitReason || '') + ' ' + (s.specialty || '');
            if (/\b(customer of|rather than a supplier|not a supplier|is a customer|sells .* products|distributor of|reseller of|retailer of|buys from)\b/i.test(reason)) {
              console.log(`  [self-incriminating fitReason] excluding "${s.name}": ${s.fitReason?.substring(0,100)}`);
              return false;
            }
            return true;
          });
          console.log(`Company-mode exclusion filter: ${beforeExcl} → ${suppliers.length}`);

          // Enforce company-mode geography scope
          // Treat location as "unknown" only when the whole string is a known unknown marker —
          // NOT when "na" or "unknown" appears as a substring (the old regex matched China,
          // Argentina, Ghana, etc. as "unknown" because they contain "na").
          const isUnknownLocation = (loc) => {
            const t = (loc || '').trim().toLowerCase();
            return !t || t === 'n/a' || t === 'na' || t === 'unknown' || t === 'not specified' || t === 'not provided' || t === '-' || t === 'tbd';
          };

          if (companyGeoScope === 'domestic') {
            suppliers = suppliers.filter(s => {
              const loc = s.location || '';
              if (isUnknownLocation(loc)) {
                console.log(`  [domestic filter] excluding "${s.name}" — unknown location`);
                return false; // unknowns excluded in domestic mode (safer default)
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
                return false; // unknowns excluded in foreign mode too
              }
              const passes = !isUSLocation(loc);
              if (!passes) console.log(`  [foreign filter] excluding "${s.name}" — US location: ${loc}`);
              return passes;
            });
          }

          // Apply continent filter on top, if any continents were selected
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

    // If Perplexity supplied citations and a supplier's source field is empty/generic,
    // attach the most relevant citation URL so the user can verify.
    if (perplexityCitations.length && Array.isArray(suppliers)) {
      suppliers.forEach(s => {
        if (!s.source || /^(web search|direct|search results?|n\/?a|unknown)$/i.test(s.source)) {
          s.source = 'Perplexity (multi-source)';
        }
      });
      // Replace responseText so frontend gets the enriched data
      responseText = JSON.stringify(suppliers);
    }

    const usedLiveSearch = usedProvider === 'perplexity' || usedProvider === 'gemini';

    res.json({
      claudeData: {
        content: [{ type: 'text', text: responseText }]
      },
      usedSerpApi: usedLiveSearch,
      usedGemini: usedProvider === 'gemini',
      usedPerplexity: usedProvider === 'perplexity',
      usedProvider,
      perplexityCitations: perplexityCitations.slice(0, 30) // cap so we don't bloat payload
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

    // Format the due date as e.g. "May 19, 2026" if provided. Validate the format
    // server-side so bad input doesn't get injected into the prompt.
    let dueDateNote = '';
    if (dueDate && /^\d{4}-\d{2}-\d{2}$/.test(dueDate)) {
      // Parse without timezone shifts (interpret YYYY-MM-DD literally)
      const [y, m, d] = dueDate.split('-').map(Number);
      const dt = new Date(Date.UTC(y, m - 1, d));
      const formatted = dt.toLocaleDateString('en-US', {
        timeZone: 'UTC', year: 'numeric', month: 'long', day: 'numeric'
      });
      dueDateNote = ` Include this exact line near the end of the second paragraph: "Please provide pricing by ${formatted}."`;
    }

    // Optional sourcing context (product links, part numbers, target volumes, etc.)
    // Sanitize: cap length and strip any prompt-injection-style markers, but
    // preserve URLs and line breaks so the model can reference them faithfully.
    let contextBlock = '';
    if (typeof emailContext === 'string' && emailContext.trim()) {
      const cleaned = emailContext.trim().slice(0, 2000);
      contextBlock = `

The sender provided the following sourcing context to weave into the email body. Reference the relevant pieces (especially product links, part numbers, and target volumes) naturally — do NOT dump it verbatim or as a bulleted list unless that's the natural shape of the information. Preserve any URLs exactly as written:
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
- body (string — 3 short paragraphs:
    1. Introduce [Your Name], [Your Title] from [Your Company] and the sourcing need, referencing [SUPPLIER_NAME] specialty
    2. Request a quote or capabilities discussion${includeAttach && attachList ? ', mention the attached documents' : ''}${dueDateNote ? ', include the pricing-by date line provided above' : ''}${contextBlock ? ', and naturally reference the sourcing context above (product links, part numbers, volumes) where it fits' : ''}
    3. Polite closing with a call to action
  Do NOT include a signature block.)

Return ONLY a valid JSON object. No markdown. No preamble.`;

    let responseText;

    if (geminiKey) {
      try {
        responseText = await callGemini(emailPrompt, geminiKey);
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
  const hasGemini     = !!process.env.GEMINI_API_KEY;
  const hasAnthropic  = !!process.env.ANTHROPIC_API_KEY;
  const hasPerplexity = !!process.env.PERPLEXITY_API_KEY;
  console.log(`SupplierScout running on port ${PORT}`);
  console.log(`Gemini:     ${hasGemini     ? '✓ configured (primary)'  : '✗ not set'}`);
  console.log(`Perplexity: ${hasPerplexity ? '✓ configured (fallback)' : '✗ not set'}`);
  console.log(`Claude:     ${hasAnthropic  ? '✓ configured (fallback)' : '✗ not set'}`);
  if (!hasGemini) console.log('⚠ Add GEMINI_API_KEY to Railway for live search grounding');
});
