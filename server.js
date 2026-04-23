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

// ── HTS/Tariff daily cache (in-memory — swap getHTSCache/setHTSCache for DB calls) ──
const _htsCache = new Map();

function todayKey() {
  return new Date().toISOString().split('T')[0]; // YYYY-MM-DD
}

function getHTSCache(cacheKey) {
  // TODO: replace with DB lookup — SELECT * FROM hts_cache WHERE cache_key=? AND cache_date=TODAY
  const entry = _htsCache.get(cacheKey);
  if (!entry) return null;
  if (entry.date !== todayKey()) { _htsCache.delete(cacheKey); return null; }
  return entry.data;
}

function setHTSCache(cacheKey, data) {
  // TODO: replace with DB upsert — INSERT OR REPLACE INTO hts_cache (cache_key, cache_date, data)
  _htsCache.set(cacheKey, { date: todayKey(), data });
}

function buildHTSCacheKey(commodity, htsOverride) {
  const base = (commodity + '|' + (htsOverride || 'auto')).toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_|.]/g, '');
  return 'hts_' + base.substring(0, 120);
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

// ── Gemini call with model cascade ────────────────────────────────────────
const GEMINI_MODELS = ['gemini-2.5-flash-lite', 'gemini-2.5-flash', 'gemini-1.5-flash'];

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

// ── Gemini call WITH Google Search grounding (for live tariff lookups) ──
async function callGeminiJSON(prompt, geminiKey) {
  for (const model of GEMINI_MODELS) {
    try {
      // First attempt: with Google Search grounding for live/accurate tariff data
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: 'You are a US customs and trade compliance expert with access to current tariff data. Use Google Search to find the most current US import duty rates. Return only valid JSON with no markdown or preamble.' }] },
            contents: [{ parts: [{ text: prompt }] }],
            tools: [{ googleSearch: {} }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
          })
        }
      );
      if (!res.ok) { const e = await res.text(); throw new Error(`Gemini ${res.status}: ${e.substring(0,200)}`); }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join('') || '';
      if (text) { console.log(`HTS tariff lookup via ${model} with search succeeded`); return text; }

      // Fallback: without search tool if grounded call returned empty
      console.warn(`${model} grounded call empty, retrying without search tool...`);
      const res2 = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: 'You are a US customs and trade compliance expert. Return only valid JSON. No markdown. No preamble.' }] },
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 4096 }
          })
        }
      );
      const data2 = await res2.json();
      const text2 = data2?.candidates?.[0]?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join('') || '';
      if (text2) return text2;
      throw new Error('Empty response from both attempts');
    } catch (err) {
      console.warn(`callGeminiJSON ${model} failed: ${err.message}`);
    }
  }
  throw new Error('All Gemini models failed for tariff lookup');
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

function cleanCommodity(commodity) {
  return commodity
    .replace(/wholesale\s*only/gi, '').replace(/no\s*retail/gi, '')
    .replace(/retail\s*only/gi, '').replace(/domestic\s*only/gi, '')
    .replace(/usa\s*only/gi, '').replace(/us\s*only/gi, '')
    .replace(/\bonly\b/gi, '').replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ').trim().replace(/^,|,$/g, '').trim();
}

// ── USITC HTS API helpers ────────────────────────────────────────────────────

// Country ISO codes for USITC API
const COUNTRY_ISO = {
  'china': 'CN', 'taiwan': 'TW', 'india': 'IN', 'mexico': 'MX', 'canada': 'CA',
  'germany': 'DE', 'japan': 'JP', 'south korea': 'KR', 'korea': 'KR',
  'united kingdom': 'GB', 'uk': 'GB', 'vietnam': 'VN', 'italy': 'IT',
  'france': 'FR', 'ireland': 'IE', 'switzerland': 'CH', 'netherlands': 'NL',
  'malaysia': 'MY', 'thailand': 'TH', 'brazil': 'BR', 'belgium': 'BE',
  'singapore': 'SG', 'australia': 'AU', 'indonesia': 'ID', 'israel': 'IL',
  'spain': 'ES', 'austria': 'AT', 'cambodia': 'KH', 'poland': 'PL',
  'czech republic': 'CZ', 'sweden': 'SE', 'denmark': 'DK', 'finland': 'FI',
  'norway': 'NO', 'hungary': 'HU', 'romania': 'RO', 'turkey': 'TR',
  'ukraine': 'UA', 'russia': 'RU', 'hong kong': 'HK', 'uae': 'AE',
  'bangladesh': 'BD', 'pakistan': 'PK', 'sri lanka': 'LK', 'ethiopia': 'ET'
};

