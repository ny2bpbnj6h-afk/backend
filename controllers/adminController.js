// Admin control center: platform-wide stats, user management, property
// moderation, and payments/revenue. Every route requires an 'admin' role
// account (enforced in routes/index.js via requireAuth('admin')).
import pool from '../db/index.js'
import { recordTransaction } from '../services/revenue.js'
import { audit } from '../services/audit.js'

const publicAdminUser = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  role: row.role,
  status: row.status || 'active',
  provider: row.provider,
  createdAt: row.created_at,
})

const publicAdminProperty = (row, images = []) => ({
  id: row.id,
  title: row.title,
  area: row.area,
  purpose: row.purpose || 'rent',
  propertyType: row.property_type || 'apartment',
  price: row.purpose === 'sale' ? Number(row.sale_amount || 0) : Number(row.rent_amount || 0),
  bedrooms: row.bedrooms,
  bathrooms: row.bathrooms,
  status: row.status,
  views: row.views || 0,
  images,
  owner: { id: row.owner_id, name: row.owner_name, email: row.owner_email },
  createdAt: row.created_at,
})

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

// ---- Overview: the KPI dashboard ----

// Date-range presets. `range` scopes revenue/transaction/user/listing
// metrics; lifetime counts are always included alongside. gte/lt are bare
// SQL datetime expressions spliced into `${column} >= gte AND ${column} < lt`.
const RANGES = {
  today: { gte: 'CURDATE()', lt: 'CURDATE() + INTERVAL 1 DAY', label: 'Today' },
  week: {
    gte: 'CURDATE() - INTERVAL WEEKDAY(NOW()) DAY',
    lt: 'CURDATE() - INTERVAL WEEKDAY(NOW()) DAY + INTERVAL 7 DAY',
    label: 'This week',
  },
  month: {
    gte: "DATE_FORMAT(NOW(), '%Y-%m-01')",
    lt: "DATE_FORMAT(NOW() + INTERVAL 1 MONTH, '%Y-%m-01')",
    label: 'This month',
  },
  quarter: { gte: 'NOW() - INTERVAL 3 MONTH', lt: 'NOW() + INTERVAL 1 DAY', label: 'Last 3 months' },
  year: {
    gte: "DATE_FORMAT(NOW(), '%Y-01-01')",
    lt: "DATE_FORMAT(NOW() + INTERVAL 1 YEAR, '%Y-01-01')",
    label: 'This year',
  },
  all: { gte: "'1970-01-01'", lt: 'NOW() + INTERVAL 1 DAY', label: 'All time' },
}

const resolveRange = (query) => {
  const key = query.range || 'all'
  if (key === 'custom') {
    const from = String(query.from || '').match(/^\d{4}-\d{2}-\d{2}$/) ? query.from : '2000-01-01'
    const to = String(query.to || '').match(/^\d{4}-\d{2}-\d{2}$/) ? `${query.to} 23:59:59` : '2999-12-31 23:59:59'
    return { key, custom: true, from, to, label: 'Custom range' }
  }
  const preset = RANGES[key] || RANGES.all
  return { key, custom: false, gte: preset.gte, lt: preset.lt, label: preset.label }
}

