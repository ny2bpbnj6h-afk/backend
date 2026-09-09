// Finance platform controllers: rent collection (leases + rent payments),
// payouts workflow, ledger views, invoices, disputes, notifications, and
// platform settings (all admin-gated; every mutation writes an audit row).
import pool from '../db/index.js'
import { audit } from '../services/audit.js'
import { getSettings, getSetting, notify } from '../services/ledger.js'
import { getProvider, newReference, recordPendingPayment } from '../services/payments.js'
import { agentCommissionPct } from '../services/ledger.js'
import { getRules } from '../services/revenue.js'

// ========================================================== RENT COLLECT ==
// Admin creates a lease; the platform generates the first rent charge.
export async function createLease(req, res) {
  const { propertyId, tenantId, monthlyRent, startDate, endDate, deposit, autoPay } = req.body
  try {
    const [props] = await pool.query('SELECT * FROM properties WHERE id = ?', [propertyId])
    const property = props[0]
    if (!property) return res.status(404).json({ error: 'Property not found' })
    if (property.status !== 'active') {
      return res.status(409).json({ error: 'Property must be active to create a lease' })
    }
    const [tenants] = await pool.query("SELECT id FROM users WHERE id = ? AND status = 'active'", [tenantId])
    if (!tenants.length) return res.status(404).json({ error: 'Tenant not found' })

    const [result] = await pool.query(
      `INSERT INTO leases (property_id, tenant_id, monthly_rent, start_date, end_date, next_due_date, deposit, auto_pay)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [propertyId, tenantId, monthlyRent, startDate, endDate || null, startDate, deposit || 0, autoPay ? 1 : 0],
    )
    const leaseId = result.insertId

    // Generate the first rent charge (due on lease start).
    await pool.query(
      `INSERT INTO rent_payments (lease_id, tenant_id, amount_due, due_date, reference)
       VALUES (?, ?, ?, ?, ?)`,
      [leaseId, tenantId, monthlyRent, startDate, newReference('RP')],
    )

    await audit(req, 'lease.created', 'lease', leaseId, null, { propertyId, tenantId, monthlyRent, startDate })
    await notify(tenantId, 'lease_created', 'Lease created', `Your lease for "${property.title}" started on ${startDate}. First rent of ₦${Number(monthlyRent).toLocaleString()} is due.`, 'lease', leaseId)
    await notify(property.owner_id, 'lease_created', 'Lease created', `A lease for "${property.title}" started on ${startDate}.`, 'lease', leaseId)

    const [leases] = await pool.query('SELECT * FROM leases WHERE id = ?', [leaseId])
    return res.status(201).json({ lease: leases[0] })
  } catch (error) {
    console.error('createLease failed:', error)
    return res.status(500).json({ error: 'Could not create the lease' })
  }
}

export async function listLeases(req, res) {
  const { status } = req.query
  try {
    const where = status === 'active' || status === 'ended' ? 'WHERE l.status = ?' : ''
    const params = status ? [status] : []
    const [leases] = await pool.query(
      `SELECT l.*, p.title AS property_title, p.area AS property_area, p.owner_id,
              owner.name AS landlord_name, tenant.name AS tenant_name, tenant.email AS tenant_email
       FROM leases l
       JOIN properties p ON p.id = l.property_id
       JOIN users owner ON owner.id = p.owner_id
       JOIN users tenant ON tenant.id = l.tenant_id
       ${where}
       ORDER BY l.next_due_date ASC LIMIT 200`,
      params,
    )
    // Attach per-lease aggregates: outstanding + overdue count + next charge.
    const [aggregates] = await pool.query(
      `SELECT lease_id,
              COALESCE(SUM(CASE WHEN status IN ('pending','partial','overdue') THEN amount_due - amount_paid ELSE 0 END), 0) AS outstanding,
              SUM(CASE WHEN status = 'overdue' THEN 1 ELSE 0 END) AS overdue_count,
              SUM(CASE WHEN status = 'paid' THEN amount_paid ELSE 0 END) AS total_paid
       FROM rent_payments GROUP BY lease_id`,
    )
    const byLease = new Map(aggregates.map((row) => [row.lease_id, row]))
    return res.json({
      leases: leases.map((lease) => ({
        ...lease,
        outstanding: Number(byLease.get(lease.id)?.outstanding || 0),
        overdueCount: Number(byLease.get(lease.id)?.overdue_count || 0),
        totalPaid: Number(byLease.get(lease.id)?.total_paid || 0),
      })),
    })
  } catch (error) {
    console.error('listLeases failed:', error)
    return res.status(500).json({ error: 'Could not load leases' })
  }
}

export async function listRentPayments(req, res) {
  const { status } = req.query
  try {
    const valid = ['pending', 'paid', 'partial', 'overdue', 'failed', 'refunded']
    const where = valid.includes(status) ? 'WHERE rp.status = ?' : ''
    const params = valid.includes(status) ? [status] : []
    const [rows] = await pool.query(
      `SELECT rp.*, l.property_id, p.title AS property_title, p.owner_id,
              tenant.name AS tenant_name, owner.name AS landlord_name
       FROM rent_payments rp
       JOIN leases l ON l.id = rp.lease_id
       JOIN properties p ON p.id = l.property_id
       JOIN users tenant ON tenant.id = rp.tenant_id
       JOIN users owner ON owner.id = p.owner_id
       ${where}
       ORDER BY rp.due_date ASC LIMIT 300`,
      params,
    )
    return res.json({ rentPayments: rows })
  } catch (error) {
    console.error('listRentPayments failed:', error)
    return res.status(500).json({ error: 'Could not load rent payments' })
  }
}

// Generate the next month's rent charge for an active lease (called when a
// payment succeeds or by the reminder sweep — never duplicates because the
// previous period must be settled first).
export async function generateNextRent(req, res) {
  const { leaseId } = req.params
  try {
    const [leases] = await pool.query('SELECT * FROM leases WHERE id = ? AND status = ?', [leaseId, 'active'])
    const lease = leases[0]
    if (!lease) return res.status(404).json({ error: 'Active lease not found' })
    if (lease.end_date && lease.next_due_date > lease.end_date) {
      return res.status(409).json({ error: 'Lease period has ended' })
    }
    const [existing] = await pool.query(
      "SELECT id FROM rent_payments WHERE lease_id = ? AND due_date = ? AND status != 'paid'",
      [leaseId, lease.next_due_date],
    )
    if (existing.length) return res.status(409).json({ error: 'An open charge already exists for this period' })

    const reference = newReference('RP')
    await pool.query(
      `INSERT INTO rent_payments (lease_id, tenant_id, amount_due, due_date, reference) VALUES (?, ?, ?, ?, ?)`,
      [leaseId, lease.tenant_id, lease.monthly_rent, lease.next_due_date, reference],
    )
    await audit(req, 'rent_charge.generated', 'lease', leaseId, null, { dueDate: lease.next_due_date, amount: lease.monthly_rent })
    return res.status(201).json({ ok: true, dueDate: lease.next_due_date, reference })
  } catch (error) {
    console.error('generateNextRent failed:', error)
    return res.status(500).json({ error: 'Could not generate the rent charge' })
  }
}

// Overdue sweep: pending charges past due + grace become 'overdue' and pick
// up the configured late fee. Also emits rent-due/overdue notifications.
export async function runRentSweep(req, res) {
  try {
    const settings = await getSettings(['rent_reminder_days', 'rent_grace_days', 'late_fee_kind', 'late_fee_value'])
    const graceDays = Number(settings.rent_grace_days || 3)
    const reminderDays = Number(settings.rent_reminder_days || 3)
    const lateFeeKind = settings.late_fee_kind || 'fixed'
    const lateFeeValue = Number(settings.late_fee_value || 0)

    const [candidates] = await pool.query(
      `SELECT rp.*, p.title, p.owner_id
       FROM rent_payments rp
       JOIN leases l ON l.id = rp.lease_id
       JOIN properties p ON p.id = l.property_id
       WHERE rp.status IN ('pending', 'partial')`,
    )
    let markedOverdue = 0
    let lateFeesApplied = 0
    let remindersSent = 0
    for (const rp of candidates) {
      const dueTime = new Date(rp.due_date).getTime()
      const daysPast = Math.floor((Date.now() - dueTime) / 86_400_000)
      if (daysPast > graceDays) {
        const lateFee = rp.late_fee === 0 && lateFeeValue > 0
          ? (lateFeeKind === 'percent' ? Math.round(((Number(rp.amount_due) * lateFeeValue) / 100) * 100) / 100 : lateFeeValue)
          : 0
        await pool.query("UPDATE rent_payments SET status = 'overdue', late_fee = late_fee + ? WHERE id = ?", [lateFee, rp.id])
        markedOverdue++
        if (lateFee > 0) lateFeesApplied++
        await notify(rp.tenant_id, 'rent_overdue', 'Rent overdue', `Your rent for "${rp.title}" (due ${rp.due_date}) is now overdue. A late fee of ₦${Number(lateFee).toLocaleString()} applies.`, 'rent_payment', rp.id)
        await notify(rp.owner_id, 'rent_overdue', 'Rent overdue', `Rent for "${rp.title}" is overdue (${daysPast - graceDays} days past grace).`, 'rent_payment', rp.id)
      } else if (daysPast >= -reminderDays) {
        await notify(rp.tenant_id, 'rent_due', 'Rent due soon', `Your rent for "${rp.title}" of ₦${Number(rp.amount_due).toLocaleString()} is due on ${rp.due_date}.`, 'rent_payment', rp.id)
        remindersSent++
      }
    }
    await audit(req, 'rent_sweep.ran', 'rent_payments', null, null, { markedOverdue, lateFeesApplied, remindersSent })
    return res.json({ ok: true, markedOverdue, lateFeesApplied, remindersSent })
  } catch (error) {
    console.error('runRentSweep failed:', error)
    return res.status(500).json({ error: 'Could not run the rent sweep' })
  }
}

// Tenant (or admin) initiates a rent payment through the active provider —
// creates the pending payment; the webhook settles it. No frontend trust.
export async function payRent(req, res) {
  const { rentPaymentId } = req.params
  try {
    const [rows] = await pool.query(
      `SELECT rp.*, l.tenant_id, p.title FROM rent_payments rp
       JOIN leases l ON l.id = rp.lease_id
       JOIN properties p ON p.id = l.property_id
       WHERE rp.id = ? AND rp.status IN ('pending', 'partial', 'overdue')`,
      [rentPaymentId],
    )
    const rp = rows[0]
    if (!rp) return res.status(404).json({ error: 'Open rent charge not found' })
    if (req.user.role !== 'admin' && req.user.id !== rp.tenant_id) {
      return res.status(403).json({ error: 'Only the tenant or an admin can pay this charge' })
    }

    const reference = newReference('RENT')
    await recordPendingPayment({
      userId: rp.tenant_id,
      propertyId: null,
      kind: 'commission_rent',
      amount: Number(rp.amount_due) + Number(rp.late_fee),
      reference,
      provider: getProvider().name,
      purpose: `rent_payment:${rp.id}`,
      meta: { rentPaymentId: rp.id, leaseId: rp.lease_id },
    })

    const [tenants] = await pool.query('SELECT email FROM users WHERE id = ?', [rp.tenant_id])
    const provider = getProvider()
    const result = await provider.initiate({
      amount: Number(rp.amount_due) + Number(rp.late_fee),
      reference,
      email: tenants[0]?.email || '',
      meta: { rentPaymentId: rp.id },
    })
    await audit(req, 'rent_payment.initiated', 'rent_payment', rp.id, null, { reference, amount: rp.amount_due })
    return res.status(201).json({ ...result, amount: Number(rp.amount_due) + Number(rp.late_fee) })
  } catch (error) {
    console.error('payRent failed:', error)
    return res.status(500).json({ error: 'Could not initiate the rent payment' })
  }
}

// =============================================================== PAYOUTS ==
export async function requestPayout(req, res) {
  const { amount, bankName, accountNumber, accountName } = req.body
  try {
    // Available balance = settled credits − previous payouts (pending or paid).
    const [credits] = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM ledger_entries
       WHERE entry_type = 'credit' AND account IN ('landlord_seller', 'agent') AND user_id = ?`,
      [req.user.id],
    )
    const [withdrawn] = await pool.query(
      `SELECT COALESCE(SUM(amount), 0) AS total FROM payouts
       WHERE user_id = ? AND status IN ('pending', 'under_review', 'approved', 'processing', 'paid')`,
      [req.user.id],
    )
    const available = Number(credits[0].total) - Number(withdrawn[0].total)
    if (Number(amount) <= 0) return res.status(422).json({ error: 'Amount must be positive' })
    if (Number(amount) > available) {
      return res.status(422).json({ error: `Insufficient balance. Available: ₦${available.toLocaleString()}` })
    }

    const threshold = Number(await getSetting('large_payout_threshold', '5000000'))
    const needsReview = Number(amount) >= threshold
    const [result] = await pool.query(
      `INSERT INTO payouts (user_id, amount, bank_name, account_number, account_name, status)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [req.user.id, amount, bankName || '', accountNumber || '', accountName || '', needsReview ? 'under_review' : 'pending'],
    )
    await audit(req, 'payout.requested', 'payout', result.insertId, null, { amount, bankName, needsReview })
    return res.status(201).json({ ok: true, payoutId: result.insertId, status: needsReview ? 'under_review' : 'pending', available })
  } catch (error) {
    console.error('requestPayout failed:', error)
    return res.status(500).json({ error: 'Could not request the payout' })
  }
}

export async function listPayouts(req, res) {
  const { status } = req.query
  try {
    const valid = ['pending', 'under_review', 'approved', 'processing', 'paid', 'failed', 'rejected']
    const where = valid.includes(status) ? 'WHERE p.status = ?' : ''
    const params = valid.includes(status) ? [status] : []
    const [rows] = await pool.query(
      `SELECT p.*, u.name AS user_name, u.email AS user_email, u.role AS user_role
       FROM payouts p JOIN users u ON u.id = p.user_id
       ${where} ORDER BY p.created_at DESC LIMIT 200`,
      params,
    )
    return res.json({ payouts: rows })
  } catch (error) {
    console.error('listPayouts failed:', error)
    return res.status(500).json({ error: 'Could not load payouts' })
  }
}

const PAYOUT_FLOW = { pending: ['under_review', 'approved', 'rejected'], under_review: ['approved', 'rejected'], approved: ['processing', 'rejected'], processing: ['paid', 'failed'], paid: [], failed: ['processing'], rejected: [] }

export async function updatePayoutStatus(req, res) {
  const { payoutId } = req.params
  const { status, note } = req.body
  if (!PAYOUT_FLOW[status] && !Object.keys(PAYOUT_FLOW).includes(status)) {
    return res.status(422).json({ error: 'Invalid payout status' })
  }
  try {
    const [rows] = await pool.query('SELECT * FROM payouts WHERE id = ?', [payoutId])
    const payout = rows[0]
    if (!payout) return res.status(404).json({ error: 'Payout not found' })
    if (!PAYOUT_FLOW[payout.status]?.includes(status)) {
      return res.status(409).json({ error: `Cannot move a ${payout.status} payout to ${status}` })
    }

    await pool.query(
      'UPDATE payouts SET status = ?, admin_note = COALESCE(?, admin_note), processed_by = ?, processed_at = NOW() WHERE id = ?',
      [status, note || null, req.user.id, payoutId],
    )

    // Recording "paid" writes the clearing ledger entry (money left the
    // platform); withdrawal fee comes from settings.
    if (status === 'paid') {
      const fee = Number(await getSetting('withdrawal_fee_value', '0'))
      const txnRef = `PAYOUT-${payout.id}-${Date.now().toString(36).toUpperCase()}`
      await pool.query(
        `INSERT INTO ledger_entries (txn_ref, entry_type, account, user_id, amount, description, reference)
         VALUES (?, 'debit', 'payout_clearing', ?, ?, ?, ?)`,
        [txnRef, payout.user_id, Number(payout.amount) - fee, `Payout released to ${payout.bank_name} ${payout.account_number}`, txnRef],
      )
      if (fee > 0) {
        await pool.query(
          `INSERT INTO ledger_entries (txn_ref, entry_type, account, amount, description, reference)
           VALUES (?, 'credit', 'platform', ?, 'Withdrawal fee', ?)`,
          [txnRef, fee, txnRef],
        )
      }
      await notify(payout.user_id, 'payout_completed', 'Payout completed', `Your payout of ₦${Number(payout.amount).toLocaleString()} has been sent to ${payout.bank_name}.`, 'payout', Number(payoutId))
    }
    if (status === 'approved') {
      await notify(payout.user_id, 'payout_approved', 'Payout approved', `Your payout of ₦${Number(payout.amount).toLocaleString()} was approved and is being processed.`, 'payout', Number(payoutId))
    }
    await audit(req, 'payout.status_changed', 'payout', payoutId, { status: payout.status }, { status, note: note || null })
    return res.json({ ok: true, status })
  } catch (error) {
    console.error('updatePayoutStatus failed:', error)
    return res.status(500).json({ error: 'Could not update the payout' })
  }
}

// =============================================================== LEDGER ==
export async function listLedger(req, res) {
  const { account, from, to } = req.query
  try {
    const where = []
    const params = []
    if (account) {
      where.push('account = ?')
      params.push(account)
    }
    if (from && /^\d{4}-\d{2}-\d{2}$/.test(from)) {
      where.push('created_at >= ?')
      params.push(from)
    }
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) {
      where.push('created_at < DATE_ADD(?, INTERVAL 1 DAY)')
      params.push(to)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const [entries] = await pool.query(
      `SELECT le.*, u.name AS user_name, p.title AS property_title
       FROM ledger_entries le
       LEFT JOIN users u ON u.id = le.user_id
       LEFT JOIN properties p ON p.id = le.property_id
       ${whereSql}
       ORDER BY le.id DESC LIMIT 500`,
      params,
    )
    const [totals] = await pool.query(
      `SELECT account, entry_type, COALESCE(SUM(amount), 0) AS total FROM ledger_entries ${whereSql} GROUP BY account, entry_type`,
      params,
    )
    return res.json({ entries, totals })
  } catch (error) {
    console.error('listLedger failed:', error)
    return res.status(500).json({ error: 'Could not load the ledger' })
  }
}

export async function listInvoices(req, res) {
  const { userId } = req.query
  try {
    const where = userId ? 'WHERE i.user_id = ?' : ''
    const params = userId ? [userId] : []
    const [rows] = await pool.query(
      `SELECT i.*, u.name AS user_name, u.email AS user_email, p.title AS property_title
       FROM invoices i
       JOIN users u ON u.id = i.user_id
       LEFT JOIN properties p ON p.id = i.property_id
       ${where} ORDER BY i.id DESC LIMIT 300`,
      params,
    )
    return res.json({ invoices: rows })
  } catch (error) {
    console.error('listInvoices failed:', error)
    return res.status(500).json({ error: 'Could not load invoices' })
  }
}

// ============================================================= DISPUTES ==
export async function createDispute(req, res) {
  const { propertyId, paymentId, category, subject, details } = req.body
  try {
    const [result] = await pool.query(
      `INSERT INTO disputes (user_id, property_id, payment_id, category, subject, details) VALUES (?, ?, ?, ?, ?, ?)`,
      [req.user.id, propertyId ?? null, paymentId ?? null, category || 'payment', subject, details],
    )
    const [admins] = await pool.query("SELECT id FROM users WHERE role = 'admin'")
    for (const admin of admins) {
      await notify(admin.id, 'dispute_opened', 'New dispute', `${req.user.name} filed a ${category || 'payment'} dispute: ${subject}`, 'dispute', result.insertId)
    }
    await audit(req, 'dispute.created', 'dispute', result.insertId, null, { category, subject })
    return res.status(201).json({ ok: true, disputeId: result.insertId })
  } catch (error) {
    console.error('createDispute failed:', error)
    return res.status(500).json({ error: 'Could not file the dispute' })
  }
}

export async function listDisputes(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT d.*, u.name AS user_name, u.email AS user_email, p.title AS property_title
       FROM disputes d
       JOIN users u ON u.id = d.user_id
       LEFT JOIN properties p ON p.id = d.property_id
       ORDER BY FIELD(d.status, 'open', 'investigating', 'resolved', 'rejected'), d.created_at DESC LIMIT 200`,
    )
    return res.json({ disputes: rows })
  } catch (error) {
    console.error('listDisputes failed:', error)
    return res.status(500).json({ error: 'Could not load disputes' })
  }
}