function getISO(countryName) {
  return COUNTRY_ISO[(countryName || '').toLowerCase().trim()] || null;
}

// ── Static MFN base rate lookup by HTS heading ────────────────────────────────
// Source: USITC HTS Schedule Column 1 General rates (2025)
// Base MFN rates are set by statute — additional duties are separate
const MFN_RATES_4 = {
  // Ch 39 Plastics
  3907:6.5,3908:6.5,3909:6.5,3916:4.8,3917:3.8,3918:5.3,3919:5.3,3920:4.2,
  3921:4.2,3922:6.3,3923:3,3924:3.4,3925:5.3,3926:5.3,
  // Ch 40 Rubber
  4008:2.5,4009:2.5,4010:3,4011:4,4013:4,4014:4,4015:3,4016:2.5,
  // Ch 44 Wood
  4407:0,4408:0,4409:0,4410:0,4411:0,4412:0,4413:0,4414:3.2,4415:0,
  4416:0,4417:5.1,4418:0,4419:3.2,4420:3.2,4421:3.5,
  // Ch 73 Iron/Steel articles
  7307:3,7309:3.7,7326:2.9,
  // Ch 74 Copper
  7403:1,7405:3,7406:3,7407:1,7408:1,7409:1,7410:1,7411:3,7412:3,7415:3,
  7418:3,7419:3,
  // Ch 76 Aluminum
  7604:3,7605:4.9,7606:3,7608:3,7610:5.7,7615:3.8,
  // Ch 82 Tools
  8201:0,8202:0,8203:0,8204:9,8205:9,8206:9,8207:5,8208:4.2,8209:4.9,
  8211:0.4,8213:0.5,8214:0.4,
  // Ch 83 Misc metal
  8301:5.7,8302:3.5,8303:3.8,8305:0.5,8308:2.7,
  // Ch 84 Machinery — mostly free
  8413:0,8414:0,8415:0,8418:0,8419:0,8421:0,8422:0,8424:0,8425:0,
  8426:0,8427:0,8428:0,8429:0,8430:0,8431:0,8432:0,8433:0,8434:0,
  8435:0,8436:0,8437:0,8438:0,8439:0,8440:0,8441:0,8442:0,8443:0,
  8450:0,8451:0,8452:0,8460:0,8462:0,8463:0,8464:0,8465:0,8466:0,
  8467:0,8468:0,8473:0,8474:0,8475:0,8476:0,8477:0,8478:0,8479:0,
  8480:0,8481:2,8482:0,8483:0,8484:0,8485:0,8487:0,
  // Ch 85 Electrical — mostly free
  8501:0,8502:0,8503:0,8504:0,8505:0,8506:0,8507:0,8508:0,8509:0,
  8510:0,8511:0,8512:0,8513:0,8514:0,8515:0,8516:0,8517:0,8518:0,
  8519:0,8521:0,8522:0,8523:0,8524:0,8525:0,8526:0,8527:0,8528:0,
  8529:0,8530:0,8531:0,8532:0,8533:0,8534:0,8535:0,8536:0,8537:0,
  8538:0,8539:0,8540:0,8541:0,8542:0,8543:0,8544:0,8545:0,8546:0,8547:0,
  // Ch 90 Instruments
  9003:4.5,9004:2,
};

// Specific 6-digit subheading overrides (and 8-digit where rates differ)
const MFN_RATES_8 = {
  // 8481.80.30 — Hand-operated valves of iron/steel, ball type: 5.6%
  84818030: 5.6,
  // 8481.80.10 — Hand-operated valves, pressure-reducing: 2%
  84818010: 2,
  // 8481.80.50 — Hand-operated valves of copper: 3%
  84818050: 3,
};

