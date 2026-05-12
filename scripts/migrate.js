// Database migration script
const database = require('../config/database');

async function migrate() {
  try {
    console.log('🔄 Running database migrations...');
    await database.init();
    console.log('✅ Database migrations completed successfully');
    await database.close();
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exit(1);
  }
}

// Run migration if called directly
if (require.main === module) {
  migrate();
}

module.exports = migrate;