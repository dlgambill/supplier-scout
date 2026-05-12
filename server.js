const express = require('express');
const cors = require('cors');
const path = require('path');

// Import services
const database = require('./config/database');
const cacheService = require('./services/cacheService');
const validationService = require('./services/validationService');
const classificationService = require('./services/classificationService');
const metricsService = require('./services/metricsService');
const jsonParser = require('./utils/jsonParser');

const app = express();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// Initialize database
let isInitialized = false;

async function initializeApp() {
  try {
    await database.init();
    await cacheService.clearExpired(); // Clean up expired cache entries
    await metricsService.updateCurrentMetrics();
    isInitialized = true;
    console.log('✅ SupplierScout initialized successfully');
  } catch (error) {
    console.error('❌ Failed to initialize SupplierScout:', error);
    process.exit(1);
  }
}

// Health check endpoint
app.get('/health', (req, res) => {
  const health = {
    status: isInitialized ? 'healthy' : 'initializing',
    timestamp: new Date().toISOString(),
    version: '2.0.0'
  };
  res.json(health);
});

// Metrics endpoint
app.get('/api/metrics', async (req, res) => {
  try {
    const currentMetrics = metricsService.getCurrentMetrics();
    const cacheStats = await cacheService.getStats();
    const qualityTrends = await metricsService.getSearchQualityTrends(7);
    const qualityStats = await metricsService.getSupplierQualityStats();
    
    res.json({
      current: currentMetrics,
      cache: cacheStats,
      trends: qualityTrends,
      quality: qualityStats
    });
  } catch (error) {
    console.error('Error fetching metrics:', error);
    res.status(500).json({ error: 'Failed to fetch metrics' });
  }
});

// Main search endpoint with improved error handling and validation
app.post('/api/search', async (req, res) => {
  const startTime = Date.now();
  let searchMetrics = {
    totalResults: 0,
    filteredResults: 0,
    successRate: 0,
    avgConfidence: 0,
    processingTime: 0
  };

  try {
    // Validate search parameters
    const params = validationService.validateSearchParams(req.body);
    const { query, supplierType, scope, countries, selectedCountries, limit } = params;

    console.log(`🔍 Starting search for: "${query}" (${supplierType}, ${scope})`);

    // Check cache first
    const cachedResult = await cacheService.get(query, params);
    if (cachedResult && Array.isArray(cachedResult)) {
      console.log(`📦 Returning ${cachedResult.length} cached results`);
      return res.json({
        suppliers: cachedResult,
        cached: true,
        total: cachedResult.length,
        query: query
      });
    }

    // Simulate supplier search (in real implementation, this would call external APIs)
    // For now, return a mock result to demonstrate the improved architecture
    const mockSuppliers = generateMockSuppliers(query, limit);
    
    // Validate all suppliers
    const validatedSuppliers = validationService.validateSuppliers(mockSuppliers);
    searchMetrics.totalResults = validatedSuppliers.length;
    
    // Classify and score suppliers
    const classifiedSuppliers = validatedSuppliers.map(supplier => {
      const classification = classificationService.classifySupplier(supplier);
      const locationClass = classificationService.classifyLocation(supplier.location);
      
      // Record supplier quality metrics
      metricsService.recordSupplierQuality(supplier, classification, classification.confidence);
      
      return {
        ...supplier,
        supplierType: classification.type,
        confidence: classification.confidence,
        classificationReason: classification.reason,
        locationRegion: locationClass.region,
        locationConfidence: locationClass.confidence
      };
    });
    
    // Apply filters
    const filteredSuppliers = applyFilters(classifiedSuppliers, {
      supplierType,
      scope,
      countries,
      selectedCountries
    });
    
    searchMetrics.filteredResults = filteredSuppliers.length;
    searchMetrics.avgConfidence = filteredSuppliers.length > 0 ? 
      filteredSuppliers.reduce((sum, s) => sum + s.confidence, 0) / filteredSuppliers.length : 0;
    searchMetrics.processingTime = Date.now() - startTime;
    searchMetrics.successRate = metricsService.calculateSearchSuccessRate(
      searchMetrics.totalResults,
      searchMetrics.filteredResults,
      searchMetrics.avgConfidence
    );

    // Cache the results
    await cacheService.set(query, params, filteredSuppliers);
    
    // Record metrics
    await metricsService.recordSearchMetrics(query, searchMetrics);
    
    console.log(`✅ Search completed: ${filteredSuppliers.length}/${validatedSuppliers.length} suppliers (${searchMetrics.processingTime}ms)`);
    
    res.json({
      suppliers: filteredSuppliers,
      cached: false,
      total: filteredSuppliers.length,
      query: query,
      metrics: searchMetrics
    });
    
  } catch (error) {
    searchMetrics.processingTime = Date.now() - startTime;
    console.error('Search error:', error);
    
    // Record failed search metrics
    if (req.body.query) {
      await metricsService.recordSearchMetrics(req.body.query, {
        ...searchMetrics,
        successRate: 0
      });
    }
    
    res.status(500).json({ 
      error: 'Search failed', 
      message: error.message,
      query: req.body.query || ''
    });
  }
});

