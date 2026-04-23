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

// ── Gemini call WITHOUT search tool (for structured JSON tasks like HTS) ──
async function callGeminiJSON(prompt, geminiKey) {
  for (const model of GEMINI_MODELS) {
    try {
      const res = await fetch(
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
      if (!res.ok) { const e = await res.text(); throw new Error(`Gemini ${res.status}: ${e.substring(0,200)}`); }
      const data = await res.json();
      const text = data?.candidates?.[0]?.content?.parts?.filter(p => p.text)?.map(p => p.text)?.join('') || '';
      if (text) return text;
      throw new Error('Empty response');
    } catch (err) {
      console.warn(`callGeminiJSON ${model} failed: ${err.message}`);
    }
  }
  throw new Error('All Gemini models failed for JSON call');
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

// ── /api/hts-tariff — infer HTS code and look up tariff rates ─────────────
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

    // Unique countries list
    const countryList = [...new Set((countries || []).filter(c => c && c !== 'USA'))];

    // Check daily cache first
    const ck = buildHTSCacheKey(commodity || '', htsOverride || '');
    const cached = getHTSCache(ck);
    if (cached) {
      console.log('HTS cache hit:', ck);
      return res.json({ ...cached, cached: true });
    }

    const htsPrompt = htsOverride
      ? `The user has provided HTS code: ${htsOverride} for this product: "${commodity}".
Verify this is a plausible HTS code and return the official description.
Then look up the current US import duty rates for importing under this HTS code from each of these countries: ${countryList.join(', ') || 'general'}.

Include:
- Base MFN (Most Favored Nation) rate
- Any Section 301 tariffs (China)
- Any IEEPA emergency tariffs (2025)
- Any Section 232 tariffs
- Total combined rate

Return ONLY valid JSON (no markdown):
{
  "hts_code": "${htsOverride}",
  "hts_description": "official USITC description",
  "assumed": false,
  "rates": {
    "CountryName": {
      "total_rate": "XX.X%",
      "base_mfn": "X.X%",
      "additional_duties": "XX%",
      "additional_type": "Section 301 / IEEPA / Section 232 / None",
      "notes": "brief note on applicable tariff programs"
    }
  }
}`
      : `You are a US customs classification expert with current knowledge of the USITC Harmonized Tariff Schedule.

Product description: "${commodity}"

Step 1: Determine the most accurate 10-digit HTS code for this product.
Step 2: Look up the current US import duty rates for this HTS code from each of these countries: ${countryList.join(', ') || 'general'}.

Include:
- Base MFN rate
- Section 301 tariffs if applicable (mainly China)
- IEEPA emergency tariffs (2025) if applicable
- Section 232 tariffs if applicable (steel/aluminum)
- Total combined rate

Be accurate and specific. As of 2025:
- China faces heavy additional duties (Section 301 + IEEPA, often 125-145% additional)
- India: typically base MFN only unless specific programs apply
- Taiwan: typically base MFN only
- Mexico/Canada: often 0% under USMCA for qualifying goods, but check IEEPA 25% tariff
- Vietnam: base MFN, some Section 301 exposure

Return ONLY valid JSON (no markdown):
{
  "hts_code": "NNNN.NN.NNNN",
  "hts_description": "official USITC description",
  "assumed": true,
  "reasoning": "brief explanation of classification",
  "rates": {
    "CountryName": {
      "total_rate": "XX.X%",
      "base_mfn": "X.X%",
      "additional_duties": "XX%",
      "additional_type": "Section 301 / IEEPA / Section 232 / None",
      "notes": "brief note"
    }
  }
}`;

    let responseText;

    // Try Gemini first (no search tool needed — uses training knowledge for tariffs)
    if (geminiKey) {
      try {
        responseText = await callGeminiJSON(htsPrompt, geminiKey);
      } catch (e) {
        console.warn('Gemini HTS lookup failed, trying Claude:', e.message);
        responseText = null;
      }
    }

    // Fall back to Claude
    if (!responseText && anthropicKey) {
      responseText = await callClaude(htsPrompt, anthropicKey, false);
    }

    if (!responseText) throw new Error('All AI providers failed for HTS lookup');

    const parsed = parseJSON(responseText);

    // Cache and return
    setHTSCache(ck, parsed);
    console.log(`HTS lookup complete: ${parsed.hts_code} (${parsed.assumed ? 'inferred' : 'confirmed'})`);
    res.json({ ...parsed, cached: false });

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
