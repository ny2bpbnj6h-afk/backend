// One-shot idempotent migration: blog_posts table + starter articles.
// Run: node scripts/migrate-blog.js
import 'dotenv/config'
import pool from '../db/index.js'

try {
  await pool.query(`CREATE TABLE IF NOT EXISTS blog_posts (
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
  ) ENGINE = InnoDB DEFAULT CHARSET = utf8mb4`)
  console.log('  = blog_posts ready')

  // Seed starter articles (INSERT IGNORE keeps admin edits).
  const [admins] = await pool.query("SELECT id FROM users WHERE role = 'admin' LIMIT 1")
  const authorId = admins[0]?.id ?? null
  await pool.query(
    `INSERT IGNORE INTO blog_posts (slug, title, category, excerpt, content, status, published_at, author_id)
     VALUES ?`,
    [
      [
        ['nigerian-property-buying-guide-2026', 'The Complete Nigerian Property Buying Guide (2026)', 'buying_guide',
          'From C-of-O verification to final handover — every step of buying property in Nigeria safely, with realistic costs.',
          'Buying property in Nigeria rewards patience and paperwork. This guide walks through the full journey: setting your budget (price + agency fees + legal + stamp duty), choosing an area, verifying the title document (C-of-O, Governor\'s Consent, or registered Deed), conducting a search at the lands registry, inspecting the property, negotiating, and executing a Deed of Assignment.\n\nRed flags to walk away from: sellers who pressure you to pay "inspection fees" before showing papers, titles under litigation, and prices far below market — in Lagos, if a deal looks too good, it usually is. Always engage a property lawyer; budget 5–10% of the purchase price for fees and charges above the price itself.'],
        ['renting-in-lagos-what-tenants-should-know', 'Renting in Lagos: What Every Tenant Should Know', 'rental_tips',
          'Caution fees, agency fees, service charges — the true cost of renting in Lagos and how to protect yourself.',
          'In Lagos, the advertised rent is only the beginning. Expect agency fee (often 10% of annual rent), caution deposit (refundable, but document the property\'s condition with photos at move-in), and sometimes service charge for estates. Landlords commonly ask for one to two years upfront — negotiate: many now accept monthly or quarterly payments through platforms like this one.\n\nGet every agreement in writing: rent amount, what is included, repair responsibilities, and notice periods. Pay through traceable channels and collect receipts. If your landlord must fix something, send a written notice — it protects your deposit later.'],
        ['nigeria-property-market-update-h1-2026', 'Nigeria Property Market Update — H1 2026', 'market_updates',
          'Rents keep climbing in Island corridors while sales volume cools. What the numbers say and what to expect next.',
          'Lagos prime residential rents continued double-digit growth in the first half of 2026, driven by demand near business districts and the cost of new construction. Sales volume, however, cooled as mortgage rates remained high — buyers shifted toward smaller units and outskirts like Epe and Atan Ota.\n\nWatch for: short-let conversion of older blocks (pushing long-let supply down), infrastructure announcements moving land values (coastal road corridor effects), and naira stability making dollar-priced listings more transparent. We update this quarterly.'],
        ['is-real-estate-a-good-investment-in-nigeria', 'Is Real Estate Still a Good Investment in Nigeria?', 'investment_advice',
          'Inflation hedging, rental yields by city, and the honest risks — how to think about Nigerian property as an investment.',
          'Nigerian real estate is primarily an inflation hedge: values and rents reprice upward as the naira loses purchasing power. Gross rental yields in Lagos typically run 4–7% (higher in Ikorodu/Epe, lower in Ikoyi), before vacancy and maintenance. Compare that against Treasury bills when deciding.\n\nHonest risks: illiquidity (selling takes months), title disputes, and development levies on estate land. Diversify: a mix of land banking (appreciation play) and rental units (cash flow play) beats going all-in on either. Never buy land without a registry search and physical beacon verification.'],
      ].map(([slug, title, category, excerpt, content]) => [slug, title, category, excerpt, content, 'published', new Date(), authorId]),
    ],
  )
  console.log('  = starter articles seeded')
  console.log('Blog migration complete.')
  await pool.end()
  process.exit(0)
} catch (error) {
  console.error('✗ migrate-blog failed:', error.message)
  await pool.end()
  process.exit(1)
}
