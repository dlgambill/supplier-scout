const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── JSON parser (shared) ───────────────────────────────────────────────────
function parseJSON(text) {
  // Strip markdown code fences if present
  text = text.replace(/```json[\s\S]*?```/g, m => m.slice(7, -3))
             .replace(/```[\s\S]*?```/g, m => m.slice(3, -3))
             .trim();
  // Remove control characters
  text = text.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');

  // Find the first [ or { to start extraction
  const firstBracket = text.indexOf('[');
  const firstBrace   = text.indexOf('{');
  if (firstBracket === -1 && firstBrace === -1)
    throw new Error('No JSON found in response. Raw text: ' + text.substring(0, 300));

  // Determine if we're extracting an array or object
  const isArray = firstBracket !== -1 && (firstBrace === -1 || firstBracket < firstBrace);
  const openChar  = isArray ? '[' : '{';
  const closeChar = isArray ? ']' : '}';
  const start = isArray ? firstBracket : firstBrace;

  // Walk forward counting brackets to find the matching close
  let depth = 0;
  let inString = false;
  let escape = false;
  let end = -1;
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
  const jsonStr = text.slice(start, end + 1);
  return JSON.parse(jsonStr);
}

// ── Geography filter — applied after Gemini returns results ──────────────────
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
  // Check if ends with a US state abbreviation: "City, TX"
  const parts = upper.split(',').map(p => p.trim());
  const last = parts[parts.length - 1];
  return US_STATES.has(last);
}

function filterByScope(suppliers, scope, countries) {
  if (!Array.isArray(suppliers)) return suppliers;
  if (scope === 'domestic') {
    // Keep only US suppliers — if location unknown, keep it (can't confirm it's foreign)
    return suppliers.filter(s => {
      const loc = (s.location || '').toUpperCase();
      if (!loc || loc === 'N/A' || loc === 'UNKNOWN') return true; // keep unknowns
      return isUSLocation(s.location);
    });
  }
  if (scope === 'foreign') {
    // Remove US suppliers
    return suppliers.filter(s => {
      if (!s.location || s.location === 'N/A' || s.location === 'Unknown') return true;
      return !isUSLocation(s.location);
    });
  }
  return suppliers; // 'both' — no filtering
}

// ── Gemini call with Google Search grounding ───────────────────────────────
async function callGemini(prompt, geminiKey, scope='', countries='') {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: 'You are a sourcing analyst. After searching, you MUST return a JSON array. Never return an empty response.' }] },
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ googleSearch: {} }],
        generationConfig: {
          temperature: 0.1,
          maxOutputTokens: 16384
        }
      })
    }
  );
  if (!res.ok) {
    const err = await res.text();
    console.error('Gemini API raw error:', err);
    throw new Error(`Gemini API error ${res.status}: ${err}`);
  }
  const data = await res.json();
  const candidate = data?.candidates?.[0];
  const finishReason = candidate?.finishReason || 'unknown';
  const text = candidate?.content?.parts
    ?.filter(p => p.text)
    ?.map(p => p.text)
    ?.join('') || '';
  if (!text) {
    // Gemini used all tokens on search tool but returned no content
    // Extract grounding sources and make a second no-tool call to format results
    const grounding = data?.candidates?.[0]?.groundingMetadata;
    const sources = grounding?.groundingChunks?.map(c => c?.web?.uri).filter(Boolean) || [];
    const searchQueries = grounding?.webSearchQueries || [];
    console.warn('Gemini returned no text content. finishReason:', finishReason);
    console.warn('Search queries used:', searchQueries);
    if (sources.length > 0 || searchQueries.length > 0) {
      // Make a follow-up call without search tool to get the JSON response
      console.log('Making follow-up call to format grounding results...');
      const geoReminder = scope === 'foreign'
        ? (countries ? `IMPORTANT: Only include suppliers from: ${countries}. Exclude ALL US companies.` : `IMPORTANT: Only include non-US international suppliers. Exclude ALL US/American companies.`)
        : scope === 'domestic' ? `IMPORTANT: Only include US-based suppliers. Exclude ALL international/foreign companies.` : '';
      const followUpPrompt = prompt + `\n\nNote: You already searched the web. Now return the JSON array based on what you found. ${geoReminder} Return ONLY a valid JSON array.`;
      const followUpRes = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=\${geminiKey}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: followUpPrompt }] }],
            generationConfig: { temperature: 0.1, maxOutputTokens: 16384 }
          })
        }
      );
      const followUpData = await followUpRes.json();
      const followUpText = followUpData?.candidates?.[0]?.content?.parts
        ?.filter(p => p.text)?.map(p => p.text)?.join('') || '';
      if (followUpText) {
        console.log('Follow-up response received');
        return followUpText;
      }
    }
    console.error('Full Gemini response:', JSON.stringify(data).substring(0, 800));
    throw new Error(`Gemini returned empty response (finishReason: \${finishReason})`);
  }
  console.log('Gemini raw response (first 500 chars):', text.substring(0, 500));
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

