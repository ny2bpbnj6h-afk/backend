// Financial settlement engine — the auditable money pipeline.
//
// IMPORTANT FINANCIAL RULE: money moves only after provider verification
// (webhook or server-side check). This module then, in order:
//   1. writes the verified transaction + fee lines (services/revenue.js)
//   2. computes the tiered agent commission (commission_tiers — never
//      hard-coded)
//   3. writes balanced, idempotent ledger entries (debit = source of funds,
//      credit = recipient) keyed by txn_ref + entry_type + account
//   4. generates the invoice/receipt (unique HA-YYYY-NNNNN number)
//   5. records in-app notifications for the relevant parties
//   6. returns the settlement so callers can update property/lease status
// and make funds payout-eligible.
import 'dotenv/config'
import pool from '../db/index.js'
import { getRules, quote, recordTransaction } from './revenue.js'

const round2 = (value) => Math.round(value * 100) / 100

// ------------------------------------------------------------ settings ----
export const getSetting = async (key, fallback = null) => {
  const [rows] = await pool.query('SELECT setting_value FROM platform_settings WHERE setting_key = ?', [key])
  return rows.length ? rows[0].setting_value : fallback
}

export const getSettings = async (keys) => {
  const [rows] = await pool.query('SELECT setting_key, setting_value FROM platform_settings WHERE setting_key IN (?)', [keys])
  const map = {}
  for (const row of rows) map[row.setting_key] = row.setting_value
  return map
}

// ------------------------------------------------- tiered commissions ----
// commission_tiers rows: value_min inclusive, value_max exclusive (NULL =
// no upper bound). Falls back to the flat agent rule when no tier matches.
export const agentCommissionPct = async (scope, grossAmount) => {
  const [tiers] = await pool.query(
    `SELECT percent FROM commission_tiers
     WHERE scope = ? AND enabled = 1 AND value_min <= ?
       AND (value_max IS NULL OR value_max > ?)
     ORDER BY value_min DESC LIMIT 1`,
    [scope, grossAmount, grossAmount],
  )
  if (tiers.length) return Number(tiers[0].percent)
  const rules = await getRules(scope)
  const agentRule = rules.find((rule) => rule.payee === 'agent')
  return agentRule ? Number(agentRule.value) : 0
}

// ------------------------------------------------------ ledger entries ----
// Idempotent by (txn_ref, entry_type, account): replays (webhook retries)
// hit the unique key and are ignored via ON DUPLICATE KEY UPDATE no-op.
const writeEntries = async (entries) => {
  if (!entries.length) return
  await pool.query(
    `INSERT INTO ledger_entries
       (txn_ref, entry_type, account, user_id, property_id, amount, description, reference)
     VALUES ?
     ON DUPLICATE KEY UPDATE amount = VALUES(amount)`,
    [
      entries.map((entry) => [
        entry.txnRef,
        entry.entryType,
        entry.account,
        entry.userId ?? null,
        entry.propertyId ?? null,
        entry.amount,
        entry.description || '',
        entry.reference || '',
      ]),
    ],
  )
}

// ---------------------------------------------------------- invoices -----
const nextInvoiceNo = async () => {
  const year = new Date().getFullYear()
  const [rows] = await pool.query(
    `SELECT invoice_no FROM invoices WHERE invoice_no LIKE ? ORDER BY id DESC LIMIT 1`,
    [`HA-${year}-%`],
  )
  const lastSeq = rows.length ? Number(rows[0].invoice_no.split('-')[2] || 0) : 0
  return `HA-${year}-${String(lastSeq + 1).padStart(5, '0')}`
}

