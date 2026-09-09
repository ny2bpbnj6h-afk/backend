// One-shot idempotent migration: extends an existing `properties` table with
// the Phase-1 marketplace columns (purpose, property_type, sale_amount,
// size_m2, furnished, video_url, tour_url, views, richer status enum) and adds
// the `property_images` gallery table. Run with: node scripts/migrate-phase1.js
import 'dotenv/config'
import pool from '../db/index.js'

// Existing DBs have the old 2-value status enum; MySQL requires the new
// column definition to include every old value or MODIFY throws 1265.
const STATUS_ENUM = "'pending','active','rented','sold','inactive'"

const columns = [
  {
    name: 'purpose',
    ddl: "ADD COLUMN purpose ENUM('rent','sale') NOT NULL DEFAULT 'rent' AFTER area",
  },
  {
    name: 'property_type',
    ddl: "ADD COLUMN property_type ENUM('apartment','condo','townhouse','house','serviced_apartment') NOT NULL DEFAULT 'apartment' AFTER purpose",
  },
  {
    name: 'sale_amount',
    ddl:
      'ADD COLUMN sale_amount DECIMAL(14, 2) NULL DEFAULT NULL AFTER rent_period',
  },
  {
    name: 'size_m2',
    ddl: 'ADD COLUMN size_m2 SMALLINT UNSIGNED NOT NULL DEFAULT 0 AFTER bathrooms',
  },
  {
    name: 'furnished',
    ddl:
      "ADD COLUMN furnished ENUM('any','furnished','unfurnished') NOT NULL DEFAULT 'any' AFTER size_m2",
  },
  { name: 'video_url', ddl: "ADD COLUMN video_url VARCHAR(500) NOT NULL DEFAULT '' AFTER furnished" },
  { name: 'tour_url', ddl: "ADD COLUMN tour_url VARCHAR(500) NOT NULL DEFAULT '' AFTER video_url" },
  { name: 'views', ddl: 'ADD COLUMN views INT UNSIGNED NOT NULL DEFAULT 0 AFTER tour_url' },
]

try {
  // 1. property_images table (CREATE IF NOT EXISTS is idempotent).
  await pool.query(`CREATE TABLE IF NOT EXISTS property_images (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    property_id INT UNSIGNED NOT NULL,
    url VARCHAR(500) NOT NULL,
    sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY property_images_property_idx (property_id),
    CONSTRAINT property_images_property_fk FOREIGN KEY (property_id)
      REFERENCES properties (id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`)

  // 2. Existing properties are legacy rentals — mark them active.
  await pool.query("UPDATE properties SET status = 'active' WHERE status = 'pending'")

  // 3. Add missing columns one by one; skip ones already present.
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'properties'`,
  )
  const existing = new Set(cols.map((row) => row.COLUMN_NAME))
  for (const column of columns) {
    if (existing.has(column.name)) {
      console.log(`  = properties.${column.name} already exists, skipping`)
      continue
    }
    await pool.query(`ALTER TABLE properties ${column.ddl}`)
    console.log(`  + added properties.${column.name}`)
  }

  // Widen the status enum when needed (old DBs only have
  // 'active','inactive' — new lifecycle needs all five values).
  const [statusCol] = await pool.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'properties'
       AND COLUMN_NAME = 'status'`,
  )
  if (statusCol[0] && !statusCol[0].COLUMN_TYPE.includes('rented')) {
    await pool.query(
      `ALTER TABLE properties MODIFY COLUMN status ENUM(${STATUS_ENUM}) NOT NULL DEFAULT 'pending'`,
    )
    console.log('  + widened properties.status enum')
  } else {
    console.log('  = properties.status enum already widened')
  }

  // Sale prices in naira exceed DECIMAL(10,2)'s 99,999,999 cap — widen to 14.
  const [saleCol] = await pool.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'properties'
       AND COLUMN_NAME = 'sale_amount'`,
  )
  if (saleCol[0] && saleCol[0].COLUMN_TYPE.startsWith('decimal(10,')) {
    await pool.query(
      'ALTER TABLE properties MODIFY COLUMN sale_amount DECIMAL(14, 2) NULL DEFAULT NULL',
    )
    console.log('  + widened properties.sale_amount to DECIMAL(14,2)')
  } else {
    console.log('  = properties.sale_amount precision already ok')
  }

  // 4. Helpful composite index for the marketplace queries.
  await pool.query(
    'CREATE INDEX properties_status_purpose_idx ON properties (status, purpose)',
  ).catch(() => console.log('  = index properties_status_purpose_idx already exists'))

  console.log('✓ Phase-1 migration complete')
  await pool.end()
  process.exit(0)
} catch (error) {
  console.error('✗ migration failed:', error.message)
  await pool.end()
  process.exit(1)
}
