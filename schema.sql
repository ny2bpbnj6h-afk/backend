-- Housing Agent — database schema
-- Applied by `npm run db:init` (backend/scripts/init-db.js). Idempotent.

CREATE TABLE IF NOT EXISTS users (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name VARCHAR(120) NOT NULL,
  email VARCHAR(190) NOT NULL,
  phone VARCHAR(40) NOT NULL DEFAULT '',
  password_hash VARCHAR(100) NOT NULL DEFAULT '',
  role ENUM('seeker', 'owner', 'admin') NOT NULL DEFAULT 'seeker',
  preferred_area VARCHAR(190) NOT NULL DEFAULT '',
  portfolio VARCHAR(190) NOT NULL DEFAULT '',
  provider ENUM('local', 'google', 'apple') NOT NULL DEFAULT 'local',
  status ENUM('active', 'suspended') NOT NULL DEFAULT 'active',
  provider_id VARCHAR(190) NOT NULL DEFAULT '',
  agent_id INT UNSIGNED NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY users_email_unique (email),
  KEY users_agent_idx (agent_id),
  CONSTRAINT users_agent_fk FOREIGN KEY (agent_id) REFERENCES users (id)
    ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Housing listings created by owners (landlords). seeker_id records the
-- seeker whose area matched first (informational only). purpose splits
-- rentals from sales so the marketplace can serve both. status covers the
-- moderation lifecycle: pending until an admin approves, then active,
-- then optionally rented/sold while still owned.
CREATE TABLE IF NOT EXISTS properties (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  owner_id INT UNSIGNED NOT NULL,
  title VARCHAR(190) NOT NULL,
  description TEXT NOT NULL,
  area VARCHAR(190) NOT NULL,
  purpose ENUM('rent', 'sale') NOT NULL DEFAULT 'rent',
  property_type ENUM('apartment', 'condo', 'townhouse', 'house', 'serviced_apartment')
    NOT NULL DEFAULT 'apartment',
  rent_amount DECIMAL(10, 2) NOT NULL,
  rent_period ENUM('month', 'year') NOT NULL DEFAULT 'month',
  sale_amount DECIMAL(14, 2) NULL DEFAULT NULL,
  bedrooms TINYINT UNSIGNED NOT NULL DEFAULT 1,
  bathrooms TINYINT UNSIGNED NOT NULL DEFAULT 1,
  size_m2 SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  furnished ENUM('any', 'furnished', 'unfurnished') NOT NULL DEFAULT 'any',
  video_url VARCHAR(500) NOT NULL DEFAULT '',
  tour_url VARCHAR(500) NOT NULL DEFAULT '',
  agent_id INT UNSIGNED NULL DEFAULT NULL,
  views INT UNSIGNED NOT NULL DEFAULT 0,
  status ENUM('pending', 'active', 'rented', 'sold', 'inactive') NOT NULL DEFAULT 'pending',
  seeker_id INT UNSIGNED NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY properties_owner_idx (owner_id),
  KEY properties_agent_idx (agent_id),
  KEY properties_status_purpose_idx (status, purpose),
  CONSTRAINT properties_owner_fk FOREIGN KEY (owner_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT properties_agent_fk FOREIGN KEY (agent_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Rental agreements (leases). Power the admin rent-cycle metrics:
-- outstanding rent (overdue next_due_date) and upcoming rent payments.
CREATE TABLE IF NOT EXISTS leases (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  property_id INT UNSIGNED NOT NULL,
  tenant_id INT UNSIGNED NOT NULL,
  monthly_rent DECIMAL(14, 2) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NULL DEFAULT NULL,
  next_due_date DATE NOT NULL,
  deposit DECIMAL(14, 2) NOT NULL DEFAULT 0,
  late_fee_amount DECIMAL(14, 2) NULL DEFAULT NULL,
  auto_pay TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active', 'ended') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY leases_property_idx (property_id),
  KEY leases_tenant_idx (tenant_id),
  KEY leases_due_idx (status, next_due_date),
  CONSTRAINT leases_property_fk FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE CASCADE,
  CONSTRAINT leases_tenant_fk FOREIGN KEY (tenant_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Rental applications: one per (tenant, property) — unique key makes
-- apply/withdraw idempotent (INSERT ... ON DUPLICATE KEY UPDATE).
CREATE TABLE IF NOT EXISTS applications (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  property_id INT UNSIGNED NOT NULL,
  tenant_id INT UNSIGNED NOT NULL,
  message TEXT NOT NULL,
  status ENUM('pending', 'withdrawn') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY applications_property_tenant_unique (property_id, tenant_id),
  KEY applications_tenant_idx (tenant_id),
  CONSTRAINT applications_property_fk FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE CASCADE,
  CONSTRAINT applications_tenant_fk FOREIGN KEY (tenant_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Scheduled property viewings: one per (tenant, property) — unique key makes
-- schedule/cancel idempotent (INSERT ... ON DUPLICATE KEY UPDATE).
CREATE TABLE IF NOT EXISTS viewings (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  property_id INT UNSIGNED NOT NULL,
  tenant_id INT UNSIGNED NOT NULL,
  scheduled_for DATETIME NOT NULL,
  status ENUM('scheduled', 'cancelled') NOT NULL DEFAULT 'scheduled',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY viewings_property_tenant_unique (property_id, tenant_id),
  KEY viewings_tenant_idx (tenant_id),
  CONSTRAINT viewings_property_fk FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE CASCADE,
  CONSTRAINT viewings_tenant_fk FOREIGN KEY (tenant_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Property media galleries (multiple images per listing).
CREATE TABLE IF NOT EXISTS property_images (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  property_id INT UNSIGNED NOT NULL,
  url VARCHAR(500) NOT NULL,
  sort_order SMALLINT UNSIGNED NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY property_images_property_idx (property_id),
  CONSTRAINT property_images_property_fk FOREIGN KEY (property_id)
    REFERENCES properties (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Platform payments (rent commissions, sale commissions, subscriptions,
-- listing fees). kind + status drive the admin revenue dashboard.
CREATE TABLE IF NOT EXISTS payments (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  user_id INT UNSIGNED NOT NULL,
  property_id INT UNSIGNED NULL DEFAULT NULL,
  kind ENUM('commission_rent', 'commission_sale', 'subscription', 'listing_fee', 'payout') NOT NULL,
  amount DECIMAL(14, 2) NOT NULL,
  status ENUM('pending', 'completed', 'failed', 'refunded') NOT NULL DEFAULT 'pending',
  method ENUM('card', 'bank_transfer', 'crypto') NOT NULL DEFAULT 'card',
  reference VARCHAR(190) NOT NULL DEFAULT '',
  provider VARCHAR(40) NOT NULL DEFAULT 'platform',
  purpose VARCHAR(40) NOT NULL DEFAULT '',
  meta JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY payments_user_idx (user_id),
  KEY payments_property_idx (property_id),
  KEY payments_status_created_idx (status, created_at),
  CONSTRAINT payments_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE,
  CONSTRAINT payments_property_fk FOREIGN KEY (property_id) REFERENCES properties (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Configurable revenue rules — every fee the platform charges is a row here,
-- editable from Admin > Revenue (Settings -> Revenue & Commission Settings).
-- Never hard-code percentages in code; always read them from this table.
CREATE TABLE IF NOT EXISTS revenue_rules (
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
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Default fee schedule (INSERT IGNORE = idempotent seeding).
INSERT IGNORE INTO revenue_rules
  (fee_key, label, scope, kind, value, bearer, split_percent, payee, optional, enabled)
VALUES
  ('sale_buyer_fee', 'Buyer service fee', 'sale', 'percent', 1.50, 'tenant_buyer', 50, 'platform', 0, 1),
  ('sale_seller_fee', 'Seller / listing fee', 'sale', 'percent', 1.00, 'landlord_seller', 50, 'platform', 0, 1),
  ('sale_platform_commission', 'Platform commission', 'sale', 'percent', 2.00, 'landlord_seller', 50, 'platform', 0, 1),
  ('sale_agent_commission', 'Agent commission', 'sale', 'percent', 3.00, 'landlord_seller', 50, 'agent', 0, 1),
  ('sale_processing_fee', 'Payment processing fee', 'sale', 'percent', 1.50, 'split', 50, 'processor', 0, 1),
  ('sale_legal_fee', 'Legal / documentation fee', 'sale', 'fixed', 350000, 'split', 50, 'other', 1, 1),
  ('rent_tenant_fee', 'Tenant service fee', 'rent', 'percent', 5.00, 'tenant_buyer', 50, 'platform', 0, 0, 1),
  ('rent_landlord_fee', 'Landlord listing / service fee', 'rent', 'percent', 2.00, 'landlord_seller', 50, 'platform', 0, 0, 1),
  ('rent_transaction_fee', 'Rental transaction fee', 'rent', 'percent', 2.00, 'split', 50, 'platform', 0, 1, 1),
  ('rent_agent_commission', 'Agent commission', 'rent', 'percent', 10.00, 'landlord_seller', 50, 'agent', 0, 1, 1),
  ('rent_application_fee', 'Application fee', 'rent', 'fixed', 10000, 'tenant_buyer', 50, 'platform', 1, 0, 1);

-- Completed sale/rental transactions with a snapshot of the fee split at
-- the time they happened — this is the "who gets what" ledger.
CREATE TABLE IF NOT EXISTS transactions (
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
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Individual fee lines per transaction: exactly which party paid what and
-- which party receives it (platform / owner / agent / processor / other).
CREATE TABLE IF NOT EXISTS transaction_lines (
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
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Agent/staff profile extensions (agents, property managers, staff roles).
CREATE TABLE IF NOT EXISTS agent_profiles (
  user_id INT UNSIGNED NOT NULL,
  agency_name VARCHAR(190) NOT NULL DEFAULT '',
  rating DECIMAL(3, 2) NOT NULL DEFAULT 0,
  verification_status ENUM('unverified', 'pending', 'verified', 'rejected') NOT NULL DEFAULT 'unverified',
  credentials_url VARCHAR(500) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id),
  CONSTRAINT agent_profiles_user_fk FOREIGN KEY (user_id) REFERENCES users (id) ON DELETE CASCADE
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Commission tiers: effective commission percent by transaction value band,
-- editable from Admin > Settings > Commission Rules. value_min inclusive,
-- value_max exclusive (NULL = no upper bound).
CREATE TABLE IF NOT EXISTS commission_tiers (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  scope ENUM('sale', 'rent') NOT NULL DEFAULT 'sale',
  value_min DECIMAL(14, 2) NOT NULL DEFAULT 0,
  value_max DECIMAL(14, 2) NULL DEFAULT NULL,
  percent DECIMAL(5, 2) NOT NULL DEFAULT 0,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY commission_tiers_scope_idx (scope, value_min)
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

INSERT IGNORE INTO commission_tiers (scope, value_min, value_max, percent, enabled) VALUES
  ('sale', 0, 10000000, 1.00, 1),
  ('sale', 10000000, 50000000, 1.50, 1),
  ('sale', 50000000, NULL, 2.00, 1);

-- Individual rent charges per lease period: one row per due date, with the
-- spec's payment lifecycle (paid/pending/partial/overdue/failed/refunded).
CREATE TABLE IF NOT EXISTS rent_payments (
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
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Accounting-style ledger: every financial event writes balanced entries
-- (debit side = who paid / source of funds, credit side = who receives).
-- Entries are append-only: corrections are new entries referencing the
-- original, never updates.
CREATE TABLE IF NOT EXISTS ledger_entries (
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
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Auto-generated invoices/receipts (numbered HA-YYYY-NNNNN).
CREATE TABLE IF NOT EXISTS invoices (
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
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- In-app notifications (email/SMS/WhatsApp outboxes hang off the same rows).
CREATE TABLE IF NOT EXISTS notifications (
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
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Append-only admin activity log (audit trail: who changed what, old → new).
CREATE TABLE IF NOT EXISTS audit_logs (
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
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Dispute center: users open disputes, admins investigate and resolve
-- (resolution may authorize a refund, which then flows through the ledger).
CREATE TABLE IF NOT EXISTS disputes (
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
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Payout requests: landlords/sellers/agents withdraw their balance. Approval
-- workflow before release; bank details captured at request time.
CREATE TABLE IF NOT EXISTS payouts (
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
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Operational platform settings (rent reminders, grace periods, late fees,
-- autopay, withdrawal fees). Every change is written to audit_logs.
CREATE TABLE IF NOT EXISTS platform_settings (
  setting_key VARCHAR(60) NOT NULL,
  setting_value VARCHAR(190) NOT NULL DEFAULT '',
  updated_by INT UNSIGNED NULL DEFAULT NULL,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (setting_key),
  CONSTRAINT platform_settings_updater_fk FOREIGN KEY (updated_by) REFERENCES users (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

INSERT IGNORE INTO platform_settings (setting_key, setting_value) VALUES
  ('rent_reminder_days', '3'),
  ('rent_grace_days', '3'),
  ('late_fee_kind', 'fixed'),
  ('late_fee_value', '10000'),
  ('autopay_enabled', '0'),
  ('withdrawal_fee_value', '0'),
  ('large_payout_threshold', '5000000');

-- Blog articles: admin-authored content marketing (buying guides, rental
-- tips, market updates, investment advice). slug is the public URL key;
-- drafts stay hidden until published.
CREATE TABLE IF NOT EXISTS blog_posts (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  slug VARCHAR(190) NOT NULL,
  title VARCHAR(190) NOT NULL,
  category ENUM('buying_guide', 'rental_tips', 'market_updates', 'investment_advice') NOT NULL DEFAULT 'buying_guide',
  excerpt VARCHAR(500) NOT NULL DEFAULT '',
  content MEDIUMTEXT NOT NULL,
  cover_image_url VARCHAR(500) NOT NULL DEFAULT '',
  author_id INT UNSIGNED NULL DEFAULT NULL,
  status ENUM('draft', 'published') NOT NULL DEFAULT 'draft',
  views INT UNSIGNED NOT NULL DEFAULT 0,
  published_at TIMESTAMP NULL DEFAULT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NULL DEFAULT NULL ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY blog_posts_slug_unique (slug),
  KEY blog_posts_status_idx (status, published_at),
  CONSTRAINT blog_posts_author_fk FOREIGN KEY (author_id) REFERENCES users (id) ON DELETE SET NULL
) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4;

-- Processed webhook events (idempotency: a provider retry must never
-- settle funds twice). Event ids are unique; replays are acknowledged and
-- skipped.
CREATE TABLE IF NOT EXISTS webhook_events (
  id INT UNSIGNED NOT NULL AUTO_INCREMENT,
  event_id VARCHAR(190) NOT NULL,
  provider VARCHAR(40) NOT NULL DEFAULT '',
  event_name VARCHAR(60) NOT NULL DEFAULT '',
  reference VARCHAR(190) NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY webhook_events_event_unique (event_id),
  KEY webhook_events_ref_idx (reference)
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
