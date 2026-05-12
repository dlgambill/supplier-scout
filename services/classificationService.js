class ClassificationService {
  constructor() {
    // Updated and expanded classification keywords based on 2026 industry trends
    this.DISTRIBUTOR_KEYWORDS = [
      // Traditional distribution terms
      'distributor', 'distribution', 'wholesale', 'wholesaler', 'reseller',
      'trader', 'trading company', 'stockist', 'master distributor', 'supplier of', 'supplies ',
      'retailer', 'retail', 'e-commerce', 'online store', 'marketplace', 'catalog', 'catalogue',
      'offers a wide range', 'wide range of', 'offering various', 'sells ', 'carries ', 'stocks ',
      
      // Modern distribution terms
      'supply chain', 'logistics provider', 'fulfillment', 'drop ship', 'dropship',
      'inventory management', 'sourcing specialist', 'procurement', 'vendor',
      'authorized dealer', 'exclusive distributor', 'regional distributor',
      'value-added reseller', 'var ', 'channel partner', 'sales representative',
      
      // Digital/modern indicators
      'marketplace seller', 'amazon seller', 'ebay seller', 'platform seller',
      'digital distributor', 'online distributor', 'ecommerce distributor',
      'b2b marketplace', 'industrial marketplace'
    ];

    this.MANUFACTURER_KEYWORDS = [
      // Traditional manufacturing terms
      'manufactur', 'fabricat', 'oem ', 'oem,', 'original equipment',
      'production', 'machining', 'casting', 'forging', 'stamping', 'molding', 'moulding',
      'extru', 'assembl', 'produces ', 'producer', 'made in', 'custom made', 'custom manufacturer',
      'we make', 'we produce', 'we manufacture', 'in-house', 'contract manufacturer',
      
      // Modern manufacturing terms
      'additive manufacturing', '3d printing', '3d printed', 'rapid prototyping',
      'cnc machining', 'cnc manufacturing', 'precision manufacturing', 'lean manufacturing',
      'automated manufacturing', 'smart manufacturing', 'industry 4.0',
      'injection molding', 'die casting', 'metal fabrication', 'sheet metal',
      'prototype', 'prototyping', 'tooling', 'fixtures', 'custom tooling',
      
      // Quality and certification indicators
      'iso 9001', 'iso certified', 'certified manufacturer', 'quality certified',
      'fda approved', 'medical device', 'aerospace certified', 'automotive certified',
      'rohs compliant', 'ce certified', 'ul listed'
    ];

    // Expanded list of known non-manufacturers (major distributors/retailers)
    this.KNOWN_NON_MANUFACTURERS = [
      // Traditional industrial distributors
      'mcmaster', 'grainger', 'fastenal', 'msc industrial', 'lawson products',
      'motion industries', 'applied industrial', 'kaman distribution',
      'wesco international', 'rexel', 'gexpro', 'crescent electric',
      
      // General retailers
      'amazon', 'ebay', 'alibaba', 'global sources', 'made-in-china',
      'home depot', 'lowes', "lowe's", 'ace hardware', 'menards', 'tractor supply',
      'northern tool', 'harbor freight', 'princess auto',
      
      // Online marketplaces and catalogs
      'zoro', 'global industrial', 'uline', 'staples', 'office depot',
      'walmart', 'target', 'costco', 'sams club', "sam's club",
      'webstaurant', 'restaurant depot', 'sysco', 'us foods',
      
      // Technology distributors
      'ingram micro', 'tech data', 'arrow electronics', 'avnet', 'digi-key',
      'mouser electronics', 'newark', 'allied electronics', 'rs components',
      'farnell', 'radioshack', 'micro center',
      
      // Automotive distributors
      'autozone', 'advance auto', 'oreilly', "o'reilly", 'napa auto',
      'car quest', 'worldpac', 'genuine parts company'
    ];

    // Geographic indicators for better location classification
    this.US_INDICATORS = [
      'usa', 'united states', 'america', 'us ', ' us', 'u.s.', 'u.s.a.',
      ...this.getAllUSStatesAndAbbreviations()
    ];

    this.FOREIGN_INDICATORS = [
      // Major manufacturing countries
      'china', 'taiwan', 'germany', 'japan', 'korea', 'south korea', 'india',
      'uk', 'united kingdom', 'england', 'france', 'italy', 'spain', 'mexico',
      'canada', 'australia', 'brazil', 'poland', 'czech republic', 'sweden',
      'netherlands', 'belgium', 'switzerland', 'austria', 'turkey', 'indonesia',
      'vietnam', 'thailand', 'malaysia', 'singapore', 'hong kong', 'israel',
      'uae', 'dubai', 'russia', 'ukraine', 'portugal', 'denmark', 'finland',
      'norway', 'hungary', 'romania', 'slovakia', 'croatia', 'serbia', 'bulgaria',
      
      // Chinese provinces and cities (major manufacturing regions)
      'shandong', 'guangdong', 'zhejiang', 'jiangsu', 'fujian', 'hubei',
      'hangzhou', 'shenzhen', 'shanghai', 'beijing', 'dongguan', 'ningbo',
      'tianjin', 'chongqing', 'wuhan', 'qingdao', 'xiamen', 'foshan',
      'zhongshan', 'wenzhou', 'taizhou', 'yiwu'
    ];
  }

  getAllUSStatesAndAbbreviations() {
    return [
      'AL','AK','AZ','AR','CA','CO','CT','DE','FL','GA','HI','ID','IL','IN','IA',
      'KS','KY','LA','ME','MD','MA','MI','MN','MS','MO','MT','NE','NV','NH','NJ',
      'NM','NY','NC','ND','OH','OK','OR','PA','RI','SC','SD','TN','TX','UT','VT',
      'VA','WA','WV','WI','WY','DC',
      'alabama','alaska','arizona','arkansas','california','colorado','connecticut',
      'delaware','florida','georgia','hawaii','idaho','illinois','indiana','iowa',
      'kansas','kentucky','louisiana','maine','maryland','massachusetts','michigan',
      'minnesota','mississippi','missouri','montana','nebraska','nevada','new hampshire',
      'new jersey','new mexico','new york','north carolina','north dakota','ohio',
      'oklahoma','oregon','pennsylvania','rhode island','south carolina','south dakota',
      'tennessee','texas','utah','vermont','virginia','washington','west virginia',
      'wisconsin','wyoming'
    ];
  }

  calculateConfidenceScore(supplier, classification) {
    const name = (supplier.name || '').toLowerCase();
    const description = ((supplier.specialty || '') + ' ' + (supplier.tags || []).join(' ')).toLowerCase();
    let score = 0.5; // Base confidence

    // Strong positive indicators
    if (classification === 'manufacturer') {
      const mfgMatches = this.MANUFACTURER_KEYWORDS.filter(k => description.includes(k)).length;
      const distMatches = this.DISTRIBUTOR_KEYWORDS.filter(k => description.includes(k)).length;
      
      score += (mfgMatches * 0.1);
      score -= (distMatches * 0.05);
      
      // Boost confidence for quality certifications
      if (/iso|certified|approved|compliant|listed/i.test(description)) {
        score += 0.2;
      }
    } else if (classification === 'distributor') {
      const distMatches = this.DISTRIBUTOR_KEYWORDS.filter(k => description.includes(k)).length;
      const mfgMatches = this.MANUFACTURER_KEYWORDS.filter(k => description.includes(k)).length;
      
      score += (distMatches * 0.1);
      score -= (mfgMatches * 0.05);
    }

    // Penalty for known non-manufacturers
    if (this.KNOWN_NON_MANUFACTURERS.some(k => name.includes(k))) {
      if (classification === 'manufacturer') {
        score = 0.1; // Very low confidence for known distributors classified as manufacturers
      } else {
        score += 0.3; // High confidence boost for known distributors
      }
    }

    // Penalty for unclear/generic descriptions
    if (!description.trim() || description.length < 20) {
      score -= 0.2;
    }

    // Ensure score stays within bounds
    return Math.max(0, Math.min(1, score));
  }

  classifySupplier(supplier) {
    const name = (supplier.name || '').toLowerCase();
    const description = ((supplier.specialty || '') + ' ' + (supplier.tags || []).join(' ')).toLowerCase();
    
    // Check against known non-manufacturers first
    if (this.KNOWN_NON_MANUFACTURERS.some(k => name.includes(k))) {
      return {
        type: 'distributor',
        confidence: this.calculateConfidenceScore(supplier, 'distributor'),
        reason: 'Known distributor/retailer'
      };
    }

    // Count keyword matches
    const manufacturerMatches = this.MANUFACTURER_KEYWORDS.filter(k => description.includes(k)).length;
    const distributorMatches = this.DISTRIBUTOR_KEYWORDS.filter(k => description.includes(k)).length;

    let classification, reason;
    
    if (manufacturerMatches > distributorMatches) {
      classification = 'manufacturer';
      reason = `Manufacturing keywords: ${manufacturerMatches}, Distribution keywords: ${distributorMatches}`;
    } else if (distributorMatches > manufacturerMatches) {
      classification = 'distributor';
      reason = `Distribution keywords: ${distributorMatches}, Manufacturing keywords: ${manufacturerMatches}`;
    } else {
      // Tie or no matches - default based on heuristics
      if (/\b(retailer|retail store|supplier of|reseller|sells|carries)\b/.test(description)) {
        classification = 'distributor';
        reason = 'Distribution-indicating language patterns';
      } else if (/\b(custom|produces?|makes?|manufactur)\b/.test(description)) {
        classification = 'manufacturer';
        reason = 'Manufacturing-indicating language patterns';
      } else {
        classification = 'unknown';
        reason = 'Insufficient classification indicators';
      }
    }

    return {
      type: classification,
      confidence: this.calculateConfidenceScore(supplier, classification),
      reason: reason
    };
  }

  isUSLocation(location) {
    if (!location || location === 'N/A' || location === 'Unknown') return false;
    const upper = location.toUpperCase();
    return this.US_INDICATORS.some(indicator => {
      const indicatorUpper = indicator.toUpperCase();
      return upper.includes(indicatorUpper);
    });
  }

  isForeignLocation(location) {
    if (!location) return false;
    const lower = location.toLowerCase();
    return this.FOREIGN_INDICATORS.some(indicator => lower.includes(indicator));
  }

  classifyLocation(location) {
    if (!location || location === 'N/A' || location === 'Unknown') {
      return { region: 'unknown', confidence: 0.1 };
    }

    if (this.isUSLocation(location)) {
      return { region: 'domestic', confidence: 0.9 };
    }

    if (this.isForeignLocation(location)) {
      return { region: 'foreign', confidence: 0.8 };
    }

    // If we can't classify, assume foreign (common case for international suppliers)
    return { region: 'foreign', confidence: 0.3 };
  }
}

module.exports = new ClassificationService();