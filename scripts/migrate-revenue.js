// One-shot idempotent migration: configurable revenue engine (fee rules,
// transactions with fee-split snapshots, per-fee transaction lines).
// Run: node scripts/migrate-revenue.js
import 'dotenv/config'
import pool from '../db/index.js'

const DEFAULT_RULES = [
  ['sale_buyer_fee', 'Buyer service fee', 'sale', 'percent', 1.5, 'tenant_buyer', 50, 'platform', 0, 0, 1],
  ['sale_seller_fee', 'Seller / listing fee', 'sale', 'percent', 1.0, 'landlord_seller', 50, 'platform', 0, 0, 1],
  ['sale_platform_commission', 'Platform commission', 'sale', 'percent', 2.0, 'landlord_seller', 50, 'platform', 0, 0, 1],
  ['sale_agent_commission', 'Agent commission', 'sale', 'percent', 3.0, 'landlord_seller', 50, 'agent', 0, 0, 1],
  ['sale_processing_fee', 'Payment processing fee', 'sale', 'percent', 1.5, 'split', 50, 'processor', 0, 1, 1],
  ['sale_legal_fee', 'Legal / documentation fee', 'sale', 'fixed', 350000, 'split', 50, 'other', 1, 0, 1],
  ['rent_tenant_fee', 'Tenant service fee', 'rent', 'percent', 5.0, 'tenant_buyer', 50, 'platform', 0, 0, 1],
  ['rent_landlord_fee', 'Landlord listing / service fee', 'rent', 'percent', 2.0, 'landlord_seller', 50, 'platform', 0, 0, 1],
  ['rent_transaction_fee', 'Rental transaction fee', 'rent', 'percent', 2.0, 'split', 50, 'platform', 0, 1, 1],
  ['rent_agent_commission', 'Agent commission', 'rent', 'percent', 10.0, 'landlord_seller', 50, 'agent', 0, 1, 1],
  ['rent_application_fee', 'Application fee', 'rent', 'fixed', 10000, 'tenant_buyer', 50, 'platform', 1, 0, 1],
]

try {
  // 1. revenue_rules table.
  await pool.query(`CREATE TABLE IF NOT EXISTS revenue_rules (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    fee_key VARCHAR(60) NOT NULL,
    label VARCHAR(120) NOT NULL,
    scope ENUM('sale', 'rent') NOT NULL,
    kind ENUM('percent', 'fixed') NOT NULL DEFAULT 'percent',
    value DECIMAL(10, 2) NOT NULL DEFAULT 0,
    bearer ENUM('tenant_buyer', 'landlord_seller', 'split') NOT NULL DEFAULT 'tenant_buyer',
    split_percent DECIMAL(5, 2) NOT NULL DEFAULT 50,
    payee ENUM('platform', 'agent', 'processor', 'other') NOT NULL DEFAULT 'platform',
    optional TINYINT(1) NOT NULL DEFAULT 0,
    monthly TINYINT(1) NOT NULL DEFAULT 0,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY revenue_rules_key_unique (fee_key)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`)

  // 2b. Add the 'monthly' column to revenue_rules for existing installs.
  // (Must run BEFORE the seed insert, which references the column.)
  const [ruleCols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'revenue_rules'`,
  )
  if (!ruleCols.some((r) => r.COLUMN_NAME === 'monthly')) {
    await pool.query(
      'ALTER TABLE revenue_rules ADD COLUMN monthly TINYINT(1) NOT NULL DEFAULT 0 AFTER optional',
    )
    console.log('  + revenue_rules.monthly added')
  }

  // 2. Seed the default schedule (INSERT IGNORE keeps existing edits).
  await pool.query(
    `INSERT IGNORE INTO revenue_rules
       (fee_key, label, scope, kind, value, bearer, split_percent, payee, optional, monthly, enabled)
     VALUES ?`,
    [DEFAULT_RULES],
  )

  // 2a-2. Flip the monthly flag on the default rent-cycle rules (INSERT
  // IGNORE does not touch rows that already existed).
  await pool.query(
    `UPDATE revenue_rules SET monthly = 1
     WHERE fee_key IN ('rent_transaction_fee', 'rent_agent_commission', 'sale_processing_fee')`,
  )
  console.log('  = revenue_rules seeded (monthly flags set)')

  // 3. transactions table.
  await pool.query(`CREATE TABLE IF NOT EXISTS transactions (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    property_id INT UNSIGNED NOT NULL,
    kind ENUM('sale', 'rent') NOT NULL,
    gross_amount DECIMAL(14, 2) NOT NULL,
    owner_net DECIMAL(14, 2) NOT NULL DEFAULT 0,
    buyer_total DECIMAL(14, 2) NOT NULL DEFAULT 0,
    platform_revenue DECIMAL(14, 2) NOT NULL DEFAULT 0,
    agent_id INT UNSIGNED NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY transactions_property_kind_unique (property_id, kind),
    CONSTRAINT transactions_property_fk FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`)

  // 4. transaction_lines table.
  await pool.query(`CREATE TABLE IF NOT EXISTS transaction_lines (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    transaction_id INT UNSIGNED NOT NULL,
    fee_key VARCHAR(60) NOT NULL DEFAULT '',
    label VARCHAR(120) NOT NULL,
    payee ENUM('platform', 'owner', 'agent', 'processor', 'other') NOT NULL,
    amount DECIMAL(14, 2) NOT NULL,
    paid_by ENUM('tenant_buyer', 'landlord_seller') NOT NULL,
    PRIMARY KEY (id),
    KEY transaction_lines_txn_idx (transaction_id),
    CONSTRAINT transaction_lines_txn_fk FOREIGN KEY (transaction_id) REFERENCES transactions (id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`)

  console.log('✓ Revenue engine migration complete')
  await pool.end()
  process.exit(0)
} catch (error) {
  console.error('✗ migration failed:', error.message)
  await pool.end()
  process.exit(1)
}
