// Revenue engine: reads configurable fee rules from revenue_rules (never
// hard-coded), computes who-pays-what for a sale or rental, and records
// transactions with a snapshot of the split. Admin edits rules via
// Admin > Revenue settings.
import pool from '../db/index.js'

const round2 = (value) => Math.round(value * 100) / 100

// Load the enabled rules for a scope ('sale' | 'rent').
export const getRules = async (scope) => {
  const [rows] = await pool.query(
    'SELECT * FROM revenue_rules WHERE scope = ? AND enabled = 1 ORDER BY id',
    [scope],
  )
  return rows
}

// Compute the fee split for a gross amount under a set of rules.
// Returns { lines, totals } where each line says who paid and who receives.
export const quote = (grossAmount, rules) => {
  const lines = []
  for (const rule of rules) {
    const base =
      rule.kind === 'percent' ? round2((grossAmount * Number(rule.value)) / 100) : Number(rule.value)
    if (base <= 0) continue

    const bearerTotals =
      rule.bearer === 'split'
        ? {
            tenant_buyer: round2((base * Number(rule.split_percent)) / 100),
            landlord_seller: 0,
          }
        : rule.bearer === 'tenant_buyer'
          ? { tenant_buyer: base, landlord_seller: 0 }
          : { tenant_buyer: 0, landlord_seller: base }
    if (rule.bearer === 'split') {
      bearerTotals.landlord_seller = round2(base - bearerTotals.tenant_buyer)
    }

    lines.push({
      feeKey: rule.fee_key,
      label: rule.label,
      payee: rule.payee === 'agent' ? 'agent' : rule.payee,
      amount: base,
      paidByBuyer: bearerTotals.tenant_buyer,
      paidBySeller: bearerTotals.landlord_seller,
      optional: !!rule.optional,
    })
  }

  const totalFees = round2(lines.reduce((sum, line) => sum + line.amount, 0))
  const buyerTotal = round2(lines.reduce((sum, line) => sum + line.paidByBuyer, 0))
  const sellerFees = round2(lines.reduce((sum, line) => sum + line.paidBySeller, 0))
  const platformRevenue = round2(
    lines.filter((line) => line.payee === 'platform').reduce((sum, line) => sum + line.amount, 0),
  )
  const agentCommission = round2(
    lines.filter((line) => line.payee === 'agent').reduce((sum, line) => sum + line.amount, 0),
  )
  const processorFees = round2(
    lines.filter((line) => line.payee === 'processor').reduce((sum, line) => sum + line.amount, 0),
  )
  const otherFees = round2(
    lines.filter((line) => line.payee === 'other').reduce((sum, line) => sum + line.amount, 0),
  )

  return {
    lines,
    totals: {
      grossAmount: round2(grossAmount),
      totalFees,
      buyerTotal,
      sellerFees,
      ownerNet: round2(grossAmount - sellerFees),
      platformRevenue,
      agentCommission,
      processorFees,
      otherFees,
    },
  }
}

// Record a completed sale/rental transaction with its fee snapshot.
// Idempotent per (property, kind): re-recording replaces the snapshot.
export const recordTransaction = async (propertyId, kind, grossAmount, agentId = null) => {
  const rules = await getRules(kind)
  const split = quote(grossAmount, rules)

  await pool.query(
    `INSERT INTO transactions
       (property_id, kind, gross_amount, owner_net, buyer_total, platform_revenue, agent_id)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON DUPLICATE KEY UPDATE
       gross_amount = VALUES(gross_amount),
       owner_net = VALUES(owner_net),
       buyer_total = VALUES(buyer_total),
       platform_revenue = VALUES(platform_revenue),
       agent_id = VALUES(agent_id)`,
    [
      propertyId,
      kind,
      split.totals.grossAmount,
      split.totals.ownerNet,
      split.totals.buyerTotal,
      split.totals.platformRevenue,
      agentId,
    ],
  )

  const [txnRows] = await pool.query(
    'SELECT id FROM transactions WHERE property_id = ? AND kind = ?',
    [propertyId, kind],
  )
  const transactionId = txnRows[0].id

  await pool.query('DELETE FROM transaction_lines WHERE transaction_id = ?', [transactionId])
  if (split.lines.length) {
    await pool.query(
      `INSERT INTO transaction_lines
         (transaction_id, fee_key, label, payee, amount, paid_by)
       VALUES ?`,
      [
        split.lines.map((line) => [
          transactionId,
          line.feeKey,
          line.label,
          line.payee,
          line.amount,
          line.paidByBuyer >= line.paidBySeller ? 'tenant_buyer' : 'landlord_seller',
        ]),
      ],
    )
  }
  return { transactionId, ...split }
}
