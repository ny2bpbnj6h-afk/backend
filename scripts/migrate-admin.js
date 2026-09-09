// One-shot idempotent migration: introduces the admin role + account
// suspension and the platform payments table. Run with:
//   node scripts/migrate-admin.js
// Grant the first admin with:  node scripts/make-admin.js admin@example.com
import 'dotenv/config'
import pool from '../db/index.js'

try {
  const [cols] = await pool.query(
    `SELECT COLUMN_NAME, COLUMN_TYPE FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`,
  )
  const byName = new Map(cols.map((row) => [row.COLUMN_NAME, row.COLUMN_TYPE]))

  // 1. Widen users.role to include 'admin'.
  if (byName.get('role') && !byName.get('role').includes('admin')) {
    await pool.query(
      "ALTER TABLE users MODIFY COLUMN role ENUM('seeker','owner','admin') NOT NULL DEFAULT 'seeker'",
    )
    console.log('  + users.role now includes admin')
  } else {
    console.log('  = users.role already includes admin')
  }

  // 2. Add users.status (suspension) when missing.
  if (!byName.has('status')) {
    await pool.query(
      "ALTER TABLE users ADD COLUMN status ENUM('active','suspended') NOT NULL DEFAULT 'active' AFTER provider_id",
    )
    console.log('  + added users.status')
  } else {
    console.log('  = users.status already exists')
  }

  // 3. Payments table (CREATE IF NOT EXISTS is idempotent).
  await pool.query(`CREATE TABLE IF NOT EXISTS payments (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    property_id INT UNSIGNED NULL DEFAULT NULL,
    kind ENUM('commission_rent','commission_sale','subscription','listing_fee') NOT NULL,
    amount DECIMAL(14, 2) NOT NULL,
    status ENUM('pending','completed','failed','refunded') NOT NULL DEFAULT 'pending',
    method ENUM('card','bank_transfer','crypto') NOT NULL DEFAULT 'card',
    reference VARCHAR(190) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY payments_user_idx (user_id),
    KEY payments_property_idx (property_id),
    KEY payments_status_created_idx (status, created_at),
    CONSTRAINT payments_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT payments_property_fk FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE SET NULL
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`)
  console.log('  = payments table ready')

  console.log('✓ Admin migration complete')
  await pool.end()
  process.exit(0)
} catch (error) {
  console.error('✗ migration failed:', error.message)
  await pool.end()
  process.exit(1)
}
