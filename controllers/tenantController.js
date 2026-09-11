// Tenant account integrations: favorites (save), compare tray, price
// alerts (notify on price drops), and contact-agent inquiries (history).
// All endpoints require a signed-in account (seeker or owner both allowed —
// landlords can shortlist too, but tenant dashboards are the primary UI).
import pool from '../db/index.js'
import { notify } from '../services/ledger.js'

const propertyCard = (row) => ({
  id: row.id,
  title: row.title,
  area: row.area,
  purpose: row.purpose,
  propertyType: row.property_type,
  rentAmount: Number(row.rent_amount || 0),
  saleAmount: row.sale_amount === null ? null : Number(row.sale_amount),
  rentPeriod: row.rent_period,
  bedrooms: row.bedrooms,
  bathrooms: row.bathrooms,
  sizeM2: row.size_m2,
  furnished: row.furnished,
  status: row.status,
  views: row.views,
  image: row.primary_image || null,
  addedAt: row.added_at,
})

const CARD_SELECT = `p.id, p.title, p.area, p.purpose, p.property_type, p.rent_amount, p.sale_amount,
  p.rent_period, p.bedrooms, p.bathrooms, p.size_m2, p.furnished, p.status, p.views,
  (SELECT url FROM property_images pi WHERE pi.property_id = p.id ORDER BY pi.sort_order LIMIT 1) AS primary_image`

// =========================================================== FAVORITES ==
// Toggle: first call saves, second call removes. Returns { saved } so the
// UI can flip the heart.
export async function toggleFavorite(req, res) {
  const propertyId = Number(req.params.propertyId)
  try {
    const [exists] = await pool.query("SELECT id, status FROM properties WHERE id = ?", [propertyId])
    if (!exists.length) return res.status(404).json({ error: 'Property not found' })

    const [current] = await pool.query('SELECT id FROM favorites WHERE tenant_id = ? AND property_id = ?', [req.user.id, propertyId])
    if (current.length) {
      await pool.query('DELETE FROM favorites WHERE id = ?', [current[0].id])
      return res.json({ saved: false })
    }
    await pool.query('INSERT INTO favorites (tenant_id, property_id) VALUES (?, ?)', [req.user.id, propertyId])
    return res.status(201).json({ saved: true })
  } catch (error) {
    console.error('toggleFavorite failed:', error)
    return res.status(500).json({ error: 'Could not update favorites' })
  }
}

export async function listFavorites(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT ${CARD_SELECT}, f.created_at AS added_at
       FROM favorites f JOIN properties p ON p.id = f.property_id
       WHERE f.tenant_id = ? ORDER BY f.created_at DESC LIMIT 100`,
      [req.user.id],
    )
    return res.json({ favorites: rows.map(propertyCard) })
  } catch (error) {
    console.error('listFavorites failed:', error)
    return res.status(500).json({ error: 'Could not load favorites' })
  }
}

// ============================================================= COMPARE ==
// Compare is favorites-with-a-flag on the client: the tray is just a list
// of saved properties fetched by id, so any set can be compared side by
// side. This endpoint returns full detail for up to 4 properties.
export async function compareProperties(req, res) {
  const ids = (Array.isArray(req.body.propertyIds) ? req.body.propertyIds : [])
    .map(Number)
    .filter((id) => Number.isInteger(id) && id > 0)
    .slice(0, 4)
  if (!ids.length) return res.json({ properties: [] })
  try {
    const [rows] = await pool.query(
      `SELECT ${CARD_SELECT.replace('p.views', 'p.views, p.description, p.video_url, p.tour_url')},
              u.name AS owner_name
       FROM properties p JOIN users u ON u.id = p.owner_id
       WHERE p.id IN (?)`,
      [ids],
    )
    const byId = new Map(rows.map((row) => [row.id, row]))
    const properties = ids.map((id) => byId.get(id)).filter(Boolean).map((row) => ({
      ...propertyCard(row),
      description: row.description,
      videoUrl: row.video_url,
      tourUrl: row.tour_url,
      ownerName: row.owner_name,
    }))
    return res.json({ properties })
  } catch (error) {
    console.error('compareProperties failed:', error)
    return res.status(500).json({ error: 'Could not load the comparison' })
  }
}

// ========================================================= PRICE ALERTS ==
// Toggle with an optional target price. Second call turns the alert off.
export async function togglePriceAlert(req, res) {
  const propertyId = Number(req.params.propertyId)
  const { targetPrice } = req.body
  if (targetPrice !== undefined && targetPrice !== null && (Number.isNaN(Number(targetPrice)) || Number(targetPrice) < 0)) {
    return res.status(422).json({ error: 'targetPrice must be a non-negative number' })
  }
  try {
    const [exists] = await pool.query('SELECT id FROM properties WHERE id = ?', [propertyId])
    if (!exists.length) return res.status(404).json({ error: 'Property not found' })

    const [current] = await pool.query('SELECT id, status FROM price_alerts WHERE tenant_id = ? AND property_id = ?', [req.user.id, propertyId])
    if (current.length) {
      await pool.query('DELETE FROM price_alerts WHERE id = ?', [current[0].id])
      return res.json({ watching: false })
    }
    await pool.query(
      'INSERT INTO price_alerts (tenant_id, property_id, target_price) VALUES (?, ?, ?)',
      [req.user.id, propertyId, targetPrice ?? null],
    )
    return res.status(201).json({ watching: true })
  } catch (error) {
    console.error('togglePriceAlert failed:', error)
    return res.status(500).json({ error: 'Could not update the alert' })
  }
}

export async function listPriceAlerts(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT ${CARD_SELECT}, pa.target_price, pa.status AS alert_status, pa.created_at AS added_at
       FROM price_alerts pa JOIN properties p ON p.id = pa.property_id
       WHERE pa.tenant_id = ? ORDER BY pa.created_at DESC LIMIT 100`,
      [req.user.id],
    )
    return res.json({
      alerts: rows.map((row) => ({
        ...propertyCard(row),
        targetPrice: row.target_price === null ? null : Number(row.target_price),
        alertStatus: row.alert_status,
      })),
    })
  } catch (error) {
    console.error('listPriceAlerts failed:', error)
    return res.status(500).json({ error: 'Could not load alerts' })
  }
}

