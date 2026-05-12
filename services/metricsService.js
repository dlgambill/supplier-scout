const database = require('../config/database');

class MetricsService {
  constructor() {
    this.currentMetrics = {
      totalSearches: 0,
      successfulSearches: 0,
      averageProcessingTime: 0,
      averageResultsPerSearch: 0,
      averageConfidenceScore: 0
    };
  }

  async recordSearchMetrics(searchQuery, metrics) {
    try {
      await database.run(
        `INSERT INTO search_metrics 
         (search_query, total_results, filtered_results, success_rate, avg_confidence, processing_time)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [
          searchQuery,
          metrics.totalResults || 0,
          metrics.filteredResults || 0,
          metrics.successRate || 0,
          metrics.avgConfidence || 0,
          metrics.processingTime || 0
        ]
      );
      
      console.log(`Recorded metrics for search: ${searchQuery}`);
      await this.updateCurrentMetrics();
    } catch (error) {
      console.error('Error recording search metrics:', error);
    }
  }

  async recordSupplierQuality(supplier, classification, confidence) {
    try {
      await database.run(
        `INSERT OR REPLACE INTO supplier_quality 
         (supplier_name, location, classification, confidence_score, validation_status, last_updated)
         VALUES (?, ?, ?, ?, ?, datetime('now'))`,
        [
          supplier.name,
          supplier.location || '',
          classification.type,
          confidence,
          'validated'
        ]
      );
    } catch (error) {
      console.error('Error recording supplier quality:', error);
    }
  }

  async getSearchQualityTrends(days = 7) {
    try {
      const trends = await database.all(
        `SELECT 
           DATE(created_at) as date,
           COUNT(*) as searches,
           AVG(success_rate) as avg_success_rate,
           AVG(avg_confidence) as avg_confidence,
           AVG(filtered_results) as avg_results,
           AVG(processing_time) as avg_processing_time
         FROM search_metrics 
         WHERE created_at >= datetime('now', '-${days} days')
         GROUP BY DATE(created_at)
         ORDER BY date DESC`
      );
      
      return trends;
    } catch (error) {
      console.error('Error getting search quality trends:', error);
      return [];
    }
  }

  async getSupplierQualityStats() {
    try {
      const stats = await database.all(
        `SELECT 
           classification,
           COUNT(*) as count,
           AVG(confidence_score) as avg_confidence,
           MIN(confidence_score) as min_confidence,
           MAX(confidence_score) as max_confidence
         FROM supplier_quality 
         GROUP BY classification`
      );
      
      return stats;
    } catch (error) {
      console.error('Error getting supplier quality stats:', error);
      return [];
    }
  }

  async updateCurrentMetrics() {
    try {
      const result = await database.get(
        `SELECT 
           COUNT(*) as total_searches,
           AVG(CASE WHEN success_rate > 0.5 THEN 1 ELSE 0 END) as success_rate,
           AVG(processing_time) as avg_processing_time,
           AVG(filtered_results) as avg_results,
           AVG(avg_confidence) as avg_confidence
         FROM search_metrics 
         WHERE created_at >= datetime('now', '-30 days')`
      );
      
      if (result) {
        this.currentMetrics = {
          totalSearches: result.total_searches || 0,
          successfulSearches: Math.round((result.success_rate || 0) * (result.total_searches || 0)),
          averageProcessingTime: Math.round(result.avg_processing_time || 0),
          averageResultsPerSearch: Math.round(result.avg_results || 0),
          averageConfidenceScore: Math.round((result.avg_confidence || 0) * 100) / 100
        };
      }
    } catch (error) {
      console.error('Error updating current metrics:', error);
    }
  }

  getCurrentMetrics() {
    return this.currentMetrics;
  }

  async getTopPerformingQueries(limit = 10) {
    try {
      const queries = await database.all(
        `SELECT 
           search_query,
           COUNT(*) as search_count,
           AVG(success_rate) as avg_success_rate,
           AVG(filtered_results) as avg_results,
           AVG(avg_confidence) as avg_confidence
         FROM search_metrics 
         WHERE created_at >= datetime('now', '-30 days')
         GROUP BY search_query 
         HAVING search_count >= 2
         ORDER BY avg_success_rate DESC, avg_results DESC
         LIMIT ?`,
        [limit]
      );
      
      return queries;
    } catch (error) {
      console.error('Error getting top performing queries:', error);
      return [];
    }
  }

  async getPoorPerformingQueries(limit = 10) {
    try {
      const queries = await database.all(
        `SELECT 
           search_query,
           COUNT(*) as search_count,
           AVG(success_rate) as avg_success_rate,
           AVG(filtered_results) as avg_results,
           AVG(avg_confidence) as avg_confidence
         FROM search_metrics 
         WHERE created_at >= datetime('now', '-30 days')
         GROUP BY search_query 
         HAVING search_count >= 2
         ORDER BY avg_success_rate ASC, avg_results ASC
         LIMIT ?`,
        [limit]
      );
      
      return queries;
    } catch (error) {
      console.error('Error getting poor performing queries:', error);
      return [];
    }
  }

  calculateSearchSuccessRate(totalResults, filteredResults, avgConfidence) {
    // Success rate based on multiple factors:
    // 1. Having results after filtering
    // 2. Good average confidence score
    // 3. Reasonable ratio of filtered to total results
    
    if (totalResults === 0) return 0;
    if (filteredResults === 0) return 0.1; // Very low but not zero
    
    const resultRatio = Math.min(filteredResults / Math.max(totalResults, 1), 1);
    const confidenceScore = avgConfidence || 0.5;
    const volumeScore = Math.min(filteredResults / 10, 1); // Normalize to 10 results
    
    return (resultRatio * 0.4) + (confidenceScore * 0.4) + (volumeScore * 0.2);
  }
}

module.exports = new MetricsService();