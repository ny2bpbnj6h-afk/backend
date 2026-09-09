-- Housing Agent — database schema
-- Applied by `npm run db:init` (backend/scripts/init-db.js). Idempotent.

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL,
  phone VARCHAR(40) NOT NULL DEFAULT '',
  password_hash VARCHAR(100) NOT NULL DEFAULT '',
  role ENUM('seeker', 'owner') NOT NULL DEFAULT 'seeker',
  preferred_area VARCHAR(190) NOT NULL DEFAULT '',
  portfolio VARCHAR(190) NOT NULL DEFAULT '',
  provider ENUM('local', 'google', 'apple') NOT NULL DEFAULT 'local',
  provider_id VARCHAR(190) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY users_email_unique (email)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Password reset codes (6-digit, 15-minute expiry, single use)
CREATE TABLE IF NOT EXISTS password_resets (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  code_hash VARCHAR(100) NOT NULL,
  expires_at TIMESTAMP NOT NULL DEFAULT (NOW() + INTERVAL 15 MINUTE),
  used_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY password_resets_user_idx (user_id),
  CONSTRAINT password_resets_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;