const MFN_RATES_6 = {
  // 8481 Valves — 2% general
  848110:2,848120:2,848130:2,848140:2,848151:2,848159:2,848160:2,
  848170:2,848180:2,848190:2,
  // 7307 Pipe fittings
  730711:4.5,730719:4.5,730721:0,730722:0,730723:0,730729:0,
  730791:4.3,730792:4.3,730793:4.3,730799:4.3,
  // 7412 Copper tube fittings
  741210:3,741220:3,
  // 8413 Pumps
  841311:0,841319:0,841320:0,841330:0,841340:0,841350:0,841360:0,
  841370:0,841381:0,841382:0,
};

function lookupMFNRate(htsCode) {
  const clean = htsCode.replace(/[.\s-]/g, '');
  const sub8 = parseInt(clean.substring(0, 8));
  if (!isNaN(sub8) && MFN_RATES_8[sub8] !== undefined) return MFN_RATES_8[sub8];
  const sub6 = parseInt(clean.substring(0, 6));
  if (!isNaN(sub6) && MFN_RATES_6[sub6] !== undefined) return MFN_RATES_6[sub6];
  const head4 = parseInt(clean.substring(0, 4));
  if (!isNaN(head4) && MFN_RATES_4[head4] !== undefined) return MFN_RATES_4[head4];
  return null;
}

// Additional tariff programs by country (Section 301, IEEPA, Section 232)
// These are layered ON TOP of the MFN base rate
// Updated April 2025 — always verify with CBP/customs broker
function getAdditionalDuties(countryName, htsCode) {
  const c = (countryName || '').toLowerCase();
  const hts = (htsCode || '').replace(/\./g, '');

  // China — Section 301 + Section 122 Import Surcharge
  // Per USITC calculator as of April 2025:
  // Most industrial goods: Section 301 List 3 (25%) + Section 122 surcharge (10%) = 35% additional
  // Verify at hts.usitc.gov — rates are actively changing
  if (c === 'china' || c === 'cn') {
    return { additional: '35.0%', type: 'Section 301 + Sec. 122 surcharge', note: 'Per USITC April 2025: Section 301 List 3 (25%) + Section 122 Import Surcharge (10%). Verify at hts.usitc.gov — actively changing.' };
  }

  // Canada — IEEPA 25% on non-USMCA goods; 0% on USMCA-qualifying
  if (c === 'canada' || c === 'ca') {
    return { additional: '25.0%', type: 'IEEPA (non-USMCA)', note: 'USMCA-qualifying goods: 0% additional. Non-qualifying: 25% IEEPA tariff.' };
  }

  // Mexico — IEEPA 25% on non-USMCA goods
  if (c === 'mexico' || c === 'mx') {
    return { additional: '25.0%', type: 'IEEPA (non-USMCA)', note: 'USMCA-qualifying goods: 0% additional. Non-qualifying: 25% IEEPA tariff.' };
  }

  // India — IEEPA 26% reciprocal tariff (paused 90 days from April 2025, 10% floor in effect)
  if (c === 'india' || c === 'in') {
    return { additional: '10.0%', type: 'IEEPA (90-day pause)', note: 'Reciprocal tariff paused to 10% through ~July 2025. Verify current status.' };
  }

  // Vietnam — IEEPA 46% paused to 10%
  if (c === 'vietnam' || c === 'vn') {
    return { additional: '10.0%', type: 'IEEPA (90-day pause)', note: 'Reciprocal tariff paused to 10% through ~July 2025. Verify current status.' };
  }

  // EU countries — IEEPA 20% paused to 10%
  const eu = ['germany','de','france','fr','italy','it','spain','es','netherlands','nl',
    'belgium','be','austria','at','ireland','ie','poland','pl','sweden','se',
    'denmark','dk','finland','fi','czech republic','cz','hungary','hu','romania','ro'];
  if (eu.includes(c)) {
    return { additional: '10.0%', type: 'IEEPA (90-day pause)', note: 'EU reciprocal tariff paused to 10% through ~July 2025. Verify current status.' };
  }

  // Taiwan — IEEPA 32% paused to 10%
  if (c === 'taiwan' || c === 'tw') {
    return { additional: '10.0%', type: 'IEEPA (90-day pause)', note: 'Reciprocal tariff paused to 10% through ~July 2025. Verify current status.' };
  }

  // Japan — IEEPA 24% paused to 10%
  if (c === 'japan' || c === 'jp') {
    return { additional: '10.0%', type: 'IEEPA (90-day pause)', note: 'Reciprocal tariff paused to 10% through ~July 2025. Verify current status.' };
  }

  // South Korea — IEEPA 25% paused to 10%
  if (c === 'south korea' || c === 'korea' || c === 'kr') {
    return { additional: '10.0%', type: 'IEEPA (90-day pause)', note: 'Reciprocal tariff paused to 10% through ~July 2025. Verify current status.' };
  }

  // Malaysia, Thailand, Indonesia, Cambodia — IEEPA varying, paused to 10%
  const sea = ['malaysia','my','thailand','th','indonesia','id','cambodia','kh','singapore','sg'];
  if (sea.includes(c)) {
    return { additional: '10.0%', type: 'IEEPA (90-day pause)', note: 'Reciprocal tariff paused to 10% through ~July 2025. Verify current status.' };
  }

  // Default — 10% universal baseline IEEPA
  return { additional: '10.0%', type: 'IEEPA baseline', note: 'Universal 10% baseline tariff applies. Verify if higher rate is paused.' };
}