export async function overview(req, res) {
  try {
    const range = resolveRange(req.query)
    // Custom bounds are inlined as literals: from/to are strictly
    // regex-validated YYYY-MM-DD strings (see resolveRange), so there is no
    // injection surface — and the stats query has ~10 range sites, which
    // makes positional placeholders impractical.
    const inRange = (column) =>
      range.custom
        ? `(${column} >= '${range.from}' AND ${column} <= '${range.to}')`
        : `(${column} >= ${range.gte} AND ${column} < ${range.lt})`
    const rangeParams = []

    const [counters] = await pool.query(
      `
      SELECT
        -- Properties (lifetime + available now)
        (SELECT COUNT(*) FROM properties) AS propertiesTotal,
        (SELECT COUNT(*) FROM properties WHERE status = 'active') AS propertiesActive,
        (SELECT COUNT(*) FROM properties WHERE status = 'active' AND purpose = 'rent') AS propertiesAvailable,
        (SELECT COUNT(*) FROM properties WHERE status = 'pending') AS propertiesPending,
        (SELECT COUNT(*) FROM properties WHERE status = 'rented') AS propertiesRented,
        (SELECT COUNT(*) FROM properties WHERE status = 'sold') AS propertiesSold,
        (SELECT COUNT(*) FROM properties WHERE ${inRange('created_at')}) AS propertiesListedInRange,
        -- People
        (SELECT COUNT(*) FROM users) AS usersTotal,
        (SELECT COUNT(*) FROM users WHERE role = 'owner') AS landlordsTotal,
        (SELECT COUNT(*) FROM users WHERE role = 'seeker') AS tenantsTotal,
        (SELECT COUNT(*) FROM users WHERE role = 'admin') AS adminsTotal,
        (SELECT COUNT(DISTINCT owner_id) FROM properties WHERE status = 'sold') AS sellersTotal,
        (SELECT COUNT(DISTINCT tenant_id) FROM leases WHERE status = 'active') AS buyersTotal,
        (SELECT COUNT(*) FROM users WHERE status = 'suspended') AS usersSuspended,
        (SELECT COUNT(*) FROM users WHERE ${inRange('created_at')}) AS newUsersInRange,
        -- Transactions
        (SELECT COUNT(*) FROM properties WHERE status = 'rented' AND ${inRange('COALESCE(rented_at, created_at)')}) AS rentalsInRange,
        (SELECT COUNT(*) FROM properties WHERE status = 'rented') AS rentalsTotal,
        (SELECT COUNT(*) FROM properties WHERE status = 'sold' AND ${inRange('COALESCE(sold_at, created_at)')}) AS salesInRange,
        (SELECT COUNT(*) FROM properties WHERE status = 'sold') AS salesTotal,
        -- Revenue (payments)
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'completed') AS revenueTotal,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'completed' AND ${inRange('created_at')}) AS revenueInRange,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'completed' AND created_at >= DATE_FORMAT(NOW(), '%Y-%m-01')) AS revenueMonth,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'completed' AND created_at >= DATE_FORMAT(NOW(), '%Y-01-01')) AS revenueYear,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'pending') AS pendingPaymentsAmount,
        (SELECT COUNT(*) FROM payments WHERE status = 'pending') AS pendingPaymentsCount,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'pending' AND kind IN ('commission_rent','commission_sale')) AS pendingCommissions,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'completed' AND kind IN ('subscription','listing_fee')) AS platformFees,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'completed' AND kind IN ('commission_rent','commission_sale')) AS agentCommissionsPaid,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE status = 'refunded') AS refundsTotal,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE kind = 'payout' AND status = 'completed') AS payoutsTotal,
        (SELECT COALESCE(SUM(amount), 0) FROM payments WHERE kind = 'payout' AND status = 'pending') AS payoutsPending,
        -- Rent cycle (leases)
        (SELECT COALESCE(SUM(monthly_rent), 0) FROM leases WHERE status = 'active' AND next_due_date < CURDATE()) AS outstandingRent,
        (SELECT COUNT(*) FROM leases WHERE status = 'active' AND next_due_date < CURDATE()) AS overdueLeases,
        (SELECT COALESCE(SUM(monthly_rent), 0) FROM leases WHERE status = 'active' AND next_due_date >= CURDATE() AND next_due_date <= CURDATE() + INTERVAL 30 DAY) AS upcomingRent,
        (SELECT COUNT(*) FROM leases WHERE status = 'active' AND next_due_date >= CURDATE() AND next_due_date <= CURDATE() + INTERVAL 30 DAY) AS upcomingLeases
      `,
      rangeParams,
    )

    // Bucket charts by day for short ranges, month for longer ones.
    const bucket = range.custom
      ? null
      : ['today', 'week'].includes(range.key)
        ? 'day'
        : 'month'
    const fmt = bucket === 'day' ? '%Y-%m-%d' : '%Y-%m'
    const seriesWhere = range.custom ? `${inRange('created_at')} AND status = 'completed'` : `created_at >= NOW() - INTERVAL 12 MONTH AND status = 'completed'`
    const seriesParams = range.custom ? rangeParams : []

    const [monthlyRevenue] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '${fmt}') AS bucket, COALESCE(SUM(amount), 0) AS total
       FROM payments WHERE ${seriesWhere}
       GROUP BY bucket ORDER BY bucket`,
      seriesParams,
    )

    const [salesSeries] = await pool.query(
      `SELECT DATE_FORMAT(COALESCE(sold_at, created_at), '${fmt}') AS bucket, COUNT(*) AS total
       FROM properties WHERE status = 'sold' ${range.custom ? `AND ${inRange('COALESCE(sold_at, created_at)')}` : 'AND COALESCE(sold_at, created_at) >= NOW() - INTERVAL 12 MONTH'}
       GROUP BY bucket ORDER BY bucket`,
      rangeParams,
    )
    const [rentalsSeries] = await pool.query(
      `SELECT DATE_FORMAT(COALESCE(rented_at, created_at), '${fmt}') AS bucket, COUNT(*) AS total
       FROM properties WHERE status = 'rented' ${range.custom ? `AND ${inRange('COALESCE(rented_at, created_at)')}` : 'AND COALESCE(rented_at, created_at) >= NOW() - INTERVAL 12 MONTH'}
       GROUP BY bucket ORDER BY bucket`,
      rangeParams,
    )
    const [commissionsSeries] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '${fmt}') AS bucket, COALESCE(SUM(amount), 0) AS total
       FROM payments WHERE kind IN ('commission_rent','commission_sale') AND status = 'completed' ${range.custom ? `AND ${inRange('created_at')}` : 'AND created_at >= NOW() - INTERVAL 12 MONTH'}
       GROUP BY bucket ORDER BY bucket`,
      rangeParams,
    )
    const [newUsersSeries] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '${fmt}') AS bucket, COUNT(*) AS total
       FROM users WHERE ${range.custom ? inRange('created_at') : 'created_at >= NOW() - INTERVAL 12 MONTH'}
       GROUP BY bucket ORDER BY bucket`,
      rangeParams,
    )
    const [newListingsSeries] = await pool.query(
      `SELECT DATE_FORMAT(created_at, '${fmt}') AS bucket, COUNT(*) AS total
       FROM properties WHERE ${range.custom ? inRange('created_at') : 'created_at >= NOW() - INTERVAL 12 MONTH'}
       GROUP BY bucket ORDER BY bucket`,
      rangeParams,
    )

    // Revenue splits — always scoped to the selected range.
    const [byLocation] = await pool.query(
      `SELECT COALESCE(NULLIF(p.area, ''), 'Unassigned') AS label, COALESCE(SUM(pm.amount), 0) AS total
       FROM payments pm LEFT JOIN properties p ON p.id = pm.property_id
       WHERE pm.status = 'completed' AND pm.kind != 'payout' AND ${inRange('pm.created_at')}
       GROUP BY label ORDER BY total DESC LIMIT 8`,
      range.custom ? rangeParams : [],
    )
    const [byType] = await pool.query(
      `SELECT kind AS label, COALESCE(SUM(amount), 0) AS total, COUNT(*) AS count
       FROM payments WHERE status = 'completed' AND ${inRange('created_at')}
       GROUP BY kind ORDER BY total DESC`,
      rangeParams,
    )

    // Newest listings needing attention + newest accounts (unchanged).
    const [pendingProperties] = await pool.query(`
      SELECT p.*, u.name AS owner_name, u.email AS owner_email
      FROM properties p JOIN users u ON u.id = p.owner_id
      WHERE p.status = 'pending'
      ORDER BY p.created_at ASC LIMIT 5
    `)
    const [newUsers] = await pool.query(`
      SELECT id, name, email, role, status, provider, created_at
      FROM users ORDER BY created_at DESC LIMIT 5
    `)

    return res.json({
      range: { key: range.key, label: range.label, bucket: bucket || 'day' },
      stats: counters[0],
      charts: {
        monthlyRevenue: monthlyRevenue,
        propertySales: salesSeries,
        rentalTransactions: rentalsSeries,
        commissions: commissionsSeries,
        newUsers: newUsersSeries,
        newListings: newListingsSeries,
        revenueByLocation: byLocation,
        revenueByType: byType,
      },
      pendingProperties: pendingProperties.map((row) => publicAdminProperty(row)),
      newUsers: newUsers.map(publicAdminUser),
    })
  } catch (error) {
    console.error('admin overview failed:', error)
    return res.status(500).json({ error: 'Could not load the overview' })
  }
}

// ---- Drill-down: click a metric, see its underlying rows ----

const DRILLDOWNS = {
  propertiesTotal: 'SELECT p.id, p.title, p.area, p.status, p.purpose, p.rent_amount, p.sale_amount, p.views, p.created_at, u.name AS owner_name FROM properties p JOIN users u ON u.id = p.owner_id ORDER BY p.created_at DESC LIMIT 200',
  propertiesActive: "SELECT p.id, p.title, p.area, p.status, p.purpose, p.rent_amount, p.sale_amount, p.views, p.created_at, u.name AS owner_name FROM properties p JOIN users u ON u.id = p.owner_id WHERE p.status = 'active' ORDER BY p.created_at DESC LIMIT 200",
  propertiesPending: "SELECT p.id, p.title, p.area, p.status, p.purpose, p.rent_amount, p.sale_amount, p.views, p.created_at, u.name AS owner_name FROM properties p JOIN users u ON u.id = p.owner_id WHERE p.status = 'pending' ORDER BY p.created_at ASC LIMIT 200",
  propertiesAvailable: "SELECT p.id, p.title, p.area, p.status, p.purpose, p.rent_amount, p.sale_amount, p.views, p.created_at, u.name AS owner_name FROM properties p JOIN users u ON u.id = p.owner_id WHERE p.status = 'active' AND p.purpose = 'rent' ORDER BY p.created_at DESC LIMIT 200",
  propertiesRented: "SELECT p.id, p.title, p.area, p.status, p.purpose, p.rent_amount, p.sale_amount, p.views, COALESCE(p.rented_at, p.created_at) AS event_at, u.name AS owner_name FROM properties p JOIN users u ON u.id = p.owner_id WHERE p.status = 'rented' ORDER BY COALESCE(p.rented_at, p.created_at) DESC LIMIT 200",
  propertiesSold: "SELECT p.id, p.title, p.area, p.status, p.purpose, p.rent_amount, p.sale_amount, p.views, COALESCE(p.sold_at, p.created_at) AS event_at, u.name AS owner_name FROM properties p JOIN users u ON u.id = p.owner_id WHERE p.status = 'sold' ORDER BY COALESCE(p.sold_at, p.created_at) DESC LIMIT 200",
  rentalsInRange: "SELECT p.id, p.title, p.area, p.status, p.rent_amount AS rent_amount, p.sale_amount, p.views, COALESCE(p.rented_at, p.created_at) AS event_at, u.name AS owner_name FROM properties p JOIN users u ON u.id = p.owner_id WHERE p.status = 'rented' ORDER BY COALESCE(p.rented_at, p.created_at) DESC LIMIT 200",
  salesInRange: "SELECT p.id, p.title, p.area, p.status, p.rent_amount, p.sale_amount, p.views, COALESCE(p.sold_at, p.created_at) AS event_at, u.name AS owner_name FROM properties p JOIN users u ON u.id = p.owner_id WHERE p.status = 'sold' ORDER BY COALESCE(p.sold_at, p.created_at) DESC LIMIT 200",
  usersTotal: 'SELECT id, name, email, role, status, provider, created_at FROM users ORDER BY created_at DESC LIMIT 200',
  landlordsTotal: "SELECT id, name, email, role, status, provider, created_at FROM users WHERE role = 'owner' ORDER BY created_at DESC LIMIT 200",
  tenantsTotal: "SELECT id, name, email, role, status, provider, created_at FROM users WHERE role = 'seeker' ORDER BY created_at DESC LIMIT 200",
  newUsersInRange: 'SELECT id, name, email, role, status, provider, created_at FROM users ORDER BY created_at DESC LIMIT 200',
  revenueInRange: "SELECT pm.id, pm.kind, pm.amount, pm.status, pm.method, pm.reference, pm.created_at, u.name AS user_name, p.title AS property_title FROM payments pm JOIN users u ON u.id = pm.user_id LEFT JOIN properties p ON p.id = pm.property_id WHERE pm.status = 'completed' ORDER BY pm.created_at DESC LIMIT 200",
  revenueTotal: "SELECT pm.id, pm.kind, pm.amount, pm.status, pm.method, pm.reference, pm.created_at, u.name AS user_name, p.title AS property_title FROM payments pm JOIN users u ON u.id = pm.user_id LEFT JOIN properties p ON p.id = pm.property_id WHERE pm.status = 'completed' ORDER BY pm.created_at DESC LIMIT 200",
  pendingPayments: "SELECT pm.id, pm.kind, pm.amount, pm.status, pm.method, pm.reference, pm.created_at, u.name AS user_name, p.title AS property_title FROM payments pm JOIN users u ON u.id = pm.user_id LEFT JOIN properties p ON p.id = pm.property_id WHERE pm.status = 'pending' ORDER BY pm.created_at DESC LIMIT 200",
  pendingCommissions: "SELECT pm.id, pm.kind, pm.amount, pm.status, pm.method, pm.reference, pm.created_at, u.name AS user_name, p.title AS property_title FROM payments pm JOIN users u ON u.id = pm.user_id LEFT JOIN properties p ON p.id = pm.property_id WHERE pm.status = 'pending' AND pm.kind IN ('commission_rent','commission_sale') ORDER BY pm.created_at DESC LIMIT 200",
  platformFees: "SELECT pm.id, pm.kind, pm.amount, pm.status, pm.method, pm.reference, pm.created_at, u.name AS user_name, p.title AS property_title FROM payments pm JOIN users u ON u.id = pm.user_id LEFT JOIN properties p ON p.id = pm.property_id WHERE pm.status = 'completed' AND pm.kind IN ('subscription','listing_fee') ORDER BY pm.created_at DESC LIMIT 200",
  agentCommissionsPaid: "SELECT pm.id, pm.kind, pm.amount, pm.status, pm.method, pm.reference, pm.created_at, u.name AS user_name, p.title AS property_title FROM payments pm JOIN users u ON u.id = pm.user_id LEFT JOIN properties p ON p.id = pm.property_id WHERE pm.status = 'completed' AND pm.kind IN ('commission_rent','commission_sale') ORDER BY pm.created_at DESC LIMIT 200",
  refundsTotal: "SELECT pm.id, pm.kind, pm.amount, pm.status, pm.method, pm.reference, pm.created_at, u.name AS user_name, p.title AS property_title FROM payments pm JOIN users u ON u.id = pm.user_id LEFT JOIN properties p ON p.id = pm.property_id WHERE pm.status = 'refunded' ORDER BY pm.created_at DESC LIMIT 200",
  payoutsTotal: "SELECT pm.id, pm.kind, pm.amount, pm.status, pm.method, pm.reference, pm.created_at, u.name AS user_name, p.title AS property_title FROM payments pm JOIN users u ON u.id = pm.user_id LEFT JOIN properties p ON p.id = pm.property_id WHERE pm.kind = 'payout' ORDER BY pm.created_at DESC LIMIT 200",
  payoutsPending: "SELECT pm.id, pm.kind, pm.amount, pm.status, pm.method, pm.reference, pm.created_at, u.name AS user_name, p.title AS property_title FROM payments pm JOIN users u ON u.id = pm.user_id LEFT JOIN properties p ON p.id = pm.property_id WHERE pm.kind = 'payout' AND pm.status = 'pending' ORDER BY pm.created_at DESC LIMIT 200",
  outstandingRent: "SELECT l.id, l.monthly_rent AS amount, l.next_due_date, l.start_date, p.title AS property_title, u.name AS user_name, u.email AS user_email FROM leases l JOIN properties p ON p.id = l.property_id JOIN users u ON u.id = l.tenant_id WHERE l.status = 'active' AND l.next_due_date < CURDATE() ORDER BY l.next_due_date ASC LIMIT 200",
  upcomingRent: "SELECT l.id, l.monthly_rent AS amount, l.next_due_date, l.start_date, p.title AS property_title, u.name AS user_name, u.email AS user_email FROM leases l JOIN properties p ON p.id = l.property_id JOIN users u ON u.id = l.tenant_id WHERE l.status = 'active' AND l.next_due_date >= CURDATE() AND l.next_due_date <= CURDATE() + INTERVAL 30 DAY ORDER BY l.next_due_date ASC LIMIT 200",
}

export async function drilldown(req, res) {
  const sql = DRILLDOWNS[req.params.key]
  if (!sql) return res.status(404).json({ error: 'Unknown metric' })
  try {
    const [rows] = await pool.query(sql)
    return res.json({ rows })
  } catch (error) {
    console.error('admin drilldown failed:', error)
    return res.status(500).json({ error: 'Could not load the metric details' })
  }
}

// ---- Users: list, suspend/activate, role changes ----

export async function listUsers(req, res) {
  const { role, status, q } = req.query
  try {
    const where = []
    const params = []
    if (['seeker', 'owner', 'admin'].includes(role)) {
      where.push('role = ?')
      params.push(role)
    }
    if (['active', 'suspended'].includes(status)) {
      where.push('status = ?')
      params.push(status)
    }
    if (q) {
      where.push('(name LIKE ? OR email LIKE ?)')
      params.push(`%${q}%`, `%${q}%`)
    }
    const [rows] = await pool.query(
      `SELECT id, name, email, phone, role, status, provider, created_at
       FROM users ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY created_at DESC LIMIT 200`,
      params,
    )
    return res.json({ users: rows.map(publicAdminUser) })
  } catch (error) {
    console.error('admin listUsers failed:', error)
    return res.status(500).json({ error: 'Could not load users' })
  }
}

export async function updateUserStatus(req, res) {
  const { userId } = req.params
  const { status } = req.body
  if (!['active', 'suspended'].includes(status)) {
    return res.status(422).json({ error: 'status must be active or suspended' })
  }
  if (Number(userId) === req.user.id) {
    return res.status(409).json({ error: "You can't change your own status" })
  }
  try {
    const [result] = await pool.query('UPDATE users SET status = ? WHERE id = ?', [
      status,
      userId,
    ])
    if (!result.affectedRows) return res.status(404).json({ error: 'User not found' })
    await audit(req, 'user.status_changed', 'user', userId, null, { status })
    return res.json({ ok: true, status })
  } catch (error) {
    console.error('admin updateUserStatus failed:', error)
    return res.status(500).json({ error: 'Could not update the user' })
  }
}

export async function updateUserRole(req, res) {
  const { userId } = req.params
  const { role } = req.body
  if (!['seeker', 'owner', 'admin'].includes(role)) {
    return res.status(422).json({ error: 'role must be seeker, owner or admin' })
  }
  if (Number(userId) === req.user.id) {
    return res.status(409).json({ error: "You can't change your own role" })
  }
  try {
    const [result] = await pool.query('UPDATE users SET role = ? WHERE id = ?', [
      role,
      userId,
    ])
    if (!result.affectedRows) return res.status(404).json({ error: 'User not found' })
    await audit(req, 'user.role_changed', 'user', userId, null, { role })
    return res.json({ ok: true, role })
  } catch (error) {
    console.error('admin updateUserRole failed:', error)
    return res.status(500).json({ error: 'Could not update the user' })
  }
}

// ---- Properties: moderation queue + status control ----

export async function listAdminProperties(req, res) {
  const { status, purpose, q } = req.query
  try {
    const where = []
    const params = []
    if (['pending', 'active', 'rented', 'sold', 'inactive'].includes(status)) {
      where.push('p.status = ?')
      params.push(status)
    }
    if (['rent', 'sale'].includes(purpose)) {
      where.push('p.purpose = ?')
      params.push(purpose)
    }
    if (q) {
      where.push('(p.title LIKE ? OR p.area LIKE ?)')
      params.push(`%${q}%`, `%${q}%`)
    }
    const [rows] = await pool.query(
      `SELECT p.*, u.name AS owner_name, u.email AS owner_email
       FROM properties p JOIN users u ON u.id = p.owner_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY p.created_at DESC LIMIT 200`,
      params,
    )
    const imageMap = await imagesFor(rows.map((row) => row.id))
    return res.json({
      properties: rows.map((row) =>
        publicAdminProperty(row, imageMap.get(row.id) || []),
      ),
    })
  } catch (error) {
    console.error('admin listProperties failed:', error)
    return res.status(500).json({ error: 'Could not load properties' })
  }
}

const ALLOWED_STATUS = ['pending', 'active', 'rented', 'sold', 'inactive']

export async function updatePropertyStatus(req, res) {
  const { propertyId } = req.params
  const { status } = req.body
  if (!ALLOWED_STATUS.includes(status)) {
    return res.status(422).json({ error: `status must be one of: ${ALLOWED_STATUS.join(', ')}` })
  }
  try {
    const [rows] = await pool.query('SELECT * FROM properties WHERE id = ?', [propertyId])
    const property = rows[0]
    if (!property) return res.status(404).json({ error: 'Property not found' })

    // Stamp the completion timestamp when transitioning to rented/sold.
    const rentedAt = status === 'rented' ? new Date() : property.rented_at
    const soldAt = status === 'sold' ? new Date() : property.sold_at
    await pool.query(
      'UPDATE properties SET status = ?, rented_at = ?, sold_at = ? WHERE id = ?',
      [status, rentedAt, soldAt, propertyId],
    )

    // Revenue engine: recording the completion snapshot (idempotent).
    let transaction = null
    if (status === 'sold' || status === 'rented') {
      const kind = status === 'sold' ? 'sale' : 'rent'
      const gross =
        kind === 'sale'
          ? Number(property.sale_amount || property.rent_amount || 0)
          : Number(property.rent_amount || 0)
      if (gross > 0) {
        const { transactionId, totals, lines } = await recordTransaction(
          Number(propertyId),
          kind,
          gross,
        )
        transaction = { id: transactionId, kind, ...totals, lines }
        await audit(req, `property.marked_${status}`, 'property', propertyId, { status: property.status }, { status, transactionId })
      }
    } else {
      await audit(req, 'property.status_changed', 'property', propertyId, { status: property.status }, { status })
    }

    return res.json({ ok: true, status, transaction })
  } catch (error) {
    console.error('admin updatePropertyStatus failed:', error)
    return res.status(500).json({ error: 'Could not update the property' })
  }
}

export async function deleteProperty(req, res) {
  const { propertyId } = req.params
  try {
    const [result] = await pool.query('DELETE FROM properties WHERE id = ?', [
      propertyId,
    ])
    if (!result.affectedRows) return res.status(404).json({ error: 'Property not found' })
    return res.json({ ok: true })
  } catch (error) {
    console.error('admin deleteProperty failed:', error)
    return res.status(500).json({ error: 'Could not delete the property' })
  }
}

// ---- Payments: ledger + status transitions ----

export async function listPayments(req, res) {
  const { status, kind, method } = req.query
  try {
    const where = []
    const params = []
    if (['pending', 'completed', 'failed', 'refunded'].includes(status)) {
      where.push('pm.status = ?')
      params.push(status)
    }
    if (['commission_rent', 'commission_sale', 'subscription', 'listing_fee'].includes(kind)) {
      where.push('pm.kind = ?')
      params.push(kind)
    }
    if (['card', 'bank_transfer', 'crypto'].includes(method)) {
      where.push('pm.method = ?')
      params.push(method)
    }
    const [rows] = await pool.query(
      `SELECT pm.*, u.name AS user_name, u.email AS user_email, p.title AS property_title
       FROM payments pm
       JOIN users u ON u.id = pm.user_id
       LEFT JOIN properties p ON p.id = pm.property_id
       ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY pm.created_at DESC LIMIT 200`,
      params,
    )
    const payments = rows.map((row) => ({
      id: row.id,
      kind: row.kind,
      amount: Number(row.amount),
      status: row.status,
      method: row.method,
      reference: row.reference,
      propertyTitle: row.property_title,
      user: { id: row.user_id, name: row.user_name, email: row.user_email },
      createdAt: row.created_at,
    }))
    return res.json({ payments })
  } catch (error) {
    console.error('admin listPayments failed:', error)
    return res.status(500).json({ error: 'Could not load payments' })
  }
}

export async function updatePaymentStatus(req, res) {
  const { paymentId } = req.params
  const { status } = req.body
  if (!['pending', 'completed', 'failed', 'refunded'].includes(status)) {
    return res.status(422).json({ error: 'status must be pending, completed, failed or refunded' })
  }
  try {
    const [result] = await pool.query('UPDATE payments SET status = ? WHERE id = ?', [
      status,
      paymentId,
    ])
    if (!result.affectedRows) return res.status(404).json({ error: 'Payment not found' })
    await audit(req, 'payment.status_changed', 'payment', paymentId, null, { status })
    return res.json({ ok: true, status })
  } catch (error) {
    console.error('admin updatePaymentStatus failed:', error)
    return res.status(500).json({ error: 'Could not update the payment' })
  }
}
