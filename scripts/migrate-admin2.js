// One-shot idempotent migration for the expanded admin dashboard:
// leases table (rent-cycle metrics), 'payout' payment kind, and status
// timestamps on properties (rented_at/sold_at power the sales/rentals
// time series). Run: node scripts/migrate-admin2.js
import 'dotenv/config'
import pool from '../db/index.js'

try {
  // 1. leases table (rental agreements powering outstanding/upcoming rent).
  await pool.query(`
    CREATE TABLE IF NOT EXISTS leases (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      property_id INT UNSIGNED NOT NULL,
      tenant_id INT UNSIGNED NOT NULL,
      monthly_rent DECIMAL(14, 2) NOT NULL,
      start_date DATE NOT NULL,
      next_due_date DATE NOT NULL,
      status ENUM('active', 'ended') NOT NULL DEFAULT 'active',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      KEY leases_property_idx (property_id),
      KEY leases_tenant_idx (tenant_id),
      KEY leases_due_idx (status, next_due_date),
      CONSTRAINT leases_property_fk FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE CASCADE,
      CONSTRAINT leases_tenant_fk FOREIGN KEY (tenant_id) REFERENCES users (id) ON DELETE CASCADE
    ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4
  `)
  console.log('  = leases table ready')

  // 2. Add 'payout' to the payments.kind enum when missing.
  const [kindCol] = await pool.query(
    `SELECT COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments'
       AND COLUMN_NAME = 'kind'`,
  )
  if (kindCol[0] && !kindCol[0].COLUMN_TYPE.includes('payout')) {
    await pool.query(
      `ALTER TABLE payments MODIFY COLUMN kind ENUM('commission_rent','commission_sale','subscription','listing_fee','payout') NOT NULL`,
    )
    console.log('  + payments.kind now includes payout')
  } else {
    console.log('  = payments.kind already includes payout')
  }

  // 3. rented_at / sold_at timestamps on properties (for time series).
  const [propCols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'properties'`,
  )
  const propNames = new Set(propCols.map((row) => row.COLUMN_NAME))
  if (!propNames.has('rented_at')) {
    await pool.query(
      'ALTER TABLE properties ADD COLUMN rented_at TIMESTAMP NULL DEFAULT NULL AFTER views',
    )
    console.log('  + added properties.rented_at')
  } else {
    console.log('  = properties.rented_at already exists')
  }
  if (!propNames.has('sold_at')) {
    await pool.query(
      'ALTER TABLE properties ADD COLUMN sold_at TIMESTAMP NULL DEFAULT NULL AFTER rented_at',
    )
    console.log('  + added properties.sold_at')
  } else {
    console.log('  = properties.sold_at already exists')
  }
  if (!propNames.has('updated_at')) {
    await pool.query(
      'ALTER TABLE properties ADD COLUMN updated_at TIMESTAMP NULL DEFAULT NULL',
    )
    console.log('  + added properties.updated_at')
  } else {
    console.log('  = properties.updated_at already exists')
  }

  // 4. Backfill: stamp existing rented/sold rows so the charts have history.
  const [stampRent] = await pool.query(
    "UPDATE properties SET rented_at = COALESCE(rented_at, updated_at, created_at) WHERE status = 'rented' AND rented_at IS NULL",
  )
  const [stampSold] = await pool.query(
    "UPDATE properties SET sold_at = COALESCE(sold_at, updated_at, created_at) WHERE status = 'sold' AND sold_at IS NULL",
  )
  console.log(
    `  + backfilled timestamps (${stampRent.affectedRows} rented, ${stampSold.affectedRows} sold)`,
  )

  console.log('✓ Admin v2 migration complete')
  await pool.end()
  process.exit(0)
} catch (error) {
  console.error('✗ migration failed:', error.message)
  await pool.end()
  process.exit(1)
}
