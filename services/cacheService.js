const database = require('../config/database');
const crypto = require('crypto');

class CacheService {
  constructor() {
    this.CACHE_TTL_HOURS = 24; // Cache for 24 hours
  }

  generateCacheKey(query, params) {
    const data = JSON.stringify({ query, params });
    return crypto.createHash('md5').update(data).digest('hex');
  }

  async get(searchQuery, searchParams) {
    try {
      const cacheKey = this.generateCacheKey(searchQuery, searchParams);
      const result = await database.get(
        'SELECT results FROM supplier_cache WHERE search_query = ? AND search_params = ? AND expires_at > datetime("now")',
        [searchQuery, JSON.stringify(searchParams)]
      );
      
      if (result) {
        console.log(`Cache hit for query: ${searchQuery}`);
        return JSON.parse(result.results);
      }
      
      console.log(`Cache miss for query: ${searchQuery}`);
      return null;
    } catch (error) {
      console.error('Cache get error:', error);
      return null;
    }
  }

  async set(searchQuery, searchParams, results) {
    try {
      const expiresAt = new Date();
      expiresAt.setHours(expiresAt.getHours() + this.CACHE_TTL_HOURS);
      
      await database.run(
        `INSERT OR REPLACE INTO supplier_cache 
         (search_query, search_params, results, expires_at) 
         VALUES (?, ?, ?, ?)`,
        [
          searchQuery,
          JSON.stringify(searchParams),
          JSON.stringify(results),
          expiresAt.toISOString()
        ]
      );
      
      console.log(`Cached results for query: ${searchQuery}`);
    } catch (error) {
      console.error('Cache set error:', error);
    }
  }

  async clearExpired() {
    try {
      const result = await database.run(
        'DELETE FROM supplier_cache WHERE expires_at <= datetime("now")'
      );
      
      if (result.changes > 0) {
        console.log(`Cleared ${result.changes} expired cache entries`);
      }
    } catch (error) {
      console.error('Cache cleanup error:', error);
    }
  }

  async getStats() {
    try {
      const total = await database.get('SELECT COUNT(*) as count FROM supplier_cache');
      const expired = await database.get('SELECT COUNT(*) as count FROM supplier_cache WHERE expires_at <= datetime("now")');
      
      return {
        totalEntries: total.count,
        expiredEntries: expired.count,
        activeEntries: total.count - expired.count
      };
    } catch (error) {
      console.error('Cache stats error:', error);
      return { totalEntries: 0, expiredEntries: 0, activeEntries: 0 };
    }
  }
}

module.exports = new CacheService();