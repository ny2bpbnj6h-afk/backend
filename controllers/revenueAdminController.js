// Admin > Revenue & Commission Settings + the transparent transaction
// ledger ("how much belongs to owner / agent / platform / processor").
import pool from '../db/index.js'
import { getRules, quote, recordTransaction } from '../services/revenue.js'

export async function getRevenueSettings(req, res) {
  try {
    const [rules] = await pool.query('SELECT * FROM revenue_rules ORDER BY scope, id')
    return res.json({ rules })
  } catch (error) {
    console.error('getRevenueSettings failed:', error)
    return res.status(500).json({ error: 'Could not load revenue settings' })
  }
}

export async function updateRevenueRule(req, res) {
  const { ruleId } = req.params
  const { label, kind, value, bearer, splitPercent, payee, enabled } = req.body

  if (kind && !['percent', 'fixed'].includes(kind)) {
    return res.status(422).json({ error: 'kind must be percent or fixed' })
  }
  if (bearer && !['tenant_buyer', 'landlord_seller', 'split'].includes(bearer)) {
    return res.status(422).json({ error: 'bearer must be tenant_buyer, landlord_seller or split' })
  }
  if (payee && !['platform', 'agent', 'processor', 'other'].includes(payee)) {
    return res.status(422).json({ error: 'payee must be platform, agent, processor or other' })
  }
  if (value !== undefined && (Number.isNaN(Number(value)) || Number(value) < 0)) {
    return res.status(422).json({ error: 'value must be a non-negative number' })
  }
  // Enforce the percent cap against the rule's effective kind: either the
  // kind sent in this request, or the kind currently stored on the rule.
  if (value !== undefined) {
    let effectiveKind = kind
    if (!effectiveKind) {
      const [current] = await pool.query('SELECT kind FROM revenue_rules WHERE id = ?', [ruleId])
      effectiveKind = current[0]?.kind
    }
    if (effectiveKind === 'percent' && Number(value) > 100) {
      return res.status(422).json({ error: 'percent value cannot exceed 100' })
    }
  }
  if (splitPercent !== undefined && (Number(splitPercent) < 0 || Number(splitPercent) > 100)) {
    return res.status(422).json({ error: 'splitPercent must be between 0 and 100' })
  }

  try {
    const [result] = await pool.query(
      `UPDATE revenue_rules SET
         label = COALESCE(?, label),
         kind = COALESCE(?, kind),
         value = COALESCE(?, value),
         bearer = COALESCE(?, bearer),
         split_percent = COALESCE(?, split_percent),
         payee = COALESCE(?, payee),
         enabled = COALESCE(?, enabled)
       WHERE id = ?`,
      [
        label ?? null,
        kind ?? null,
        value ?? null,
        bearer ?? null,
        splitPercent ?? null,
        payee ?? null,
        enabled === undefined ? null : enabled ? 1 : 0,
        ruleId,
      ],
    )
    if (!result.affectedRows) return res.status(404).json({ error: 'Rule not found' })
    const [rows] = await pool.query('SELECT * FROM revenue_rules WHERE id = ?', [ruleId])
    return res.json({ rule: rows[0] })
  } catch (error) {
    console.error('updateRevenueRule failed:', error)
    return res.status(500).json({ error: 'Could not update the rule' })
  }
}

// Simulate a split for a given amount without recording anything — the
// admin's "what would the fees be on a ₦100M sale?" preview.
export async function previewQuote(req, res) {
  const { scope, amount } = req.body
  if (!['sale', 'rent'].includes(scope)) {
    return res.status(422).json({ error: 'scope must be sale or rent' })
  }
  const gross = Number(amount)
  if (!Number.isFinite(gross) || gross <= 0) {
    return res.status(422).json({ error: 'amount must be a positive number' })
  }
  try {
    const rules = await getRules(scope)
    return res.json({ quote: quote(gross, rules) })
  } catch (error) {
    console.error('previewQuote failed:', error)
    return res.status(500).json({ error: 'Could not compute the quote' })
  }
}

