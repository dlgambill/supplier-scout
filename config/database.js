const sqlite3 = require('sqlite3').verbose();
const path = require('path');

const dbPath = path.join(__dirname, '..', 'data', 'supplier_scout.db');
const fs = require('fs');

// Ensure data directory exists
const dataDir = path.dirname(dbPath);
if (!fs.existsSync(dataDir)) {
  fs.mkdirSync(dataDir, { recursive: true });
}

class Database {
  constructor() {
    this.db = null;
  }

  async init() {
    return new Promise((resolve, reject) => {
      this.db = new sqlite3.Database(dbPath, (err) => {
        if (err) {
          console.error('Database connection failed:', err);
          reject(err);
        } else {
          console.log('Connected to SQLite database');
          this.createTables().then(resolve).catch(reject);
        }
      });
    });
  }

  async createTables() {
    const tables = [
      `CREATE TABLE IF NOT EXISTS supplier_cache (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        search_query TEXT NOT NULL,
        search_params TEXT NOT NULL,
        results TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        expires_at DATETIME NOT NULL,
        UNIQUE(search_query, search_params)
      )`,
      `CREATE TABLE IF NOT EXISTS search_metrics (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        search_query TEXT NOT NULL,
        total_results INTEGER DEFAULT 0,
        filtered_results INTEGER DEFAULT 0,
        success_rate REAL DEFAULT 0,
        avg_confidence REAL DEFAULT 0,
        processing_time INTEGER DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      )`,
      `CREATE TABLE IF NOT EXISTS supplier_quality (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        supplier_name TEXT NOT NULL,
        location TEXT,
        classification TEXT,
        confidence_score REAL DEFAULT 0,
        validation_status TEXT DEFAULT 'pending',
        last_updated DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(supplier_name, location)
      )`
    ];

    for (const table of tables) {
      await this.run(table);
    }
    
    // Create indices for better performance
    const indices = [
      'CREATE INDEX IF NOT EXISTS idx_supplier_cache_query ON supplier_cache(search_query)',
      'CREATE INDEX IF NOT EXISTS idx_supplier_cache_expires ON supplier_cache(expires_at)',
      'CREATE INDEX IF NOT EXISTS idx_search_metrics_query ON search_metrics(search_query)',
      'CREATE INDEX IF NOT EXISTS idx_supplier_quality_name ON supplier_quality(supplier_name)'
    ];

    for (const index of indices) {
      await this.run(index);
    }
  }

  run(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.run(sql, params, function(err) {
        if (err) reject(err);
        else resolve({ id: this.lastID, changes: this.changes });
      });
    });
  }

  get(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.get(sql, params, (err, row) => {
        if (err) reject(err);
        else resolve(row);
      });
    });
  }

  all(sql, params = []) {
    return new Promise((resolve, reject) => {
      this.db.all(sql, params, (err, rows) => {
        if (err) reject(err);
        else resolve(rows);
      });
    });
  }

  async close() {
    return new Promise((resolve) => {
      if (this.db) {
        this.db.close((err) => {
          if (err) console.error('Database close error:', err);
          resolve();
        });
      } else {
        resolve();
      }
    });
  }
}

module.exports = new Database();