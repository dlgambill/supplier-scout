// Database seeding script for testing
const database = require('../config/database');
const metricsService = require('../services/metricsService');

async function seed() {
  try {
    console.log('🌱 Seeding database with test data...');
    await database.init();
    
    // Add some sample search metrics
    const sampleQueries = [
      'metal fabrication',
      'electronic components', 
      'plastic injection molding',
      'automotive parts',
      'industrial sensors'
    ];
    
    for (const query of sampleQueries) {
      await metricsService.recordSearchMetrics(query, {
        totalResults: Math.floor(Math.random() * 100) + 20,
        filteredResults: Math.floor(Math.random() * 50) + 10,
        successRate: Math.random() * 0.5 + 0.5, // 0.5-1.0
        avgConfidence: Math.random() * 0.4 + 0.6, // 0.6-1.0
        processingTime: Math.floor(Math.random() * 2000) + 500 // 500-2500ms
      });
    }
    
    console.log('✅ Database seeded successfully');
    await database.close();
  } catch (error) {
    console.error('❌ Seeding failed:', error);
    process.exit(1);
  }
}

// Run seeding if called directly
if (require.main === module) {
  seed();
}

module.exports = seed;