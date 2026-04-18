const express = require('express');
const path = require('path');
const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── SerpAPI search helper ──────────────────────────────────────────────────
async function serpSearch(query, serpApiKey, num = 10) {
  const params = new URLSearchParams({
    q: query,
    api_key: serpApiKey,
    num: String(num),
    hl: 'en',
    gl: 'us'
  });
  const res = await fetch(`https://serpapi.com/search.json?${params}`);
  if (!res.ok) throw new Error(`SerpAPI error: ${res.status} ${res.statusText}`);
  const data = await res.json();

  // Extract knowledge graph location if present (free, comes with search)
  const kg = data.knowledge_graph || {};
  const kgLocation = [kg.headquarters, kg.address, kg.city]
    .filter(Boolean).join(', ');

  const genericTlds = new Set(['com','net','org','io','co','gov','edu','info','biz','us']);
  const results = (data.organic_results || []).map(r => {
    // Infer country from ccTLD (e.g. .de, .cn, .ca)
    const tldMatch = (r.link || '').match(/https?:\/\/[^/]+\.([a-z]{2})(?:\/|$)/);
    const tldCountry = (tldMatch && !genericTlds.has(tldMatch[1])) ? tldMatch[1].toUpperCase() : '';
    return {
      title: r.title || '',
      url: r.link || '',
      displayed_url: r.displayed_link || '',
      snippet: r.snippet || '',
      tld_country: tldCountry,
      address: r.address || ''
    };
  });

  return { results, kgLocation };
}

// Lightweight location lookup for a specific company name
async function serpLocationLookup(companyName, serpApiKey) {
  try {
    const params = new URLSearchParams({
      q: `"${companyName}" company headquarters city state`,
      api_key: serpApiKey,
      num: '3',
      hl: 'en',
      gl: 'us'
    });
    const res = await fetch(`https://serpapi.com/search.json?${params}`);
    if (!res.ok) return '';
    const data = await res.json();
    const kg = data.knowledge_graph || {};
    return [kg.headquarters, kg.address, kg.city].filter(Boolean).join(', ');
  } catch (e) {
    return '';
  }
}

// Strip user constraint language that pollutes search queries
// e.g. "wholesale only, no retail" should not be in a Google search
function cleanCommodityForSearch(commodity) {
  return commodity
    .replace(/wholesale only/gi, '')
    .replace(/no retail/gi, '')
    .replace(/retail only/gi, '')
    .replace(/domestic only/gi, '')
    .replace(/usa only/gi, '')
    .replace(/us only/gi, '')
    .replace(/only/gi, '')
    .replace(/,\s*,/g, ',')  // clean up double commas
    .replace(/\s{2,}/g, ' ') // clean up extra spaces
    .trim()
    .replace(/^,|,$/g, '')   // trim leading/trailing commas
    .trim();
}

