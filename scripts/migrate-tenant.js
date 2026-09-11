// One-shot idempotent migration: tenant favorites, price alerts, and
// inquiries. Run: node scripts/migrate-tenant.js
import 'dotenv/config'
import pool from '../db/index.js'

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS favorites (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id INT UNSIGNED NOT NULL,
    property_id INT UNSIGNED NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY favorites_tenant_property_unique (tenant_id, property_id),
    KEY favorites_property_idx (property_id),
    CONSTRAINT favorites_tenant_fk FOREIGN KEY (tenant_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT favorites_property_fk FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`)
  console.log('  = favorites ready')

  await pool.query(`CREATE TABLE IF NOT EXISTS price_alerts (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    tenant_id INT UNSIGNED NOT NULL,
    property_id INT UNSIGNED NOT NULL,
    target_price DECIMAL(14, 2) NULL DEFAULT NULL,
    last_notified_price DECIMAL(14, 2) NULL DEFAULT NULL,
    status ENUM('active', 'triggered', 'off') NOT NULL DEFAULT 'active',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    UNIQUE KEY price_alerts_tenant_property_unique (tenant_id, property_id),
    KEY price_alerts_property_idx (property_id),
    CONSTRAINT price_alerts_tenant_fk FOREIGN KEY (tenant_id) REFERENCES users (id) ON DELETE CASCADE,
    CONSTRAINT price_alerts_property_fk FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`)
  console.log('  = price_alerts ready')

  await pool.query(`CREATE TABLE IF NOT EXISTS inquiries (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    property_id INT UNSIGNED NOT NULL,
    tenant_id INT UNSIGNED NOT NULL,
    name VARCHAR(120) NOT NULL DEFAULT '',
    email VARCHAR(190) NOT NULL DEFAULT '',
    phone VARCHAR(40) NOT NULL DEFAULT '',
    message TEXT NOT NULL,
    status ENUM('new', 'contacted', 'closed') NOT NULL DEFAULT 'new',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY inquiries_property_idx (property_id),
    KEY inquiries_tenant_idx (tenant_id, created_at),
    CONSTRAINT inquiries_property_fk FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE CASCADE,
    CONSTRAINT inquiries_tenant_fk FOREIGN KEY (tenant_id) REFERENCES users (id) ON DELETE CASCADE
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`)
  console.log('  = inquiries ready')

  console.log('Tenant integrations migration complete.')
  await pool.end()
  process.exit(0)
} catch (error) {
  console.error('✗ migrate-tenant failed:', error.message)
  await pool.end()
  process.exit(1)
}