function parseRateToFloat(rateStr) {
  if (!rateStr) return 0;
  const match = String(rateStr).match(/([\d.]+)%/);
  return match ? parseFloat(match[1]) : 0;
}

// ── /api/hts-tariff — real USITC rates + structured additional duties ─────────
app.post('/api/hts-tariff', async (req, res) => {
  const geminiKey    = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!geminiKey && !anthropicKey) {
    return res.status(500).json({ error: 'No API keys configured' });
  }

  try {
    const { commodity, htsOverride, countries } = req.body;
    if (!commodity && !htsOverride) {
      return res.status(400).json({ error: 'commodity or htsOverride required' });
    }

    const countryList = [...new Set((countries || []).filter(c => c && c !== 'USA' && c !== 'United States'))];
    const ck = buildHTSCacheKey(commodity || '', htsOverride || '');
    const cached = getHTSCache(ck);
    if (cached) {
      console.log('HTS cache hit:', ck);
      return res.json({ ...cached, cached: true });
    }

    // ── Step 1: Get HTS code — use override or infer via AI ──────────────────
    let htsCode = htsOverride || null;
    let htsDescription = '';
    let assumed = !htsCode;
    let reasoning = '';

    if (!htsCode) {
      // Ask AI to classify the product
      const classifyPrompt = `Classify this product under the US Harmonized Tariff Schedule (HTS).
Product: "${commodity}"
Return ONLY valid JSON (no markdown):
{"hts_code":"NNNN.NN.NNNN","description":"official brief description","reasoning":"one sentence"}`;

      let classifyText;
      if (geminiKey) {
        try { classifyText = await callGeminiJSON(classifyPrompt, geminiKey); } catch(e) { classifyText = null; }
      }
      if (!classifyText && anthropicKey) {
        classifyText = await callClaude(classifyPrompt, anthropicKey, false);
      }
      if (classifyText) {
        const parsed = parseJSON(classifyText);
        htsCode = parsed.hts_code || '';
        htsDescription = parsed.description || '';
        reasoning = parsed.reasoning || '';
      }
    }

    if (!htsCode) throw new Error('Could not determine HTS code');

    // ── Step 2: Look up base MFN rate from static USITC table ──────────────────
    let baseMfnFloat = lookupMFNRate(htsCode);

    // If HTS not in static table, ask AI for just the base MFN rate
    if (baseMfnFloat === null) {
      console.log(`HTS ${htsCode} not in static table, asking AI for base MFN rate...`);
      try {
        const mfnPrompt = `What is the US MFN (Column 1 General) base duty rate for HTS code ${htsCode}? Return ONLY valid JSON: {"base_mfn_rate": X.X, "description": "brief description"} where base_mfn_rate is a number like 2.0 or 0 for free.`;
        let mfnText;
        if (geminiKey) { try { mfnText = await callGeminiJSON(mfnPrompt, geminiKey); } catch(e) { mfnText = null; } }
        if (!mfnText && anthropicKey) { mfnText = await callClaude(mfnPrompt, anthropicKey, false); }
        if (mfnText) {
          const mfnParsed = parseJSON(mfnText);
          baseMfnFloat = parseFloat(mfnParsed.base_mfn_rate) || 0;
          if (!htsDescription && mfnParsed.description) htsDescription = mfnParsed.description;
        }
      } catch(e) { console.warn('AI MFN fallback failed:', e.message); }
      if (baseMfnFloat === null) baseMfnFloat = 0;
    }

    const baseMfnStr = baseMfnFloat.toFixed(1) + '%';
    console.log(`MFN rate for ${htsCode}: ${baseMfnStr}`);

    // ── Step 3: Build per-country rates ──────────────────────────────────────
    const rates = {};
    for (const country of countryList) {
      const extra = getAdditionalDuties(country, htsCode);
      const extraFloat = parseRateToFloat(extra.additional);
      const totalFloat = baseMfnFloat + extraFloat;
      const totalStr = totalFloat.toFixed(1) + '%';

      rates[country] = {
        total_rate: totalStr,
        base_mfn: baseMfnStr,
        additional_duties: extra.additional,
        additional_type: extra.type,
        notes: extra.note
      };
    }

    const result = {
      hts_code: htsCode,
      hts_description: htsDescription,
      assumed,
      reasoning,
      source: 'USITC HTS Schedule',
      rates
    };

    setHTSCache(ck, result);
    console.log(`HTS tariff complete: ${htsCode} (${assumed ? 'inferred' : 'confirmed'}) via ${result.source}`);
    res.json({ ...result, cached: false });

  } catch (err) {
    console.error('HTS tariff error:', err);
    res.status(500).json({ error: err.message });
  }
});
// ── /api/search ────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const geminiKey   = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!geminiKey && !anthropicKey) {
    return res.status(500).json({ error: 'No API keys configured' });
  }

  try {
    const { commodity, scope, certs, countries, hts, sources, selectedCountries, supplierType, imageData, imageType } = req.body;
    const cleanedCommodity = cleanCommodity(commodity);

    const countryList = selectedCountries && selectedCountries.length ? selectedCountries : [];
    const hasUSA = countryList.includes('USA');
    const foreignCountries = countryList.filter(c => c !== 'USA');
    const allDomestic = hasUSA && foreignCountries.length === 0;
    const allForeign = foreignCountries.length > 0 && !hasUSA;
    const mixed = hasUSA && foreignCountries.length > 0;

    const geoSelected = allDomestic ? 'United States'
      : allForeign ? foreignCountries.join(', ')
      : mixed ? `United States, ${foreignCountries.join(', ')}`
      : 'Global (no restriction)';

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

    const systemInstruction = `You are a Lead Sourcing & Procurement Analyst. You provide raw data in JSON format.
CRITICAL: You are currently restricted to ${geoSelected} suppliers only. If a company is not headquartered or manufacturing in ${geoSelected}, it is a hard-fail; do not include it.
No preamble. No conversational filler. No markdown formatting blocks (no \`\`\`json). Output the raw JSON array immediately.`;

    const supplierPrompt = `[GOAL]
Perform deep-web research using Google Search to identify verified ${geoSelected} manufacturers/distributors for the following commodity.

[COMMODITY DATA]
- Commodity: "${cleanedCommodity}"
- Required Certs: ${certText}
- HTS Code: ${htsText}
- Geography Scope: ${geoSelected} ONLY. (Strictly exclude all entities outside ${geoSelected}).

[RESEARCH PROTOCOL]
1. EXECUTE SEARCH: Use the search tool to query: "${cleanedCommodity} manufacturer ${geoSelected}", "${cleanedCommodity} domestic supplier", and ${sourceInstructions}.
2. VALIDATE ENTITY: You must identify the SPECIFIC COMPANY NAME. If a search result is a list or directory (e.g. Alibaba, ThomasNet, Kompass), you MUST extract the names of the companies within that list.
3. VERIFY LOCATION: Confirm the Contact or About page lists a physical address in ${geoSelected}. Discard any results outside ${geoSelected}.
4. PRIORITIZE: Rank results by Manufacturer first, then Distributor/Master Distributor.

[OUTPUT RULES - ZERO TOLERANCE]
- RETURN ONLY A JSON ARRAY.
- NO MARKDOWN: Do not use \`\`\`json or any backticks. Start with [ and end with ].
- NO PLACEHOLDERS: If you cannot find a specific company name, do not create an entry.
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

    let responseText;
    let usedGemini = false;

    if (geminiKey) {
      try {
        console.log('Calling Gemini with Google Search grounding...');
        responseText = await callGemini(supplierPrompt, geminiKey, scope, countries, systemInstruction);
        usedGemini = true;
        console.log('Gemini response received');
      } catch (geminiErr) {
        console.error('Gemini failed:', geminiErr.message);
        responseText = null;
      }
    }

    if (!responseText && anthropicKey) {
      console.log('Using Claude fallback...');
      responseText = await callClaude(supplierPrompt, anthropicKey, true);
    }

    if (!responseText) throw new Error('All AI providers failed');

    let suppliers;
    try {
      suppliers = parseJSON(responseText);
      if (Array.isArray(suppliers)) {
        const before = suppliers.length;
        suppliers = filterByScope(suppliers, scope, countries, selectedCountries);
        if (supplierType && supplierType !== 'both') {
          suppliers = filterBySupplierType(suppliers, supplierType);
          console.log(`Supplier type filter (${supplierType}): ${suppliers.length} remaining`);
        }
        console.log(`Geography filter: ${before} → ${suppliers.length} suppliers (scope: ${scope})`);
        suppliers.forEach((s, i) => s.id = i + 1);
      }
      responseText = JSON.stringify(suppliers);
    } catch(e) {
      console.warn('Could not apply geography filter:', e.message);
    }

    res.json({
      claudeData: {
        content: [{ type: 'text', text: responseText }]
      },
      usedSerpApi: usedGemini,
      usedGemini
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
    const { commodity, includeAttach, attachList } = req.body;
    const attachNote = includeAttach && attachList
      ? ` Reference that attachments are included: ${attachList}.` : '';

    const emailPrompt = `Write a professional supplier outreach email template for sourcing: "${commodity}"${attachNote}

Use these exact placeholders — do not substitute them with example text:
- [SUPPLIER_NAME] — the supplier company name
- [Your Name] — the sender's name
- [Your Title] — the sender's job title
- [Your Company] — the sender's company (use this exact string, not "[Your Company Name]")

Return a JSON object with:
- subject (string — professional subject line, may include [Your Company])
- body (string — 3 short paragraphs:
    1. Introduce [Your Name], [Your Title] from [Your Company] and the sourcing need, referencing [SUPPLIER_NAME] specialty
    2. Request a quote or capabilities discussion${includeAttach && attachList ? ', mention the attached documents' : ''}
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
  const hasGemini    = !!process.env.GEMINI_API_KEY;
  const hasAnthropic = !!process.env.ANTHROPIC_API_KEY;
  console.log(`SupplierScout running on port ${PORT}`);
  console.log(`Gemini:  ${hasGemini    ? '✓ configured (primary)'  : '✗ not set'}`);
  console.log(`Claude:  ${hasAnthropic ? '✓ configured (fallback)' : '✗ not set'}`);
  if (!hasGemini) console.log('⚠ Add GEMINI_API_KEY to Railway for live search grounding');
});
