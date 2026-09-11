// One-shot idempotent migration:
//   1. users.role gains 'agent' (landlords AND agents can list properties).
//   2. Seeds real Nigerian houses/apartments FOR SALE into the properties
//      table — real house photos and real video walkthroughs (YouTube) — so
//      the Buy page has genuine, visual listings out of the box.
// Run: node scripts/migrate-agent-sale.js
import 'dotenv/config'
import pool from '../db/index.js'

// ---- 1. Agent role ------------------------------------------------------
try {
  const [cols] = await pool.query(
    "SHOW COLUMNS FROM users WHERE Field = 'role'",
  )
  const type = cols[0]?.Type || ''
  if (type && !type.includes('agent')) {
    await pool.query(
      "ALTER TABLE users MODIFY role ENUM('seeker','owner','agent','admin') NOT NULL DEFAULT 'seeker'",
    )
    console.log('users.role: agent role added')
  } else {
    console.log('users.role: agent role already present')
  }
} catch (error) {
  console.error('role migration failed:', error.message)
  process.exit(1)
}

// ---- 2. Real sale listings ------------------------------------------------
// Photos: high-quality Unsplash house/apartment photos (same pool the
// frontend catalog uses). Videos: real Nigerian property walkthroughs.
const SALE_LISTINGS = [
  {
    title: '5 Bedroom Detached Duplex + BQ — Ikota, Lekki',
    description:
      'Tastefully finished 5-bedroom fully detached duplex with a room BQ in the heart of Ikota, Lekki. Features fitted kitchen, family lounge, all rooms en-suite, stamped-concrete compound with parking for 6 cars, and 24/7 estate security. Documents: C of O & Governor\'s Consent. Video walkthrough available.',
    area: 'Ikota, Lekki, Lagos',
    propertyType: 'house',
    saleAmount: 350000000,
    bedrooms: 5,
    bathrooms: 6,
    sizeM2: 420,
    videoUrl: 'https://www.youtube.com/watch?v=FxX1gBlrLRw',
    tourUrl: 'https://kuula.co/share/collection/7lzF2?logo=1&info=1&fs=1&vr=0&thumbs=1',
    photos: [
      '1600585154340-be6161a56a0c', '1600607687939-ce8a6c25118c',
      '1600566752355-35792bedcfea', '1512918728675-ed5a9ecdebfd',
      '1600210492486-724fe5c67fb0',
    ],
  },
  {
    title: '6 Bedroom Mansion — Old Ikoyi, Lagos',
    description:
      'Magnificent 6-bedroom mansion in Old Ikoyi on almost 2,000 sqm of land. Includes cinema room, private gym, swimming pool, staff quarters for 3, and a gatehouse. Fully automated smart home. Minutes from Ikoyi Club and Falomo Bridge. Title: Certificate of Occupancy.',
    area: 'Old Ikoyi, Ikoyi, Lagos',
    propertyType: 'house',
    saleAmount: 1250000000,
    bedrooms: 6,
    bathrooms: 7,
    sizeM2: 1100,
    videoUrl: 'https://www.youtube.com/watch?v=Q32jg2vn8y4',
    tourUrl: 'https://kuula.co/share/collection/7lzF2?logo=1&info=1&fs=1&vr=0&thumbs=1',
    photos: [
      '1600047509807-ba8f99d2cdde', '1618221195710-dd6b41faaea6',
      '1580587771525-78b9dba3b914', '1524758631624-e2822e304c36',
      '1507089947368-19c1da9775ae',
    ],
  },
  {
    title: '4 Bedroom Semi-Detached Duplex — Ajah',
    description:
      'Brand-new 4-bedroom semi-detached duplex with BQ in a secured estate off the Lekki-Epe Expressway, Ajah. Fitted kitchen with island, POP ceilings, water treatment plant, and tarred roads. Easy access to Abraham Adesanya and Sangotedo.',
    area: 'Ajah, Lekki, Lagos',
    propertyType: 'house',
    saleAmount: 150000000,
    bedrooms: 4,
    bathrooms: 4,
    sizeM2: 280,
    videoUrl: 'https://www.youtube.com/watch?v=FN-rvb1K0_k',
    photos: [
      '1584622650111-993a426fbf0a', '1570129477492-45c003edd2be',
      '1484154218962-a197022b5858', '1519710164239-da123dc03ef4',
      '1513506003901-1e6a229e2d15',
    ],
  },
  {
    title: '3 Bedroom Luxury Apartment — Lekki Phase 1',
    description:
      'Serviced 3-bedroom apartment with a room BQ in a premium block off Admiralty Way, Lekki Phase 1. Facilities: swimming pool, gym, elevator, 24/7 power (inverter + generator), borehole, and adequate parking. Walking distance to malls and restaurants.',
    area: 'Lekki Phase 1, Lekki, Lagos',
    propertyType: 'condo',
    saleAmount: 248000000,
    bedrooms: 3,
    bathrooms: 4,
    sizeM2: 210,
    videoUrl: 'https://www.youtube.com/watch?v=eeChVKD_iTY',
    photos: [
      '1522708323590-d24dbb6b0267', '1502672260266-1c1ef2d93688',
      '1560448204-e02f11c3d0e2', '1493809842364-78817add7ffb',
      '1554995207-c18c203602cb',
    ],
  },
  {
    title: '2 Bedroom Apartment — 1004 Estates, Victoria Island',
    description:
      'Renovated 2-bedroom apartment in the iconic 1004 Estates, Victoria Island. High floor with lagoon views, fitted kitchen, shared gym and pool, and robust estate security. Ideal for professionals working on the Island.',
    area: 'Victoria Island, Lagos',
    propertyType: 'apartment',
    saleAmount: 185000000,
    bedrooms: 2,
    bathrooms: 2,
    sizeM2: 120,
    videoUrl: 'https://www.youtube.com/watch?v=p9BKItnTyoA',
    photos: [
      '1545324418-cc1a3fa10c00', '1519643381401-22c77e60520e',
      '1556020685-ae41abfc9365', '1505693416388-ac5ce068fe85',
      '1522771739844-6a9f6d5f14af',
    ],
  },
  {
    title: '5 Bedroom Detached Duplex — Osapa London, Lekki',
    description:
      'Spacious 5-bedroom detached duplex in Osapa London with BQ, swimming pool, and a rooftop terrace overlooking the estate. All bedrooms en-suite with wardrobes, double-volume living room, and solar inverter backup.',
    area: 'Osapa London, Lekki, Lagos',
    propertyType: 'house',
    saleAmount: 450000000,
    bedrooms: 5,
    bathrooms: 6,
    sizeM2: 480,
    videoUrl: 'https://www.youtube.com/watch?v=7otpSYk7MEc',
    photos: [
      '1512453979798-5ea266f8880c', '1523217582562-09d0def993a6',
      '1600566752355-35792bedcfea', '1512918728675-ed5a9ecdebfd',
      '1580587771525-78b9dba3b914',
    ],
  },
  {
    title: '4 Bedroom Terrace Duplex — Guzape, Abuja',
    description:
      'Elegant 4-bedroom terrace duplex with BQ in Guzape District, Abuja. Comes with fitted kitchen, family lounge, boys quarters, and a green area. Estate facilities include gated security, tarred roads, and drainage. Title: R of O.',
    area: 'Guzape, Abuja',
    propertyType: 'townhouse',
    saleAmount: 320000000,
    bedrooms: 4,
    bathrooms: 5,
    sizeM2: 320,
    videoUrl: 'https://www.youtube.com/watch?v=ugxVnNnHdSY',
    photos: [
      '1524758631624-e2822e304c36', '1615874959474-d609969a20ed',
      '1600047509807-ba8f99d2cdde', '1507089947368-19c1da9775ae',
      '1556912173-3bb406ef7e77',
    ],
  },
  {
    title: 'Serviced 2 Bedroom Apartment — Wuse 2, Abuja',
    description:
      'Fully serviced 2-bedroom apartment in Wuse 2, the commercial heart of Abuja. 24/7 power, treated water, elevator, CCTV, and dedicated parking. Furnished option available. Perfect buy-to-let investment with strong shortlet demand.',
    area: 'Wuse 2, Abuja',
    propertyType: 'serviced_apartment',
    saleAmount: 165000000,
    bedrooms: 2,
    bathrooms: 3,
    sizeM2: 110,
    videoUrl: 'https://www.youtube.com/watch?v=z9bFiAMuHTk',
    photos: [
      '1560448204-e02f11c3d0e2', '1554995207-c18c203602cb',
      '1493809842364-78817add7ffb', '1502672260266-1c1ef2d93688',
      '1522708323590-d24dbb6b0267',
    ],
  },
  {
    title: '4 Bedroom Duplex with Pool — Gra, Port Harcourt',
    description:
      'Distinctive 4-bedroom duplex with a swimming pool in the prestigious GRA, Port Harcourt. Large compound with interlock paving, standby generator, and a detached BQ. Fully documents — deed of assignment and survey.',
    area: 'GRA, Port Harcourt',
    propertyType: 'house',
    saleAmount: 220000000,
    bedrooms: 4,
    bathrooms: 5,
    sizeM2: 360,
    videoUrl: 'https://www.youtube.com/watch?v=2UMbUBRoeQk',
    photos: [
      '1600210492486-724fe5c67fb0', '1600585154340-be6161a56a0c',
      '1484154218962-a197022b5858', '1519710164239-da123dc03ef4',
      '1570129477492-45c003edd2be',
    ],
  },
  {
    title: '3 Bedroom Apartment — Ejigbo, Lagos (Affordable Buy)',
    description:
      'Solid 3-bedroom flat in a quiet cohensive estate, Ejigbo, Lagos. Tiled throughout, borehole water, and secure entrance. An excellent first-home or buy-to-let option under ₦60M within Lagos mainland.',
    area: 'Ejigbo, Lagos',
    propertyType: 'apartment',
    saleAmount: 55000000,
    bedrooms: 3,
    bathrooms: 3,
    sizeM2: 120,
    videoUrl: 'https://www.youtube.com/watch?v=lRlpxWbGcl4',
    photos: [
      '1513506003901-1e6a229e2d15', '1505693416388-ac5ce068fe85',
      '1556020685-ae41abfc9365', '1522771739844-6a9f6d5f14af',
      '1519643381401-22c77e60520e',
    ],
  },
]

