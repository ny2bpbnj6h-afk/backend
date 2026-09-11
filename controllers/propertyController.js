// Properties, rental applications, and viewings.
//
// Apply & schedule are TOGGLES: the same request re-issued while active
// withdraws/cancels instead of duplicating, and returns
// `{ applied: false }` / `{ scheduled: false }` so the mobile site can
// flip its button label ("Apply Now" <-> "Undo Application") and un-apply
// when the button is tapped a second time.
import pool from '../db/index.js'
import { checkPriceDrops } from './tenantController.js'

const PROPERTY_TYPES = ['apartment', 'condo', 'townhouse', 'house', 'serviced_apartment']
const PURPOSES = ['rent', 'sale']

// Map a properties row (plus optional joined images) to the API shape.
const publicProperty = (row, images = []) => ({
  id: row.id,
  title: row.title,
  description: row.description,
  area: row.area,
  purpose: row.purpose || 'rent',
  propertyType: row.property_type || 'apartment',
  price: purposePrice(row),
  rentAmount: Number(row.rent_amount || 0),
  rentPeriod: row.rent_period,
  saleAmount: row.sale_amount != null ? Number(row.sale_amount) : null,
  bedrooms: row.bedrooms,
  bathrooms: row.bathrooms,
  sizeM2: row.size_m2 || 0,
  furnished: row.furnished || 'any',
  videoUrl: row.video_url || '',
  tourUrl: row.tour_url || '',
  views: row.views || 0,
  status: row.status,
  images,
  createdAt: row.created_at,
})

// Effective display price: sale price when selling, otherwise periodic rent.
const purposePrice = (row) =>
  row.purpose === 'sale'
    ? Number(row.sale_amount || 0)
    : Number(row.rent_amount || 0)

// Fetch all gallery images for a set of property ids in one query.
const imagesFor = async (ids) => {
  if (!ids.length) return new Map()
  const [rows] = await pool.query(
    `SELECT property_id, url FROM property_images
     WHERE property_id IN (?) ORDER BY sort_order, id`,
    [ids],
  )
  const map = new Map()
  for (const row of rows) {
    if (!map.has(row.property_id)) map.set(row.property_id, [])
    map.get(row.property_id).push(row.url)
  }
  return map
}

// ---- Owner: listings ----

export async function createProperty(req, res) {
  const ownerId = req.user.id
  const {
    title,
    description,
    area,
    purpose,
    propertyType,
    rentAmount,
    rentPeriod,
    saleAmount,
    bedrooms,
    bathrooms,
    sizeM2,
    furnished,
    videoUrl,
    tourUrl,
    images = [],
    agentId,
  } = req.body

  try {
    // Default the assigned agent to the owner's linked agent.
    let effectiveAgentId = agentId ?? null
    if (effectiveAgentId == null) {
      const [ownerRows] = await pool.query('SELECT agent_id FROM users WHERE id = ?', [ownerId])
      effectiveAgentId = ownerRows[0]?.agent_id ?? null
    }
    // New listings start pending until an admin/owner approves them.
    const [result] = await pool.query(
      `INSERT INTO properties
         (owner_id, title, description, area, purpose, property_type,
          rent_amount, rent_period, sale_amount, bedrooms, bathrooms,
          size_m2, furnished, video_url, tour_url, agent_id, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending')`,
      [
        ownerId,
        title,
        description,
        area,
        purpose,
        propertyType,
        rentAmount ?? 0,
        rentPeriod,
        purpose === 'sale' ? saleAmount : null,
        bedrooms,
        bathrooms,
        sizeM2,
        furnished,
        videoUrl,
        tourUrl,
        effectiveAgentId,
      ],
    )
    const propertyId = result.insertId
    if (images.length) {
      await pool.query(
        'INSERT INTO property_images (property_id, url, sort_order) VALUES ?',
        [images.map((url, index) => [propertyId, url, index])],
      )
    }
    const [rows] = await pool.query('SELECT * FROM properties WHERE id = ?', [
      propertyId,
    ])
    return res.status(201).json({ property: publicProperty(rows[0], images) })
  } catch (error) {
    console.error('createProperty failed:', error)
    return res.status(500).json({ error: 'Could not create the listing' })
  }
}