// Price-drop check: runs when an owner updates a listing price (and can be
// triggered manually). Notifies every active watcher of that property.
export async function checkPriceDrops(propertyId, oldPrice, newPrice) {
  if (!(newPrice < oldPrice)) return
  const [watchers] = await pool.query(
    "SELECT * FROM price_alerts WHERE property_id = ? AND status = 'active'",
    [propertyId],
  )
  const [props] = await pool.query('SELECT title FROM properties WHERE id = ?', [propertyId])
  const title = props[0]?.title || 'a property'
  for (const alert of watchers) {
    // Target price hit, or any drop when no target was set.
    if (alert.target_price === null || newPrice <= Number(alert.target_price)) {
      await notify(
        alert.tenant_id,
        'price_drop',
        'Price drop',
        `"${title}" dropped from ₦${Number(oldPrice).toLocaleString()} to ₦${Number(newPrice).toLocaleString()}.`,
        'property',
        propertyId,
      )
      await pool.query('UPDATE price_alerts SET status = ?, last_notified_price = ? WHERE id = ?', ['triggered', newPrice, alert.id])
    }
  }
}

// ============================================================ INQUIRIES ==
// "Contact agent" form on the property page → the inquiry record doubles as
// the tenant's inquiry history and the lead-management source.
export async function createInquiry(req, res) {
  const propertyId = Number(req.params.propertyId)
  const { name, email, phone, message } = req.body
  if (!message || !String(message).trim()) {
    return res.status(422).json({ error: 'A message is required' })
  }
  try {
    const [props] = await pool.query('SELECT id, owner_id, title FROM properties WHERE id = ?', [propertyId])
    const property = props[0]
    if (!property) return res.status(404).json({ error: 'Property not found' })

    const [result] = await pool.query(
      `INSERT INTO inquiries (property_id, tenant_id, name, email, phone, message) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        propertyId,
        req.user.id,
        name || req.user.name || '',
        email || req.user.email || '',
        phone || req.user.phone || '',
        String(message).trim(),
      ],
    )

    // Notify the landlord (owner) that a lead arrived.
    await notify(
      property.owner_id,
      'new_inquiry',
      'New inquiry',
      `${req.user.name} asked about "${property.title}": ${String(message).slice(0, 120)}`,
      'property',
      propertyId,
    )
    return res.status(201).json({ ok: true, inquiryId: result.insertId })
  } catch (error) {
    console.error('createInquiry failed:', error)
    return res.status(500).json({ error: 'Could not send the inquiry' })
  }
}

export async function listMyInquiries(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT i.id, i.message, i.status, i.created_at, i.property_id,
              p.title AS property_title, p.area AS property_area,
              (SELECT url FROM property_images pi WHERE pi.property_id = p.id ORDER BY pi.sort_order LIMIT 1) AS primary_image
       FROM inquiries i JOIN properties p ON p.id = i.property_id
       WHERE i.tenant_id = ? ORDER BY i.created_at DESC LIMIT 100`,
      [req.user.id],
    )
    return res.json({ inquiries: rows })
  } catch (error) {
    console.error('listMyInquiries failed:', error)
    return res.status(500).json({ error: 'Could not load inquiries' })
  }
}

// Owner-side: inquiries received on their listings (lead management feed).
export async function listOwnerInquiries(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT i.id, i.property_id, i.name, i.email, i.phone, i.message, i.status, i.created_at,
              p.title AS property_title, u.name AS tenant_name
       FROM inquiries i
       JOIN properties p ON p.id = i.property_id
       JOIN users u ON u.id = i.tenant_id
       WHERE p.owner_id = ? ORDER BY i.created_at DESC LIMIT 200`,
      [req.user.id],
    )
    return res.json({ inquiries: rows })
  } catch (error) {
    console.error('listOwnerInquiries failed:', error)
    return res.status(500).json({ error: 'Could not load inquiries' })
  }
}