// Helper function to apply filters (extracted from the original monolithic code)
function applyFilters(suppliers, filters) {
  let filtered = suppliers;
  
  // Filter by supplier type
  if (filters.supplierType && filters.supplierType !== 'all') {
    filtered = filtered.filter(supplier => {
      if (filters.supplierType === 'manufacturers') {
        return supplier.supplierType === 'manufacturer';
      } else if (filters.supplierType === 'distributors') {
        return supplier.supplierType === 'distributor';
      }
      return true;
    });
  }
  
  // Filter by geographic scope
  if (filters.scope && filters.scope !== 'all') {
    filtered = filtered.filter(supplier => {
      if (filters.scope === 'domestic') {
        return supplier.locationRegion === 'domestic';
      } else if (filters.scope === 'foreign') {
        return supplier.locationRegion === 'foreign';
      }
      return true;
    });
  }
  
  // Filter by selected countries
  if (filters.selectedCountries && filters.selectedCountries.length > 0) {
    const hasUSA = filters.selectedCountries.includes('USA');
    const foreignCountries = filters.selectedCountries.filter(c => c !== 'USA').map(c => c.toLowerCase());
    
    filtered = filtered.filter(supplier => {
      const location = (supplier.location || '').toLowerCase();
      
      if (supplier.locationRegion === 'domestic' && hasUSA) return true;
      if (supplier.locationRegion === 'foreign' && foreignCountries.length > 0) {
        return foreignCountries.some(country => location.includes(country));
      }
      
      return false;
    });
  }
  
  return filtered;
}

// Mock supplier generator for demonstration (replace with real API calls)
function generateMockSuppliers(query, limit) {
  const mockSuppliers = [];
  const baseNames = [
    'Advanced Manufacturing Corp',
    'Precision Components Inc',
    'Industrial Supply Co',
    'Global Parts Distributor',
    'Custom Fabrication LLC',
    'Quality Manufacturing',
    'Wholesale Components',
    'Technical Solutions Inc'
  ];
  
  const locations = [
    'Los Angeles, CA',
    'Houston, TX', 
    'Chicago, IL',
    'Shenzhen, China',
    'Osaka, Japan',
    'Munich, Germany',
    'Toronto, Canada',
    'Unknown'
  ];
  
  const specialties = [
    'Custom metal fabrication and machining',
    'Electronic component distribution',
    'Industrial automation equipment',
    'Precision injection molding',
    'Quality certified manufacturing',
    'Wide range of industrial supplies',
    'OEM parts and components',
    'Contract manufacturing services'
  ];
  
  for (let i = 0; i < Math.min(limit, 20); i++) {
    mockSuppliers.push({
      name: baseNames[i % baseNames.length] + ` (${query})`,
      location: locations[i % locations.length],
      specialty: specialties[i % specialties.length],
      tags: [`${query}`, 'manufacturing', 'supplier'],
      email: `contact@${baseNames[i % baseNames.length].toLowerCase().replace(/[^a-z0-9]/g, '')}.com`,
      phone: `+1-555-${String(1000 + i).padStart(4, '0')}`,
      website: `https://${baseNames[i % baseNames.length].toLowerCase().replace(/[^a-z0-9]/g, '')}.com`
    });
  }
  
  return mockSuppliers;
}

// Graceful shutdown
process.on('SIGINT', async () => {
  console.log('\n🔄 Gracefully shutting down...');
  await database.close();
  process.exit(0);
});

process.on('SIGTERM', async () => {
  console.log('\n🔄 Gracefully shutting down...');
  await database.close();
  process.exit(0);
});

// Initialize and start server
initializeApp().then(() => {
  app.listen(PORT, () => {
    console.log(`🚀 SupplierScout v2.0 running on port ${PORT}`);
    console.log(`📊 Metrics available at http://localhost:${PORT}/api/metrics`);
    console.log(`🔍 Search endpoint: http://localhost:${PORT}/api/search`);
  });
}).catch(error => {
  console.error('❌ Failed to start SupplierScout:', error);
  process.exit(1);
});

module.exports = app;