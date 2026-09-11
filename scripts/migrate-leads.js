// One-shot idempotent migration: contact-message leads + notification outbox.
// Run: node scripts/migrate-leads.js
import 'dotenv/config'
import pool from '../db/index.js'

const TABLES = {
  contact_messages: `CREATE TABLE IF NOT EXISTS contact_messages (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    name VARCHAR(120) NOT NULL,
    email VARCHAR(190) NOT NULL,
    phone VARCHAR(40) NOT NULL DEFAULT '',
    role VARCHAR(40) NOT NULL DEFAULT 'Other',
    message VARCHAR(3000) NOT NULL,
    status ENUM('new', 'contacted', 'closed') NOT NULL DEFAULT 'new',
    source VARCHAR(60) NOT NULL DEFAULT 'contact_page',
    user_id INT UNSIGNED NULL DEFAULT NULL,
    admin_notes VARCHAR(2000) NOT NULL DEFAULT '',
    contacted_at TIMESTAMP NULL DEFAULT NULL,
    closed_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY contact_messages_status_idx (status, created_at),
    KEY contact_messages_email_idx (email),
    CONSTRAINT contact_messages_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
  outbox: `CREATE TABLE IF NOT EXISTS outbox (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    channel ENUM('email', 'whatsapp', 'sms') NOT NULL DEFAULT 'email',
    recipient VARCHAR(190) NOT NULL,
    subject VARCHAR(190) NOT NULL DEFAULT '',
    body VARCHAR(4000) NOT NULL DEFAULT '',
    template VARCHAR(80) NOT NULL DEFAULT '',
    status ENUM('pending', 'sent', 'failed') NOT NULL DEFAULT 'pending',
    attempts INT UNSIGNED NOT NULL DEFAULT 0,
    last_error VARCHAR(500) NOT NULL DEFAULT '',
    user_id INT UNSIGNED NULL DEFAULT NULL,
    entity_type VARCHAR(40) NOT NULL DEFAULT '',
    entity_id INT UNSIGNED NULL DEFAULT NULL,
    sent_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY outbox_status_idx (status, created_at),
    KEY outbox_recipient_idx (recipient),
    CONSTRAINT outbox_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`,
}

try {
  for (const [name, ddl] of Object.entries(TABLES)) {
    await pool.query(ddl)
    console.log(`  = ${name} ready`)
  }
  console.log('Leads + outbox migration complete.')
  process.exit(0)
} catch (error) {
  console.error('Migration failed:', error.message)
  process.exit(1)
}