export async function updateDispute(req, res) {
  const { disputeId } = req.params
  const { status, resolution, adminNotes, refundAmount } = req.body
  const valid = ['open', 'investigating', 'resolved', 'rejected']
  if (status && !valid.includes(status)) return res.status(422).json({ error: 'Invalid dispute status' })
  try {
    const [rows] = await pool.query('SELECT * FROM disputes WHERE id = ?', [disputeId])
    const dispute = rows[0]
    if (!dispute) return res.status(404).json({ error: 'Dispute not found' })

    // Resolving with a refund amount records an authorized refund in the
    // ledger (debit platform, credit the filer) and notifies the user.
    if (status === 'resolved' && Number(refundAmount) > 0) {
      const txnRef = `REFUND-${dispute.id}-${Date.now().toString(36).toUpperCase()}`
      await pool.query(
        `INSERT INTO ledger_entries (txn_ref, entry_type, account, user_id, amount, description, reference)
         VALUES (?, 'debit', 'platform', NULL, ?, ?, ?), (?, 'credit', 'tenant_buyer', ?, ?, ?, ?)`,
        [txnRef, Number(refundAmount), `Refund for dispute #${dispute.id}: ${dispute.subject}`, txnRef,
         txnRef, dispute.user_id, Number(refundAmount), `Refund received (dispute #${dispute.id})`, txnRef],
      )
      await pool.query(
        `UPDATE payments SET status = 'refunded' WHERE id = ? AND status = 'completed'`,
        [dispute.payment_id],
      )
      await notify(dispute.user_id, 'refund_processed', 'Refund processed', `A refund of ₦${Number(refundAmount).toLocaleString()} has been authorized for your dispute "${dispute.subject}".`, 'dispute', Number(disputeId))
    }
    await pool.query(
      'UPDATE disputes SET status = COALESCE(?, status), resolution = COALESCE(?, resolution), admin_notes = COALESCE(?, admin_notes), refund_amount = COALESCE(?, refund_amount) WHERE id = ?',
      [status || null, resolution || null, adminNotes || null, refundAmount ?? null, disputeId],
    )
    await audit(req, 'dispute.updated', 'dispute', disputeId, { status: dispute.status }, { status, resolution, refundAmount })
    return res.json({ ok: true })
  } catch (error) {
    console.error('updateDispute failed:', error)
    return res.status(500).json({ error: 'Could not update the dispute' })
  }
}

