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
  const firstBrace   = text.indexOf('{');
  const firstBracket = text.indexOf('[');
  let start, end;
  if (firstBrace === -1 && firstBracket === -1) throw new Error('No JSON found in response');
  if (firstBrace !== -1 && (firstBracket === -1 || firstBrace < firstBracket)) {
    start = firstBrace;   end = text.lastIndexOf('}');
  } else {
    start = firstBracket; end = text.lastIndexOf(']');
  }
  if (start === -1 || end === -1) throw new Error('Malformed JSON in response');
  let jsonStr = text.slice(start, end + 1);
  // Remove control characters that break JSON parsing (Gemini sometimes includes these)
  jsonStr = jsonStr.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, ' ');
  // Gemini sometimes appends text after the JSON — strip anything after the final bracket
  jsonStr = jsonStr.trim();
  const lastBracket = jsonStr.startsWith('[') ? jsonStr.lastIndexOf(']') : jsonStr.lastIndexOf('}');
  if (lastBracket !== -1) jsonStr = jsonStr.slice(0, lastBracket + 1);
  return JSON.parse(jsonStr);
}

// ── Gemini call with Google Search grounding ───────────────────────────────
async function callGemini(prompt, geminiKey) {
  const res = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash-lite:generateContent?key=${geminiKey}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        tools: [{ googleSearch: {} }],  // Google Search grounding
        generationConfig: {
          temperature: 0.1,   // low temp = more factual, less creative
          maxOutputTokens: 8192
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
  const text = data?.candidates?.[0]?.content?.parts
    ?.filter(p => p.text)
    ?.map(p => p.text)
    ?.join('') || '';
  if (!text) throw new Error('Gemini returned empty response');
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
      ? (countries ? ` ${countries}` : ' international non-USA')
      : scope === 'domestic' ? ' USA' : '';

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
        responseText = await callGemini(supplierPrompt, geminiKey);
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
    res.json({
      claudeData: {
        content: [{ type: 'text', text: responseText }]
      },
      usedSerpApi: usedGemini, // reuse flag to show LIVE SEARCH badge
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