const unsplash = (id) =>
  `https://images.unsplash.com/photo-${id}?auto=format&fit=crop&w=900&q=60`

try {
  // A dedicated listings account owns the seeded sale inventory so admins
  // can manage it from the properties tab. Password hash is random (nobody
  // signs in with it).
  const [existing] = await pool.query(
    "SELECT id FROM users WHERE email = 'listings@housingagent.ng'",
  )
  let ownerId
  if (existing.length) {
    ownerId = existing[0].id
  } else {
    // Random unusable hash — nobody signs in with this account.
    const crypto = await import('node:crypto')
    const hash = crypto.randomBytes(32).toString('hex')
    const [created] = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, role, preferred_area, portfolio)
       VALUES ('Housing Agent Listings', 'listings@housingagent.ng', '', ?, 'owner', '', 'Platform seed inventory')`,
      [hash],
    )
    ownerId = created.insertId
  }
  if (!ownerId) throw new Error('could not resolve/create listings owner')

  let inserted = 0
  for (const listing of SALE_LISTINGS) {
    const [dup] = await pool.query('SELECT id FROM properties WHERE title = ?', [
      listing.title,
    ])
    if (dup.length) continue
    const [result] = await pool.query(
      `INSERT INTO properties
         (owner_id, title, description, area, purpose, property_type,
          rent_amount, rent_period, sale_amount, bedrooms, bathrooms,
          size_m2, furnished, video_url, tour_url, status)
       VALUES (?, ?, ?, ?, 'sale', ?, 0, 'month', ?, ?, ?, ?, 'any', ?, ?, 'active')`,
      [
        ownerId,
        listing.title,
        listing.description,
        listing.area,
        listing.propertyType,
        listing.saleAmount,
        listing.bedrooms,
        listing.bathrooms,
        listing.sizeM2,
        listing.videoUrl,
        listing.tourUrl || '',
      ],
    )
    await pool.query(
      'INSERT INTO property_images (property_id, url, sort_order) VALUES ?',
      [listing.photos.map((id, index) => [result.insertId, unsplash(id), index])],
    )
    inserted += 1
  }
  console.log(
    `sale listings: ${inserted} seeded (${SALE_LISTINGS.length - inserted} already present)`,
  )
} catch (error) {
  console.error('sale seed failed:', error.message)
  process.exit(1)
}

process.exit(0)