export const createInvoice = async ({ userId, propertyId, txnRef, kind, subtotal, fees, total, lines }) => {
  const invoiceNo = await nextInvoiceNo()
  await pool.query(
    `INSERT INTO invoices (invoice_no, user_id, property_id, txn_ref, kind, subtotal, fees_total, total, status, line_items)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'paid', ?)`,
    [
      invoiceNo,
      userId,
      propertyId ?? null,
      txnRef,
      kind,
      round2(subtotal),
      round2(fees),
      round2(total),
      JSON.stringify(lines || []),
    ],
  )
  const [rows] = await pool.query('SELECT * FROM invoices WHERE invoice_no = ?', [invoiceNo])
  return rows[0]
}

// ------------------------------------------------------ notifications ----
export const notify = async (userId, type, title, body, entityType = '', entityId = null) => {
  if (!userId) return
  await pool.query(
    `INSERT INTO notifications (user_id, type, title, body, entity_type, entity_id)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [userId, type, title, body, entityType, entityId],
  )
}

// ================================================================ sale ====
// Settle a verified property purchase. The buyer has paid gross (price +
// buyer-borne fees); the platform splits everything per the configured
// rules and writes the full audit trail.
export const settleSale = async ({ propertyId, buyerId, price, reference, agentId = null }) => {
  const [props] = await pool.query('SELECT * FROM properties WHERE id = ?', [propertyId])
  const property = props[0]
  if (!property) throw new Error('Property not found')

  const rules = await getRules('sale')
  const split = quote(price, rules)

  // Tiered agent commission replaces the flat rule line when tiers exist.
  const tierPct = await agentCommissionPct('sale', price)
  const agentLine = split.lines.find((line) => line.payee === 'agent')
  if (agentLine && tierPct > 0) {
    agentLine.amount = round2((price * tierPct) / 100)
    agentLine.label = `Agent commission (tiered ${tierPct}%)`
  }
  const agentCommission = round2(agentLine?.amount || 0)
  const processorFees = round2(
    split.lines.filter((line) => line.payee === 'processor').reduce((sum, line) => sum + line.amount, 0),
  )
  const platformFees = round2(
    split.lines
      .filter((line) => line.payee === 'platform' && line.feeKey !== 'sale_platform_commission')
      .reduce((sum, line) => sum + line.amount, 0),
  )
  const platformCommission = round2(
    split.lines
      .filter((line) => line.payee === 'platform' && line.feeKey === 'sale_platform_commission')
      .reduce((sum, line) => sum + line.amount, 0),
  )
  const ownerPayout = round2(price - agentCommission - platformCommission - platformFees - processorFees)

  // 1. transaction + snapshot lines (idempotent per property+sale).
  const { transactionId } = await recordTransaction(propertyId, 'sale', price, agentId)

  // 2. balanced ledger entries. Debits = where the money came from (buyer);
  //    credits = where every naira went. Keyed idempotent on txn_ref.
  const txnRef = `SALE-${transactionId}-${reference || Date.now()}`
  const entries = [
    {
      txnRef, entryType: 'debit', account: 'tenant_buyer', userId: buyerId, propertyId,
      amount: round2(price), description: `Property purchase — ${property.title}`, reference,
    },
    {
      txnRef, entryType: 'credit', account: 'landlord_seller', userId: property.owner_id, propertyId,
      amount: ownerPayout, description: `Owner payout (net of fees) — ${property.title}`, reference,
    },
    {
      txnRef, entryType: 'credit', account: 'platform', propertyId,
      amount: round2(platformCommission + platformFees), description: `Platform revenue — ${property.title}`, reference,
    },
  ]
  if (agentCommission > 0) {
    entries.push({
      txnRef, entryType: 'credit', account: 'agent', userId: agentId, propertyId,
      amount: agentCommission, description: `Agent commission — ${property.title}`, reference,
    })
  }
  if (processorFees > 0) {
    entries.push({
      txnRef, entryType: 'credit', account: 'processor', propertyId,
      amount: processorFees, description: `Payment processing — ${property.title}`, reference,
    })
  }
  await writeEntries(entries)

  // 3. invoice for the buyer.
  const invoice = await createInvoice({
    userId: buyerId,
    propertyId,
    txnRef,
    kind: 'property_purchase',
    subtotal: price,
    fees: round2(platformCommission + platformFees + processorFees + agentCommission),
    total: price,
    lines: split.lines.map((line) => ({ label: line.label, amount: line.amount, payee: line.payee })),
  })

  // 4. notifications.
  await notify(property.owner_id, 'property_sold', 'Property sold', `Your property "${property.title}" has been sold. Payout ₦${ownerPayout.toLocaleString()} is pending release.`, 'property', propertyId)
  if (buyerId) await notify(buyerId, 'payment_successful', 'Payment successful', `Your purchase of "${property.title}" is confirmed. Invoice ${invoice.invoice_no} is available.`, 'property', propertyId)
  if (agentId) await notify(agentId, 'commission_earned', 'Commission earned', `You earned ₦${agentCommission.toLocaleString()} commission on "${property.title}".`, 'property', propertyId)

  return {
    transactionId,
    txnRef,
    invoiceNo: invoice.invoice_no,
    price: round2(price),
    platformRevenue: round2(platformCommission + platformFees),
    platformCommission,
    platformFees,
    agentCommission,
    processorFees,
    ownerPayout,
    lines: split.lines,
  }
}

// ================================================================ rent ====
// Settle a verified rent payment against a lease's rent_payment row:
// updates the payment record, computes platform fee + agent commission on
// the rent (monthly-flagged rules only), writes ledger entries, issues the
// rent receipt, advances next_due_date, and applies late fees when overdue.
export const settleRentPayment = async ({ rentPaymentId, reference }) => {
  const [rows] = await pool.query(
    `SELECT rp.*, l.property_id, l.tenant_id, l.monthly_rent, l.start_date, l.end_date, l.next_due_date,
            p.owner_id, p.title, p.agent_id
     FROM rent_payments rp
     JOIN leases l ON l.id = rp.lease_id
     JOIN properties p ON p.id = l.property_id
     WHERE rp.id = ?`,
    [rentPaymentId],
  )
  const rp = rows[0]
  if (!rp) throw new Error('Rent payment not found')

  const rules = (await getRules('rent')).filter((rule) => rule.monthly === 1)
  const rent = Number(rp.amount_due)
  const split = quote(rent, rules)

  const tierPct = await agentCommissionPct('rent', rent)
  const agentLine = split.lines.find((line) => line.payee === 'agent')
  if (agentLine && tierPct > 0) {
    agentLine.amount = round2((rent * tierPct) / 100)
    agentLine.label = `Agent commission (tiered ${tierPct}%)`
  }
  const agentCommission = round2(agentLine?.amount || 0)
  const processorFees = round2(
    split.lines.filter((line) => line.payee === 'processor').reduce((sum, line) => sum + line.amount, 0),
  )
  const platformFees = round2(
    split.lines.filter((line) => line.payee === 'platform').reduce((sum, line) => sum + line.amount, 0),
  )
  const landlordAmount = round2(rent - agentCommission - processorFees)

  // Late fee (settings-driven) when the due date passed the grace window.
  const graceDays = Number(await getSetting('rent_grace_days', '3'))
  const lateFeeKind = await getSetting('late_fee_kind', 'fixed')
  const lateFeeValue = Number(await getSetting('late_fee_value', '0'))
  const overdueDays = Math.floor((Date.now() - new Date(rp.due_date).getTime()) / 86_400_000) - graceDays
  const lateFee = overdueDays > 0 && rp.late_fee === 0
    ? round2(lateFeeKind === 'percent' ? (rent * lateFeeValue) / 100 : lateFeeValue)
    : 0

  // 1. update the rent_payment row (paid + stamped) idempotently.
  const [update] = await pool.query(
    `UPDATE rent_payments
     SET amount_paid = ?, status = 'paid', paid_at = COALESCE(paid_at, NOW()), late_fee = ?, reference = ?
     WHERE id = ? AND status != 'paid'`,
    [rent, lateFee, reference || `RENT-${rp.id}`, rp.id],
  )
  if (!update.affectedRows) {
    // Already settled — return the existing state (webhook replay safety).
    const [existing] = await pool.query('SELECT * FROM rent_payments WHERE id = ?', [rp.id])
    return { alreadySettled: true, rentPayment: existing[0] }
  }

  // 2. ledger entries.
  const txnRef = `RENT-${rp.id}-${reference || Date.now()}`
  const entries = [
    {
      txnRef, entryType: 'debit', account: 'tenant_buyer', userId: rp.tenant_id, propertyId: rp.property_id,
      amount: round2(rent + lateFee), description: `Rent payment — ${rp.title} (${rp.due_date})`, reference: reference || '',
    },
    {
      txnRef, entryType: 'credit', account: 'landlord_seller', userId: rp.owner_id, propertyId: rp.property_id,
      amount: landlordAmount, description: `Rent payout (net of fees) — ${rp.title}`, reference: reference || '',
    },
    {
      txnRef, entryType: 'credit', account: 'platform', propertyId: rp.property_id,
      amount: platformFees, description: `Platform rental fees — ${rp.title}`, reference: reference || '',
    },
  ]
  if (agentCommission > 0) {
    entries.push({
      txnRef, entryType: 'credit', account: 'agent', userId: rp.agent_id ?? null, propertyId: rp.property_id,
      amount: agentCommission, description: `Agent commission — ${rp.title}`, reference: reference || '',
    })
  }
  if (processorFees > 0) {
    entries.push({
      txnRef, entryType: 'credit', account: 'processor', propertyId: rp.property_id,
      amount: processorFees, description: `Payment processing — ${rp.title}`, reference: reference || '',
    })
  }
  if (lateFee > 0) {
    entries.push({
      txnRef, entryType: 'credit', account: 'platform', propertyId: rp.property_id,
      amount: lateFee, description: `Late payment fee — ${rp.title}`, reference: reference || '',
    })
  }
  await writeEntries(entries)

  // 3. rent receipt.
  const invoice = await createInvoice({
    userId: rp.tenant_id,
    propertyId: rp.property_id,
    txnRef,
    kind: 'rent_payment',
    subtotal: rent,
    fees: round2(platformFees + processorFees + agentCommission),
    total: round2(rent + lateFee),
    lines: [
      ...split.lines.map((line) => ({ label: line.label, amount: line.amount, payee: line.payee })),
      ...(lateFee > 0 ? [{ label: `Late fee (${overdueDays} days overdue)`, amount: lateFee, payee: 'platform' }] : []),
    ],
  })

  // 4. advance the lease to the next period.
  const nextDue = new Date(rp.next_due_date)
  nextDue.setMonth(nextDue.getMonth() + 1)
  await pool.query('UPDATE leases SET next_due_date = ? WHERE id = ?', [nextDue.toISOString().slice(0, 10), rp.lease_id])

  // 5. notifications.
  await notify(rp.owner_id, 'rent_received', 'Rent received', `Rent of ₦${rent.toLocaleString()} received for "${rp.title}". Net to you: ₦${landlordAmount.toLocaleString()}.`, 'lease', rp.lease_id)
  await notify(rp.tenant_id, 'payment_successful', 'Rent payment successful', `Your rent payment for "${rp.title}" was successful. Receipt ${invoice.invoice_no}.`, 'lease', rp.lease_id)
  if (rp.agent_id) await notify(rp.agent_id, 'commission_earned', 'Commission earned', `₦${agentCommission.toLocaleString()} commission earned on "${rp.title}" rent.`, 'lease', rp.lease_id)

  return {
    alreadySettled: false,
    rentPaymentId: rp.id,
    txnRef,
    invoiceNo: invoice.invoice_no,
    rent: round2(rent),
    lateFee,
    platformFees,
    agentCommission,
    processorFees,
    landlordAmount,
    nextDueDate: nextDue.toISOString().slice(0, 10),
  }
}