// ======================================================== NOTIFICATIONS ==
export async function listNotifications(req, res) {
  try {
    const [rows] = await pool.query(
      'SELECT * FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 100',
      [req.user.id],
    )
    return res.json({ notifications: rows, unread: rows.filter((row) => !row.read_at).length })
  } catch (error) {
    console.error('listNotifications failed:', error)
    return res.status(500).json({ error: 'Could not load notifications' })
  }
}

export async function markNotificationsRead(req, res) {
  try {
    await pool.query('UPDATE notifications SET read_at = NOW() WHERE user_id = ? AND read_at IS NULL', [req.user.id])
    return res.json({ ok: true })
  } catch (error) {
    console.error('markNotificationsRead failed:', error)
    return res.status(500).json({ error: 'Could not update notifications' })
  }
}

// ============================================================== AGENTS ===
export async function listAgents(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT u.id, u.name, u.email, u.status, ap.agency_name, ap.rating, ap.verification_status,
              (SELECT COUNT(*) FROM properties p WHERE p.agent_id = u.id) AS properties_managed,
              (SELECT COUNT(*) FROM properties p WHERE p.agent_id = u.id AND p.status = 'sold') AS properties_sold,
              (SELECT COUNT(*) FROM properties p WHERE p.agent_id = u.id AND p.status = 'rented') AS properties_rented,
              (SELECT COALESCE(SUM(amount), 0) FROM ledger_entries le WHERE le.account = 'agent' AND le.user_id = u.id AND le.entry_type = 'credit') AS commission_earned,
              (SELECT COALESCE(SUM(amount), 0) FROM payouts po WHERE po.user_id = u.id AND po.status IN ('pending','under_review','approved','processing','paid')) AS commission_paid_out
       FROM users u
       LEFT JOIN agent_profiles ap ON ap.user_id = u.id
       WHERE u.agent_id IS NOT NULL OR ap.user_id IS NOT NULL
       GROUP BY u.id
       ORDER BY commission_earned DESC LIMIT 200`,
    )
    const agents = rows.map((row) => ({
      ...row,
      commissionEarned: Number(row.commission_earned),
      commissionPaid: Number(row.commission_paid_out),
      // Pending = earned credits minus everything requested (incl. in-flight).
      commissionPending: Math.max(0, Number(row.commission_earned) - Number(row.commission_paid_out)),
    }))
    return res.json({ agents })
  } catch (error) {
    console.error('listAgents failed:', error)
    return res.status(500).json({ error: 'Could not load agents' })
  }
}

export async function updateAgentVerification(req, res) {
  const { userId } = req.params
  const { verificationStatus, agencyName, rating } = req.body
  const valid = ['unverified', 'pending', 'verified', 'rejected']
  if (verificationStatus && !valid.includes(verificationStatus)) {
    return res.status(422).json({ error: 'Invalid verification status' })
  }
  try {
    await pool.query(
      `INSERT INTO agent_profiles (user_id, agency_name, rating, verification_status)
       VALUES (?, ?, ?, COALESCE(?, 'pending'))
       ON DUPLICATE KEY UPDATE agency_name = COALESCE(?, agency_name), rating = COALESCE(?, rating), verification_status = COALESCE(?, verification_status)`,
      [userId, agencyName || '', rating ?? 0, verificationStatus || null, agencyName || null, rating ?? null, verificationStatus || null],
    )
    await audit(req, 'agent.verification_changed', 'user', userId, null, { verificationStatus, agencyName, rating })
    return res.json({ ok: true })
  } catch (error) {
    console.error('updateAgentVerification failed:', error)
    return res.status(500).json({ error: 'Could not update the agent' })
  }
}

// ============================================================= SETTINGS ==
export async function getPlatformSettings(req, res) {
  try {
    const [rows] = await pool.query('SELECT setting_key, setting_value, updated_at FROM platform_settings ORDER BY setting_key')
    const [tiers] = await pool.query('SELECT * FROM commission_tiers ORDER BY scope, value_min')
    const [rules] = await pool.query('SELECT * FROM revenue_rules ORDER BY scope, id')
    return res.json({ settings: rows, tiers, rules })
  } catch (error) {
    console.error('getPlatformSettings failed:', error)
    return res.status(500).json({ error: 'Could not load settings' })
  }
}

export async function updatePlatformSettings(req, res) {
  const changes = req.body // { setting_key: new_value, ... }
  const keys = Object.keys(changes || {})
  if (!keys.length) return res.status(422).json({ error: 'No settings provided' })
  const allowed = ['rent_reminder_days', 'rent_grace_days', 'late_fee_kind', 'late_fee_value', 'autopay_enabled', 'withdrawal_fee_value', 'large_payout_threshold']
  try {
    for (const key of keys) {
      if (!allowed.includes(key)) continue
      const [current] = await pool.query('SELECT setting_value FROM platform_settings WHERE setting_key = ?', [key])
      const previous = current[0]?.setting_value ?? null
      await pool.query(
        'UPDATE platform_settings SET setting_value = ?, updated_by = ? WHERE setting_key = ?',
        [String(changes[key]), req.user.id, key],
      )
      await audit(req, 'setting.changed', 'platform_setting', key, { value: previous }, { value: String(changes[key]) })
    }
    return res.json({ ok: true })
  } catch (error) {
    console.error('updatePlatformSettings failed:', error)
    return res.status(500).json({ error: 'Could not update settings' })
  }
}

export async function listTiers(req, res) {
  try {
    const [tiers] = await pool.query('SELECT * FROM commission_tiers ORDER BY scope, value_min')
    return res.json({ tiers })
  } catch (error) {
    console.error('listTiers failed:', error)
    return res.status(500).json({ error: 'Could not load commission tiers' })
  }
}

export async function upsertTier(req, res) {
  const { id, scope, valueMin, valueMax, percent, enabled } = req.body
  if (!['sale', 'rent'].includes(scope)) return res.status(422).json({ error: 'scope must be sale or rent' })
  if (Number.isNaN(Number(percent)) || Number(percent) < 0 || Number(percent) > 100) {
    return res.status(422).json({ error: 'percent must be between 0 and 100' })
  }
  try {
    if (id) {
      const [current] = await pool.query('SELECT * FROM commission_tiers WHERE id = ?', [id])
      await pool.query(
        'UPDATE commission_tiers SET scope = ?, value_min = ?, value_max = ?, percent = ?, enabled = ? WHERE id = ?',
        [scope, valueMin, valueMax ?? null, percent, enabled === false ? 0 : 1, id],
      )
      await audit(req, 'commission_tier.updated', 'commission_tier', id, current[0] ?? null, { scope, valueMin, valueMax, percent, enabled })
      return res.json({ ok: true })
    }
    const [result] = await pool.query(
      'INSERT INTO commission_tiers (scope, value_min, value_max, percent, enabled) VALUES (?, ?, ?, ?, ?)',
      [scope, valueMin, valueMax ?? null, percent, enabled === false ? 0 : 1],
    )
    await audit(req, 'commission_tier.created', 'commission_tier', result.insertId, null, { scope, valueMin, valueMax, percent, enabled })
    return res.status(201).json({ ok: true, id: result.insertId })
  } catch (error) {
    console.error('upsertTier failed:', error)
    return res.status(500).json({ error: 'Could not save the commission tier' })
  }
}

export async function deleteTier(req, res) {
  const { tierId } = req.params
  try {
    const [current] = await pool.query('SELECT * FROM commission_tiers WHERE id = ?', [tierId])
    if (!current.length) return res.status(404).json({ error: 'Tier not found' })
    await pool.query('DELETE FROM commission_tiers WHERE id = ?', [tierId])
    await audit(req, 'commission_tier.deleted', 'commission_tier', tierId, current[0], null)
    return res.json({ ok: true })
  } catch (error) {
    console.error('deleteTier failed:', error)
    return res.status(500).json({ error: 'Could not delete the tier' })
  }
}

// ============================================================ AUDIT LOG ==
export async function listAuditLogs(req, res) {
  const { action, adminId } = req.query
  try {
    const where = []
    const params = []
    if (action) {
      where.push('al.action = ?')
      params.push(action)
    }
    if (adminId) {
      where.push('al.admin_id = ?')
      params.push(adminId)
    }
    const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : ''
    const [rows] = await pool.query(
      `SELECT al.*, u.name AS admin_name
       FROM audit_logs al LEFT JOIN users u ON u.id = al.admin_id
       ${whereSql} ORDER BY al.id DESC LIMIT 300`,
      params,
    )
    const [actions] = await pool.query('SELECT DISTINCT action FROM audit_logs ORDER BY action')
    return res.json({ logs: rows, actions: actions.map((row) => row.action) })
  } catch (error) {
    console.error('listAuditLogs failed:', error)
    return res.status(500).json({ error: 'Could not load the audit log' })
  }
}

// Quote preview using tiered commission (Settings → Commission Rules helper).
export async function quoteWithTiers(req, res) {
  const { scope, amount } = req.body
  if (!['sale', 'rent'].includes(scope)) return res.status(422).json({ error: 'scope must be sale or rent' })
  const gross = Number(amount)
  if (!Number.isFinite(gross) || gross <= 0) return res.status(422).json({ error: 'amount must be positive' })
  try {
    const rules = await getRules(scope)
    const tierPct = await agentCommissionPct(scope, gross)
    const agentRule = rules.find((rule) => rule.payee === 'agent')
    const flatPct = agentRule ? Number(agentRule.value) : null
    return res.json({
      scope,
      amount: gross,
      tieredCommissionPct: tierPct,
      flatCommissionPct: flatPct,
      tieredCommission: Math.round(((gross * tierPct) / 100) * 100) / 100,
      effectiveRules: rules.filter((rule) => rule.enabled).map((rule) => ({
        feeKey: rule.fee_key,
        label: rule.label,
        kind: rule.kind,
        value: Number(rule.value),
        bearer: rule.bearer,
        payee: rule.payee,
        monthly: !!rule.monthly,
      })),
    })
  } catch (error) {
    console.error('quoteWithTiers failed:', error)
    return res.status(500).json({ error: 'Could not compute the quote' })
  }
}