// The ledger: every recorded sale/rental with its money split. Admin sees
// exactly how much belongs to owner / agent / platform / processor / other.
export async function listRevenueTransactions(req, res) {
  const { kind } = req.query
  try {
    const where = kind === 'sale' || kind === 'rent' ? 'WHERE t.kind = ?' : ''
    const params = kind === 'sale' || kind === 'rent' ? [kind] : []
    const [rows] = await pool.query(
      `SELECT t.*, p.title AS property_title, p.area AS property_area,
              u.name AS owner_name, u.email AS owner_email
       FROM transactions t
       JOIN properties p ON p.id = t.property_id
       JOIN users u ON u.id = p.owner_id
       ${where}
       ORDER BY t.created_at DESC LIMIT 200`,
      params,
    )

    // Lines for the listed transactions + payee totals.
    const ids = rows.map((row) => row.id)
    let linesByTxn = new Map()
    if (ids.length) {
      const [lineRows] = await pool.query(
        `SELECT transaction_id, fee_key, label, payee, amount, paid_by
         FROM transaction_lines WHERE transaction_id IN (?) ORDER BY id`,
        [ids],
      )
      for (const line of lineRows) {
        if (!linesByTxn.has(line.transaction_id)) linesByTxn.set(line.transaction_id, [])
        linesByTxn.get(line.transaction_id).push(line)
      }
    }

    // Platform-wide payee totals (all recorded transactions).
    const [payeeTotals] = await pool.query(
      `SELECT payee, COALESCE(SUM(amount), 0) AS total
       FROM transaction_lines GROUP BY payee`,
    )

    const transactions = rows.map((row) => {
      const lines = linesByTxn.get(row.id) || []
      const otherFees = lines
        .filter((line) => line.payee === 'other')
        .reduce((sum, line) => sum + Number(line.amount), 0)
      const processorFees = lines
        .filter((line) => line.payee === 'processor')
        .reduce((sum, line) => sum + Number(line.amount), 0)
      const agentCommission = lines
        .filter((line) => line.payee === 'agent')
        .reduce((sum, line) => sum + Number(line.amount), 0)
      return {
        id: row.id,
        kind: row.kind,
        property: { id: row.property_id, title: row.property_title, area: row.property_area },
        owner: { name: row.owner_name, email: row.owner_email },
        grossAmount: Number(row.gross_amount),
        ownerNet: Number(row.owner_net),
        buyerTotal: Number(row.buyer_total),
        platformRevenue: Number(row.platform_revenue),
        agentCommission,
        processorFees,
        otherFees,
        lines: lines.map((line) => ({
          feeKey: line.fee_key,
          label: line.label,
          payee: line.payee,
          amount: Number(line.amount),
          paidBy: line.paid_by,
        })),
        createdAt: row.created_at,
      }
    })

    return res.json({
      transactions,
      payeeTotals: payeeTotals.map((row) => ({
        payee: row.payee,
        total: Number(row.total),
      })),
    })
  } catch (error) {
    console.error('listRevenueTransactions failed:', error)
    return res.status(500).json({ error: 'Could not load transactions' })
  }
}

// Manually record/refresh a transaction snapshot (e.g. after offline
// completion). Also called automatically when a property is marked sold/rented.
export async function createRevenueTransaction(req, res) {
  const { propertyId, kind, amount } = req.body
  if (!['sale', 'rent'].includes(kind)) {
    return res.status(422).json({ error: 'kind must be sale or rent' })
  }
  const gross = Number(amount)
  if (!Number.isFinite(gross) || gross <= 0) {
    return res.status(422).json({ error: 'amount must be a positive number' })
  }
  try {
    const [props] = await pool.query('SELECT id FROM properties WHERE id = ?', [propertyId])
    if (!props.length) return res.status(404).json({ error: 'Property not found' })
    const result = await recordTransaction(propertyId, kind, gross)
    return res.status(201).json(result)
  } catch (error) {
    console.error('createRevenueTransaction failed:', error)
    return res.status(500).json({ error: 'Could not record the transaction' })
  }
}