// Public listing detail. Signed-in tenants also get their own application
// and viewing state so the UI can render "Undo" vs "Apply Now".
// Owner edits their listing. Only the supplied fields change; a price
// decrease triggers price-alert notifications for watching tenants.
export async function updateProperty(req, res) {
  const propertyId = Number(req.params.propertyId)
  const { title, description, rentAmount, saleAmount } = req.body
  try {
    const [rows] = await pool.query('SELECT * FROM properties WHERE id = ?', [propertyId])
    const property = rows[0]
    if (!property) return res.status(404).json({ error: 'Property not found' })
    if (property.owner_id !== req.user.id && req.user.role !== 'admin') {
      return res.status(403).json({ error: 'You can only edit your own listings' })
    }
    if (rentAmount !== undefined && (Number.isNaN(Number(rentAmount)) || Number(rentAmount) < 0)) {
      return res.status(422).json({ error: 'rentAmount must be a non-negative number' })
    }
    if (saleAmount !== undefined && saleAmount !== null && (Number.isNaN(Number(saleAmount)) || Number(saleAmount) < 0)) {
      return res.status(422).json({ error: 'saleAmount must be a non-negative number' })
    }

    const oldPrice = priceOfRow(property)
    await pool.query(
      `UPDATE properties SET
         title = COALESCE(?, title),
         description = COALESCE(?, description),
         rent_amount = COALESCE(?, rent_amount),
         sale_amount = COALESCE(?, sale_amount)
       WHERE id = ?`,
      [
        title?.trim() || null,
        description?.trim() || null,
        rentAmount === undefined ? null : Number(rentAmount),
        saleAmount === undefined ? null : saleAmount === null ? null : Number(saleAmount),
        propertyId,
      ],
    )

    const [updated] = await pool.query('SELECT * FROM properties WHERE id = ?', [propertyId])
    const newPrice = priceOfRow(updated[0])
    if (newPrice < oldPrice) {
      // Fire-and-forget style: alert failures must not fail the edit.
      await checkPriceDrops(propertyId, oldPrice, newPrice).catch((alertError) =>
        console.error('price alert check failed:', alertError.message),
      )
    }
    return res.json({ ok: true })
  } catch (error) {
    console.error('updateProperty failed:', error)
    return res.status(500).json({ error: 'Could not update the listing' })
  }
}

const priceOfRow = (row) => Number(row.purpose === 'sale' ? row.sale_amount || 0 : row.rent_amount || 0)

export async function getProperty(req, res) {
  const { propertyId } = req.params
  const user = req.user // null for guests (optionalAuth)

  try {
    const [rows] = await pool.query(
      `SELECT p.*, u.name AS owner_name
       FROM properties p JOIN users u ON u.id = p.owner_id
       WHERE p.id = ?`,
      [propertyId],
    )
    if (!rows.length) return res.status(404).json({ error: 'Property not found' })

    // Fire-and-forget view counter for popularity sorting.
    pool
      .query('UPDATE properties SET views = views + 1 WHERE id = ?', [propertyId])
      .catch(() => {})

    const imageMap = await imagesFor([Number(propertyId)])
    const response = {
      property: publicProperty(rows[0], imageMap.get(Number(propertyId)) || []),
      owner: { id: rows[0].owner_id, name: rows[0].owner_name },
    }

    if (user && user.role === 'seeker') {
      const [apps] = await pool.query(
        'SELECT status FROM applications WHERE property_id = ? AND tenant_id = ?',
        [propertyId, user.id],
      )
      const [viewings] = await pool.query(
        'SELECT status FROM viewings WHERE property_id = ? AND tenant_id = ?',
        [propertyId, user.id],
      )
      response.myApplication = {
        applied: apps.length > 0 && apps[0].status === 'pending',
        viewingScheduled: viewings.length > 0 && viewings[0].status === 'scheduled',
      }
    }

    return res.json(response)
  } catch (error) {
    console.error('getProperty failed:', error)
    return res.status(500).json({ error: 'Could not load the property' })
  }
}

// Public listing search/feed with marketplace filters + sorting.
// Query params: area, q, purpose, type, beds, baths, minPrice, maxPrice,
//               minSize, furnished, sort (newest|price-asc|price-desc|popular)
export async function listProperties(req, res) {
  const {
    area,
    q,
    purpose,
    type,
    beds,
    baths,
    minPrice,
    maxPrice,
    minSize,
    furnished,
    sort,
  } = req.query

  try {
    const where = ['p.status = ?']
    const params = ['active']

    if (area) {
      where.push('p.area LIKE ?')
      params.push(`%${area}%`)
    }
    if (q) {
      where.push('(p.title LIKE ? OR p.description LIKE ?)')
      params.push(`%${q}%`, `%${q}%`)
    }
    if (PURPOSES.includes(purpose)) {
      where.push('p.purpose = ?')
      params.push(purpose)
    }
    if (PROPERTY_TYPES.includes(type)) {
      where.push('p.property_type = ?')
      params.push(type)
    }
    if (beds && Number(beds) > 0) {
      where.push('p.bedrooms >= ?')
      params.push(Number(beds))
    }
    if (baths && Number(baths) > 0) {
      where.push('p.bathrooms >= ?')
      params.push(Number(baths))
    }
    if (minPrice && Number(minPrice) > 0) {
      where.push('IF(p.purpose = \'sale\', p.sale_amount, p.rent_amount) >= ?')
      params.push(Number(minPrice))
    }
    if (maxPrice && Number(maxPrice) > 0) {
      where.push('IF(p.purpose = \'sale\', p.sale_amount, p.rent_amount) <= ?')
      params.push(Number(maxPrice))
    }
    if (minSize && Number(minSize) > 0) {
      where.push('p.size_m2 >= ?')
      params.push(Number(minSize))
    }
    if (['furnished', 'unfurnished'].includes(furnished)) {
      where.push('p.furnished IN (?, \'any\')')
      params.push(furnished)
    }

    const orderBy =
      sort === 'price-asc'
        ? 'IF(p.purpose = \'sale\', p.sale_amount, p.rent_amount) ASC, p.id DESC'
        : sort === 'price-desc'
          ? 'IF(p.purpose = \'sale\', p.sale_amount, p.rent_amount) DESC, p.id DESC'
          : sort === 'popular'
            ? 'p.views DESC, p.id DESC'
            : 'p.created_at DESC, p.id DESC' // newest (default)

    const [rows] = await pool.query(
      `SELECT p.*, u.name AS owner_name
       FROM properties p JOIN users u ON u.id = p.owner_id
       WHERE ${where.join(' AND ')}
       ORDER BY ${orderBy}
       LIMIT 100`,
      params,
    )
    const imageMap = await imagesFor(rows.map((row) => row.id))
    return res.json({
      properties: rows.map((row) =>
        publicProperty(row, imageMap.get(row.id) || []),
      ),
    })
  } catch (error) {
    console.error('listProperties failed:', error)
    return res.status(500).json({ error: 'Could not load properties' })
  }
}