// Build targeted search queries based on scope
function buildSearchQueries(commodity, scope, countries, hts, certs) {
  commodity = cleanCommodityForSearch(commodity);
  const queries = [];
  const base = commodity.substring(0, 80);
  // Strip quotes for broader queries
  const baseLoose = base.replace(/['"]/g, '');
  const htsPart = hts ? ` HTS ${hts}` : '';
  const certPart = certs ? ` ${certs}` : '';

  if (scope === 'domestic' || scope === 'both') {
    queries.push(`"${base}" manufacturer USA${certPart}`);
    queries.push(`site:thomasnet.com "${baseLoose}"`);
    queries.push(`${baseLoose} manufacturer supplier United States`);
    queries.push(`${baseLoose} wholesale distributor USA`);
  }
  if (scope === 'foreign' || scope === 'both') {
    const countryList = countries || 'international';
    queries.push(`"${base}" manufacturer ${countryList}${certPart}`);
    queries.push(`${baseLoose} supplier exporter ${countryList}`);
    queries.push(`${baseLoose} manufacturer importer${htsPart}`);
  }
  if (hts) {
    queries.push(`HTS ${hts} supplier manufacturer`);
  }

  return queries;
}

// ── /api/search — SerpAPI → Claude pipeline ───────────────────────────────
app.post('/api/search', async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  const serpKey = process.env.SERPAPI_KEY;

  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  // If no SerpAPI key, fall back to pure Claude (degraded mode)
  const useSerpApi = !!serpKey;

  try {
    const { commodity, scope, certs, countries, hts, includeEmails, attachList, imageData, imageType } = req.body;

    let searchContext = '';

    if (useSerpApi) {
      // ── Step 1: Run SerpAPI searches ──────────────────────────────────
      const queries = buildSearchQueries(commodity, scope, countries, hts, certs);
      const allResults = [];

      for (const query of queries) {
        try {
          const results = await serpSearch(query, serpKey, 10);
          allResults.push({ query, results });
        } catch (e) {
          console.warn(`SerpAPI query failed: "${query}" — ${e.message}`);
        }
      }

      // Format results for Claude — include address/TLD hints for location inference
      searchContext = allResults.map(({ query, results, kgLocation }) => {
        if (!results.length) return `QUERY: ${query}\nNo results.\n`;
        const header = kgLocation ? `QUERY: ${query} [Knowledge Graph: ${kgLocation}]` : `QUERY: ${query}`;
        return header + '\nRESULTS:\n' + results.map((r, i) => {
          const locHint = r.tld_country ? ` [country TLD: .${r.tld_country.toLowerCase()}]` : '';
          const addrHint = r.address ? ` [address: ${r.address}]` : '';
          return `  ${i + 1}. ${r.title}\n     URL: ${r.url}${locHint}${addrHint}\n     ${r.snippet}`;
        }).join('\n') + '\n';
      }).join('\n---\n');
    }

    // ── Step 2: Build Claude prompt ────────────────────────────────────
    const scopeText = scope === 'domestic' ? 'US domestic suppliers only'
      : scope === 'foreign' ? 'international/foreign suppliers only'
      : 'both US domestic and international suppliers';
    const certText = certs ? `Required certifications: ${certs}.` : '';
    const countryText = (countries && (scope === 'foreign' || scope === 'both')) ? `Preferred countries: ${countries}.` : '';
    const htsText = hts ? `HTS Code: ${hts}.` : '';

    let supplierPrompt;

    if (useSerpApi && searchContext) {
      supplierPrompt = `You are an expert sourcing analyst. I have run live Google searches and collected the following real search results. Your job is to extract real supplier companies from these results and score their fit.

Sourcing request: "${commodity}"
Scope: ${scopeText}
${certText}
${countryText}
${htsText}

LIVE SEARCH RESULTS:
${searchContext}

Instructions:
- Extract every distinct manufacturer, supplier, or distributor that appears in the search results.
- Do not invent companies not present in the results.
- A company's website comes directly from the URL in the search results — use the root domain.
- For directory listings (ThomasNet, Kompass, Alibaba etc.), extract ALL supplier names mentioned in titles and snippets.
- Only skip results that are purely: news articles, how-to guides, Reddit/forum posts, or individual consumer retail pages (Amazon product listings). If there is any chance the result is a supplier or manufacturer, include them.
- When in doubt, include the company — it is better to return a supplier that needs verification than to return zero results.
- Score fit based on how well their capabilities match the sourcing request.
- Deduplicate — if the same company appears in multiple results, include them once with the best available data.

Return a JSON array of up to 15 supplier objects, each with:
- id (number)
- name (company name from search results)
- location (city, state or city, country — derive from: snippet text, knowledge graph data, URL country TLD hints, or your training knowledge of the company. For US companies use "City, ST" format. For international use "City, Country". Use your knowledge of well-known companies to fill gaps. Only use "Unknown" as a last resort if you truly have no signal.)
- website (root domain from search result URL, e.g. "acme.com")
- source (which query/directory found them: ThomasNet / Direct / Web Search / Kompass / MFG.com)
- specialty (1 sentence based on their snippet)
- tags (2-4 capability strings)
- certs (certifications mentioned in results, else [])
- fit ("high"/"medium"/"low")
- fitReason (1 sentence)
- contactEmail ("")
- contactName ("")

Return ONLY a valid JSON array. No markdown. No preamble.`;
    } else {
      // Degraded mode — no SerpAPI, honest Claude-only fallback
      supplierPrompt = `You are an expert sourcing analyst.

Sourcing: "${commodity}"
Scope: ${scopeText}
${certText}
${countryText}
${htsText}

Note: Live search is unavailable. Return only companies you are highly confident exist and manufacture this commodity based on your training data. Prefer large, well-known manufacturers. Return fewer results rather than guessing.

Return a JSON array of up to 8 supplier objects, each with:
- id (number)
- name
- location (city, state or city, country)
- website (domain only if certain, else "")
- source (ThomasNet / Kompass / MFG.com / Europages / IndustryNet / Direct)
- specialty (1 sentence)
- tags (2-4 strings)
- certs (array or [])
- fit ("high"/"medium"/"low")
- fitReason (1 sentence)
- contactEmail ("")
- contactName ("")

Return ONLY a valid JSON array. No markdown. No preamble.`;
    }

    // ── Step 3: Call Claude for supplier extraction/scoring ────────────
    let messages;
    if (imageData && imageType) {
      messages = [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'base64', media_type: imageType, data: imageData } },
          { type: 'text', text: supplierPrompt }
        ]
      }];
    } else {
      messages = [{ role: 'user', content: supplierPrompt }];
    }

    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 8000,
        system: 'Return only a valid JSON array. No markdown. No preamble.',
        messages
      })
    });

    const claudeData = await claudeRes.json();
    if (claudeData.error) throw new Error(claudeData.error.message || 'Claude API error');

    res.json({ claudeData, usedSerpApi: useSerpApi });

  } catch (err) {
    console.error('Search error:', err);
    res.status(500).json({ error: err.message });
  }
});

// ── /api/email — email template generation (Claude only, cheap) ───────────
app.post('/api/email', async (req, res) => {
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });

  try {
    const { commodity, includeAttach, attachList } = req.body;
    const attachNote = includeAttach && attachList ? ` Reference that attachments are included: ${attachList}.` : '';

    const prompt = `Write a single professional supplier outreach email template.

Commodity: "${commodity}"${attachNote}

Return a JSON object with: subject (string), body (string with [SUPPLIER_NAME] placeholder, 3 short paragraphs: introduce the sourcing need, request a quote or capabilities discussion${includeAttach && attachList ? ', mention attached documents' : ''}, polite closing). Do NOT include a signature block. Return ONLY a valid JSON object. No markdown.`;

    const response = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': anthropicKey,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 1500,
        system: 'Return only a valid JSON object. No markdown. No preamble.',
        messages: [{ role: 'user', content: prompt }]
      })
    });

    const data = await response.json();
    if (data.error) throw new Error(data.error.message || 'Claude API error');
    res.json(data);

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(PORT, () => {
  const hasSerpApi = !!process.env.SERPAPI_KEY;
  console.log(`SupplierScout running on port ${PORT}`);
  console.log(`Mode: ${hasSerpApi ? '✓ SerpAPI + Claude (live search)' : '⚠ Claude-only (no SERPAPI_KEY set)'}`);
});