// ── Clean constraint language from commodity before searching ──────────────
function cleanCommodity(commodity) {
  return commodity
    .replace(/wholesale\s*only/gi, '')
    .replace(/no\s*retail/gi, '')
    .replace(/retail\s*only/gi, '')
    .replace(/domestic\s*only/gi, '')
    .replace(/usa\s*only/gi, '')
    .replace(/us\s*only/gi, '')
    .replace(/\bonly\b/gi, '')
    .replace(/,\s*,/g, ',')
    .replace(/\s{2,}/g, ' ')
    .trim()
    .replace(/^,|,$/g, '')
    .trim();
}

// ── /api/search ────────────────────────────────────────────────────────────
app.post('/api/search', async (req, res) => {
  const geminiKey   = process.env.GEMINI_API_KEY;
  const anthropicKey = process.env.ANTHROPIC_API_KEY;

  if (!geminiKey && !anthropicKey) {
    return res.status(500).json({ error: 'No API keys configured' });
  }

  try {
    const { commodity, scope, certs, countries, hts, sources, imageData, imageType } = req.body;
    const cleanedCommodity = cleanCommodity(commodity);

    const scopeText = scope === 'domestic' ? 'US domestic suppliers only — do NOT include any international or foreign suppliers'
      : scope === 'foreign' ? 'international/foreign suppliers only — do NOT include any US or American suppliers'
      : 'both US domestic and international suppliers';
    const certText    = certs    ? `Required certifications: ${certs}.`      : '';
    const countryText = (countries && scope !== 'domestic')
      ? `Preferred countries: ${countries}. Focus results on these countries.`
      : (scope === 'foreign' ? 'Exclude all US-based companies. Focus on non-US international manufacturers.' : '');
    const htsText     = hts      ? `HTS Code: ${hts}.`                       : '';


    // Geography constraint — placed at top and bottom of prompt so Gemini can't miss it
    const geoConstraint = scope === 'foreign'
      ? (countries
          ? `GEOGRAPHY REQUIREMENT: Return ONLY suppliers located in: ${countries}. Do NOT include any US or American companies.`
          : `GEOGRAPHY REQUIREMENT: Return ONLY non-US international suppliers. Do NOT include any companies based in the United States.`)
      : scope === 'domestic'
      ? `GEOGRAPHY REQUIREMENT: Return ONLY US-based suppliers. Do NOT include any international or foreign companies.`
      : '';

    // Append country to search query for better results
    const geoSearchSuffix = scope === 'foreign'
      ? (countries ? ` ${countries} manufacturer` : ' international manufacturer -USA -"United States"')
      : scope === 'domestic' ? ' manufacturer USA "United States"' : '';

    const supplierPrompt = [
      geoConstraint ? `⚠ ${geoConstraint}` : '',
      `You are an expert sourcing analyst. Search the web right now and find real manufacturers and distributors for this sourcing request.`,
      `Sourcing request: "${cleanedCommodity}"`,
      `Scope: ${scopeText}`,
      certText,
      countryText,
      htsText,
      `Search strategy:`,
      `- Search Google for: "${cleanedCommodity}" manufacturer supplier${geoSearchSuffix}`,
      `- Look for company websites, trade show listings, and industry directories`,
      sources && sources.length
        ? `- The user has specifically requested results from these sources:\n${sources.map(s => `  * Search ${s} for "${cleanedCommodity}"`).join('\n')}`
        : '- Search ThomasNet, trade directories, and import/export records',
      `Extract every real manufacturer, distributor, or supplier you find. Return a JSON array of up to 15 suppliers. For each include:`,
      `- id (number, starting at 1)`,
      `- name (exact company name)`,
      `- location (City, ST for US — e.g. "Houston, TX". City, Country for international — e.g. "Hangzhou, China")`,
      `- website (root domain only, e.g. "acme.com" — from actual search results)`,
      `- source (where found: "ThomasNet" / "Web Search" / "Trade Directory" / "Direct" / "Kompass")`,
      `- specialty (1 sentence describing what they make and their relevant capabilities)`,
      `- tags (2-4 short capability strings)`,
      `- certs (array of certifications found, else [])`,
      `- fit ("high" / "medium" / "low" based on match to the sourcing request)`,
      `- fitReason (1 sentence explaining the fit score)`,
      `- contactEmail ("")`,
      `- contactName ("")`,
      `Rules:`,
      `- Only include companies confirmed by your search results`,
      `- Do not invent or hallucinate company names`,
      `- Prefer manufacturers over distributors when both are available`,
      `- When in doubt, include the company — verification is the user's job`,
      geoConstraint ? `- ${geoConstraint}` : '',
      `Return ONLY a valid JSON array. No markdown. No explanation. No preamble.`
    ].filter(Boolean).join('\n\n');


    let responseText;
    let usedGemini = false;

    // ── Try Gemini first ───────────────────────────────────────────────
    if (geminiKey) {
      try {
        console.log('Calling Gemini with Google Search grounding...');
        responseText = await callGemini(supplierPrompt, geminiKey, scope, countries);
        usedGemini = true;
        console.log('Gemini response received');
      } catch (geminiErr) {
        console.error('Gemini failed:', geminiErr.message);
        console.error('Falling back to Claude. To debug: check GEMINI_API_KEY is valid and google_search tool is enabled for your project.');
        responseText = null;
      }
    }

    // ── Fall back to Claude if Gemini failed or not configured ────────
    if (!responseText && anthropicKey) {
      console.log('Using Claude fallback...');
      responseText = await callClaude(supplierPrompt, anthropicKey, true);
    }

    if (!responseText) throw new Error('All AI providers failed');

    // Wrap in the shape the frontend expects
    // Parse, filter by geography, then re-serialize
    let suppliers;
    try {
      suppliers = parseJSON(responseText);
      if (Array.isArray(suppliers)) {
        const before = suppliers.length;
        suppliers = filterByScope(suppliers, scope, countries);
        console.log(`Geography filter: ${before} → ${suppliers.length} suppliers (scope: ${scope})`);
        // Re-number IDs after filtering
        suppliers.forEach((s, i) => s.id = i + 1);
      }
      responseText = JSON.stringify(suppliers);
    } catch(e) {
      console.warn('Could not apply geography filter:', e.message);
      // Leave responseText as-is
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

Return a JSON object with:
- subject (string — professional email subject line)
- body (string — 3 short paragraphs with [SUPPLIER_NAME] placeholder where appropriate:
    1. Introduce yourself and the sourcing need, referencing their specialty
    2. Request a quote or capabilities discussion${includeAttach && attachList ? ', mention the attached documents' : ''}
    3. Polite closing with a call to action
  Do NOT include a signature block.)

Return ONLY a valid JSON object. No markdown. No preamble.`;

    let responseText;

    // Try Gemini first for email too
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

    // Wrap in the shape the frontend expects
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
  console.log(`Gemini:  ${hasGemini    ? '✓ configured (primary)'      : '✗ not set'}`);
  console.log(`Claude:  ${hasAnthropic ? '✓ configured (fallback)'     : '✗ not set'}`);
  if (!hasGemini) console.log('⚠ Add GEMINI_API_KEY to Railway for live search grounding');
});
