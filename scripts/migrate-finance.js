// One-shot idempotent migration for the finance platform:
// ledger_entries, rent_payments, invoices, notifications, audit_logs,
// disputes, payouts, agent_profiles, commission_tiers, platform_settings,
// plus payments/leases/users extensions. Run: node scripts/migrate-finance.js
import 'dotenv/config'
import pool from '../db/index.js'

const TABLES = {
  agent_profiles: `CREATE TABLE IF NOT EXISTS agent_profiles (
    user_id INT UNSIGNED NOT NULL,
    agency_name VARCHAR(190) NOT NULL DEFAULT '',
    rating DECIMAL(3, 2) NOT NULL DEFAULT 0,
    verification_status ENUM('unverified', 'pending', 'verified', 'rejected') NOT NULL DEFAULT 'unverified',
    credentials_url VARCHAR(500) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id),
    CONSTRAINT agent_profiles_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,

  commission_tiers: `CREATE TABLE IF NOT EXISTS commission_tiers (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    scope ENUM('sale', 'rent') NOT NULL DEFAULT 'sale',
    value_min DECIMAL(14, 2) NOT NULL DEFAULT 0,
    value_max DECIMAL(14, 2) NULL DEFAULT NULL,
    percent DECIMAL(5, 2) NOT NULL DEFAULT 0,
    enabled TINYINT(1) NOT NULL DEFAULT 1,
    updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY commission_tiers_scope_idx (scope, value_min)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,

  rent_payments: `CREATE TABLE IF NOT EXISTS rent_payments (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    lease_id INT UNSIGNED NOT NULL,
    tenant_id INT UNSIGNED NOT NULL,
    amount_due DECIMAL(14, 2) NOT NULL,
    amount_paid DECIMAL(14, 2) NOT NULL DEFAULT 0,
    due_date DATE NOT NULL,
    paid_at TIMESTAMP NULL DEFAULT NULL,
    late_fee DECIMAL(14, 2) NOT NULL DEFAULT 0,
    status ENUM('pending', 'paid', 'partial', 'overdue', 'failed', 'refunded') NOT NULL DEFAULT 'pending',
    reference VARCHAR(190) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY rent_payments_reference_unique (reference),
    KEY rent_payments_lease_idx (lease_id),
    KEY rent_payments_due_idx (status, due_date),
    CONSTRAINT rent_payments_lease_fk FOREIGN KEY (lease_id) REFERENCES leases (id) ON DELETE CASCADE,
    CONSTRAINT rent_payments_tenant_fk FOREIGN KEY (tenant_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,

  ledger_entries: `CREATE TABLE IF NOT EXISTS ledger_entries (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    txn_ref VARCHAR(190) NOT NULL,
    entry_type ENUM('debit', 'credit') NOT NULL,
    account ENUM('tenant_buyer', 'landlord_seller', 'platform', 'agent', 'processor', 'other', 'payout_clearing') NOT NULL,
    user_id INT UNSIGNED NULL DEFAULT NULL,
    property_id INT UNSIGNED NULL DEFAULT NULL,
    amount DECIMAL(14, 2) NOT NULL,
    currency CHAR(3) NOT NULL DEFAULT 'NGN',
    balance_after DECIMAL(14, 2) NULL DEFAULT NULL,
    description VARCHAR(500) NOT NULL DEFAULT '',
    reference VARCHAR(190) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY ledger_entries_idem_unique (txn_ref, entry_type, account),
    KEY ledger_entries_ref_idx (reference),
    KEY ledger_entries_created_idx (created_at),
    CONSTRAINT ledger_entries_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL,
    CONSTRAINT ledger_entries_property_fk FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE SET NULL
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,

  invoices: `CREATE TABLE IF NOT EXISTS invoices (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    invoice_no VARCHAR(40) NOT NULL,
    user_id INT UNSIGNED NOT NULL,
    property_id INT UNSIGNED NULL DEFAULT NULL,
    txn_ref VARCHAR(190) NOT NULL DEFAULT '',
    kind VARCHAR(40) NOT NULL DEFAULT 'payment',
    subtotal DECIMAL(14, 2) NOT NULL DEFAULT 0,
    fees_total DECIMAL(14, 2) NOT NULL DEFAULT 0,
    total DECIMAL(14, 2) NOT NULL DEFAULT 0,
    currency CHAR(3) NOT NULL DEFAULT 'NGN',
    status ENUM('draft', 'issued', 'paid', 'void') NOT NULL DEFAULT 'paid',
    line_items JSON NULL,
    issued_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY invoices_no_unique (invoice_no),
    KEY invoices_user_idx (user_id),
    KEY invoices_txn_idx (txn_ref),
    CONSTRAINT invoices_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT invoices_property_fk FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE SET NULL
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,

  notifications: `CREATE TABLE IF NOT EXISTS notifications (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    type VARCHAR(60) NOT NULL,
    title VARCHAR(190) NOT NULL,
    body VARCHAR(1000) NOT NULL DEFAULT '',
    entity_type VARCHAR(40) NOT NULL DEFAULT '',
    entity_id INT UNSIGNED NULL DEFAULT NULL,
    read_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY notifications_user_idx (user_id, read_at),
    CONSTRAINT notifications_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,

  audit_logs: `CREATE TABLE IF NOT EXISTS audit_logs (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    admin_id INT UNSIGNED NULL DEFAULT NULL,
    action VARCHAR(60) NOT NULL,
    entity_type VARCHAR(40) NOT NULL DEFAULT '',
    entity_id VARCHAR(60) NOT NULL DEFAULT '',
    previous_value JSON NULL,
    new_value JSON NULL,
    ip VARCHAR(60) NOT NULL DEFAULT '',
    user_agent VARCHAR(300) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY audit_logs_admin_idx (admin_id, created_at),
    KEY audit_logs_action_idx (action),
    CONSTRAINT audit_logs_admin_fk FOREIGN KEY (admin_id) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,

  payouts: `CREATE TABLE IF NOT EXISTS payouts (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    amount DECIMAL(14, 2) NOT NULL,
    bank_name VARCHAR(190) NOT NULL DEFAULT '',
    account_number VARCHAR(60) NOT NULL DEFAULT '',
    account_name VARCHAR(190) NOT NULL DEFAULT '',
    status ENUM('pending', 'under_review', 'approved', 'processing', 'paid', 'failed', 'rejected')
      NOT NULL DEFAULT 'pending',
    txn_ref VARCHAR(190) NOT NULL DEFAULT '',
    admin_note VARCHAR(500) NOT NULL DEFAULT '',
    processed_by INT UNSIGNED NULL DEFAULT NULL,
    processed_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY payouts_user_idx (user_id),
    KEY payouts_status_idx (status),
    CONSTRAINT payouts_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT payouts_processor_fk FOREIGN KEY (processed_by) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,

  platform_settings: `CREATE TABLE IF NOT EXISTS platform_settings (
    setting_key VARCHAR(60) NOT NULL,
    setting_value VARCHAR(190) NOT NULL DEFAULT '',
    updated_by INT UNSIGNED NULL DEFAULT NULL,
    updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (setting_key),
    CONSTRAINT platform_settings_updater_fk FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,

  disputes: `CREATE TABLE IF NOT EXISTS disputes (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    user_id INT UNSIGNED NOT NULL,
    property_id INT UNSIGNED NULL DEFAULT NULL,
    payment_id INT UNSIGNED NULL DEFAULT NULL,
    category ENUM('property', 'payment', 'rental', 'landlord', 'tenant', 'agent', 'refund') NOT NULL DEFAULT 'payment',
    subject VARCHAR(190) NOT NULL,
    details TEXT NOT NULL,
    status ENUM('open', 'investigating', 'resolved', 'rejected') NOT NULL DEFAULT 'open',
    resolution TEXT NULL,
    refund_amount DECIMAL(14, 2) NULL DEFAULT NULL,
    admin_notes TEXT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY disputes_user_idx (user_id),
    KEY disputes_status_idx (status),
    CONSTRAINT disputes_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT disputes_property_fk FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE SET NULL,
    CONSTRAINT disputes_payment_fk FOREIGN KEY (payment_id) REFERENCES payments (id) ON DELETE SET NULL
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,

  webhook_events: `CREATE TABLE IF NOT EXISTS webhook_events (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    event_id VARCHAR(190) NOT NULL,
    provider VARCHAR(40) NOT NULL DEFAULT '',
    event_name VARCHAR(60) NOT NULL DEFAULT '',
    reference VARCHAR(190) NOT NULL DEFAULT '',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY webhook_events_event_unique (event_id),
    KEY webhook_events_ref_idx (reference)
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
}

const TIERS = [
  ['sale', 0, 10000000, 1.0],
  ['sale', 10000000, 50000000, 1.5],
  ['sale', 50000000, null, 2.0],
]

const SETTINGS = [
  ['rent_reminder_days', '3'],
  ['rent_grace_days', '3'],
  ['late_fee_kind', 'fixed'],
  ['late_fee_value', '10000'],
  ['autopay_enabled', '0'],
  ['withdrawal_fee_value', '0'],
  ['large_payout_threshold', '5000000'],
]

try {
  for (const [name, ddl] of Object.entries(TABLES)) {
    await pool.query(ddl)
    console.log(`  = ${name} ready`)
  }

  await pool.query(
    `INSERT IGNORE INTO commission_tiers (scope, value_min, value_max, percent, enabled) VALUES ?`,
    [TIERS.map(([scope, min, max, pct]) => [scope, min, max, pct, 1])],
  )
  console.log('  = commission tiers seeded')

  await pool.query(
    `INSERT IGNORE INTO platform_settings (setting_key, setting_value) VALUES ?`,
    [SETTINGS],
  )
  console.log('  = platform settings seeded')

  // payments: provider/purpose/meta columns (existing DBs).
  const [payCols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payments'`,
  )
  const payNames = new Set(payCols.map((r) => r.COLUMN_NAME))
  if (!payNames.has('provider')) {
    await pool.query(
      "ALTER TABLE payments ADD COLUMN provider VARCHAR(40) NOT NULL DEFAULT 'platform' AFTER reference",
    )
    console.log('  + payments.provider added')
  }
  if (!payNames.has('purpose')) {
    await pool.query(
      "ALTER TABLE payments ADD COLUMN purpose VARCHAR(40) NOT NULL DEFAULT '' AFTER provider",
    )
    console.log('  + payments.purpose added')
  }
  if (!payNames.has('meta')) {
    await pool.query('ALTER TABLE payments ADD COLUMN meta JSON NULL AFTER purpose')
    console.log('  + payments.meta added')
  }

  // leases: end_date, deposit, late_fee_amount, auto_pay (existing DBs).
  const [leaseCols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'leases'`,
  )
  const leaseNames = new Set(leaseCols.map((r) => r.COLUMN_NAME))
  for (const [col, ddl] of [
    ['end_date', 'ALTER TABLE leases ADD COLUMN end_date DATE NULL DEFAULT NULL AFTER start_date'],
    ['deposit', "ALTER TABLE leases ADD COLUMN deposit DECIMAL(14, 2) NOT NULL DEFAULT 0 AFTER end_date"],
    ['late_fee_amount', "ALTER TABLE leases ADD COLUMN late_fee_amount DECIMAL(14, 2) NULL DEFAULT NULL AFTER deposit"],
    ['auto_pay', "ALTER TABLE leases ADD COLUMN auto_pay TINYINT(1) NOT NULL DEFAULT 0 AFTER late_fee_amount"],
  ]) {
    if (!leaseNames.has(col)) {
      await pool.query(ddl)
      console.log(`  + leases.${col} added`)
    }
  }

  // users.agent_id — the assigned/linked agent for owners & tenants.
  const [userCols] = await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'users'`,
  )
  if (!userCols.some((r) => r.COLUMN_NAME === 'agent_id')) {
    await pool.query(
      `ALTER TABLE users ADD COLUMN agent_id INT UNSIGNED NULL DEFAULT NULL AFTER provider_id,
       ADD KEY users_agent_idx (agent_id),
       ADD CONSTRAINT users_agent_fk FOREIGN KEY (agent_id) REFERENCES users (id) ON DELETE SET NULL`,
    )
    console.log('  + users.agent_id added')
  }

  // properties.agent_id — the agent assigned to a listing.
  const hasAgentCol = (await pool.query(
    `SELECT COLUMN_NAME FROM information_schema.COLUMNS
     WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'properties' AND COLUMN_NAME = 'agent_id'`,
  ))[0].length > 0
  if (!hasAgentCol) {
    await pool.query(
      `ALTER TABLE properties ADD COLUMN agent_id INT UNSIGNED NULL DEFAULT NULL AFTER tour_url,
       ADD KEY properties_agent_idx (agent_id),
       ADD CONSTRAINT properties_agent_fk FOREIGN KEY (agent_id) REFERENCES users (id) ON DELETE SET NULL`,
    )
    console.log('  + properties.agent_id added')
  }

  console.log('Finance migration complete.')
  await pool.end()
  process.exit(0)
} catch (error) {
  console.error('✗ migrate-finance failed:', error.message)
  await pool.end()
  process.exit(1)
}