// ---- Tenant: apply / withdraw toggle ----

export async function applyToProperty(req, res) {
  const propertyId = Number(req.params.propertyId)
  const tenantId = req.user.id
  const { message } = req.body

  try {
    // Property must exist, be active, and not belong to the applicant.
    const [props] = await pool.query(
      'SELECT id, owner_id, status FROM properties WHERE id = ?',
      [propertyId],
    )
    const property = props[0]
    if (!property) return res.status(404).json({ error: 'Property not found' })
    if (property.owner_id === tenantId) {
      return res.status(403).json({ error: "You can't apply to your own listing" })
    }
    if (property.status !== 'active') {
      return res.status(409).json({ error: 'This listing is not accepting applications' })
    }

    // Toggle core: an existing PENDING application is withdrawn; otherwise
    // (re)insert as pending. Unique (property_id, tenant_id) keeps it safe.
    await pool.query(
      `INSERT INTO applications (property_id, tenant_id, message, status)
       VALUES (?, ?, ?, 'pending')
       ON DUPLICATE KEY UPDATE
         status = IF(status = 'pending', 'withdrawn', 'pending'),
         message = IF(status = 'pending', message, VALUES(message)),
         updated_at = NOW()`,
      [propertyId, tenantId, message],
    )

    const [rows] = await pool.query(
      'SELECT status FROM applications WHERE property_id = ? AND tenant_id = ?',
      [propertyId, tenantId],
    )
    const applied = rows[0].status === 'pending'

    return res.json({
      applied,
      status: rows[0].status,
      message: applied ? 'Application submitted' : 'Application withdrawn',
    })
  } catch (error) {
    console.error('applyToProperty failed:', error)
    return res.status(500).json({ error: 'Could not update the application' })
  }
}

// ---- Tenant: schedule / cancel viewing toggle ----

export async function scheduleViewing(req, res) {
  const propertyId = Number(req.params.propertyId)
  const tenantId = req.user.id
  const { scheduledFor } = req.body

  try {
    const [props] = await pool.query(
      'SELECT id, owner_id, status FROM properties WHERE id = ?',
      [propertyId],
    )
    const property = props[0]
    if (!property) return res.status(404).json({ error: 'Property not found' })
    if (property.owner_id === tenantId) {
      return res.status(403).json({ error: "You can't schedule a viewing for your own listing" })
    }
    if (property.status !== 'active') {
      return res.status(409).json({ error: 'This listing is not accepting viewings' })
    }

    // Toggle core: a SCHEDULED viewing is cancelled; otherwise (re)insert or
    // reschedule a cancelled one. Unique (property_id, tenant_id) applies.
    await pool.query(
      `INSERT INTO viewings (property_id, tenant_id, scheduled_for, status)
       VALUES (?, ?, ?, 'scheduled')
       ON DUPLICATE KEY UPDATE
         status = IF(status = 'scheduled', 'cancelled', 'scheduled'),
         scheduled_for = IF(status = 'scheduled', scheduled_for, VALUES(scheduled_for)),
         updated_at = NOW()`,
      [propertyId, tenantId, scheduledFor],
    )

    const [rows] = await pool.query(
      'SELECT status, scheduled_for FROM viewings WHERE property_id = ? AND tenant_id = ?',
      [propertyId, tenantId],
    )
    const scheduled = rows[0].status === 'scheduled'

    return res.json({
      scheduled,
      status: rows[0].status,
      scheduledFor: rows[0].scheduled_for,
      message: scheduled ? 'Viewing scheduled' : 'Viewing cancelled',
    })
  } catch (error) {
    console.error('scheduleViewing failed:', error)
    return res.status(500).json({ error: 'Could not update the viewing' })
  }
}
