// One-shot idempotent migration: live chat messages table.
// Run: node scripts/migrate-chat.js
import 'dotenv/config'
import pool from '../db/index.js'

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS chat_messages (
    id INT UNSIGNED NOT NULL AUTO_INCREMENT,
    thread_key VARCHAR(64) NOT NULL,
    user_id INT UNSIGNED NULL DEFAULT NULL,
    sender ENUM('visitor', 'agent') NOT NULL DEFAULT 'visitor',
    sender_name VARCHAR(120) NOT NULL DEFAULT 'Visitor',
    body VARCHAR(2000) NOT NULL,
    read_by_admin_at TIMESTAMP NULL DEFAULT NULL,
    read_by_visitor_at TIMESTAMP NULL DEFAULT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (id),
    KEY chat_messages_thread_idx (thread_key, created_at),
    KEY chat_messages_admin_unread_idx (read_by_admin_at, sender),
    CONSTRAINT chat_messages_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE SET NULL
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`)
  console.log('  = chat_messages ready')
  console.log('Live chat migration complete.')
  process.exit(0)
} catch (error) {
  console.error('Migration failed:', error.message)
  process.exit(1)
}
