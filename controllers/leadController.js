// Contact-form leads: public capture from the contact page, admin CRM with
// New -> Contacted -> Closed status flow, customer detail history, and
// email/WhatsApp alerting to the team on every new submission.
import pool from '../db/index.js'
import { audit } from '../services/audit.js'
import { processOutbox, notifyAdmins } from '../services/messaging.js'

export const LEAD_STATUSES = ['new', 'contacted', 'closed']

const publicLead = (row) => ({
  id: row.id,
  name: row.name,
  email: row.email,
  phone: row.phone,
  role: row.role,
  message: row.message,
  status: row.status,
  source: row.source,
  adminNotes: row.admin_notes,
  contactedAt: row.contacted_at,
  closedAt: row.closed_at,
  createdAt: row.created_at,
  // Attach the account link when the submitter was signed in.
  userId: row.user_id,
})

// =========================================================== CAPTURE (public)
export async function createContactMessage(req, res) {
  const { name, email, phone, role, message, source } = req.body
  try {
    const [result] = await pool.query(
      `INSERT INTO contact_messages (name, email, phone, role, message, source, user_id)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        name,
        email,
        phone || '',
        role || 'Other',
        message,
        source || 'contact_page',
        req.user?.id ?? null,
      ],
    )
    const leadId = result.insertId

    // Best-effort team alert (in-app + outbox email). Never blocks/breaks.
    await notifyAdmins(
      'lead_new',
      'New lead received',
      `${name} (${role || 'Other'}) just submitted the contact form. Email: ${email}${phone ? ` · Phone: ${phone}` : ''}. Message: ${String(message).slice(0, 300)}`,
      'contact_message',
      leadId,
    )
    // Deliver the queued alert now (no-op when SMTP/WhatsApp aren't set up).
    processOutbox(5).catch(() => {})

    return res.status(201).json({
      lead: { id: leadId, status: 'new' },
      message: 'Thanks! Our support team will get back to you within 24 hours.',
    })
  } catch (error) {
    console.error('createContactMessage failed:', error)
    return res.status(500).json({ error: 'Could not send your message. Please try again.' })
  }
}

// ============================================================= CRM (admin) ===
export async function listLeads(req, res) {
  const { status, q, limit = 200 } = req.query
  try {
    const clauses = []
    const params = []
    if (status && LEAD_STATUSES.includes(status)) {
      clauses.push('status = ?')
      params.push(status)
    }
    if (q) {
      clauses.push('(name LIKE ? OR email LIKE ? OR phone LIKE ? OR message LIKE ?)')
      const like = `%${q}%`
      params.push(like, like, like, like)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const [rows] = await pool.query(
      `SELECT * FROM contact_messages ${where} ORDER BY created_at DESC LIMIT ?`,
      params.concat([Number(limit) || 200]),
    )
    const [counts] = await pool.query(
      `SELECT status, COUNT(*) AS total FROM contact_messages GROUP BY status`,
    )
    const byStatus = { new: 0, contacted: 0, closed: 0 }
    for (const row of counts) byStatus[row.status] = row.total
    return res.json({ leads: rows.map(publicLead), counts: byStatus })
  } catch (error) {
    console.error('listLeads failed:', error)
    return res.status(500).json({ error: 'Could not load leads' })
  }
}

// Customer detail: every submission from the same email (lead history).
export async function getLead(req, res) {
  const { leadId } = req.params
  try {
    const [rows] = await pool.query('SELECT * FROM contact_messages WHERE id = ?', [leadId])
    if (!rows.length) return res.status(404).json({ error: 'Lead not found' })
    const lead = rows[0]
    const [history] = await pool.query(
      `SELECT id, name, role, message, status, source, created_at
       FROM contact_messages WHERE email = ? AND id != ?
       ORDER BY created_at DESC LIMIT 50`,
      [lead.email, lead.id],
    )
    return res.json({ lead: publicLead(lead), history: history.map(publicLead) })
  } catch (error) {
    console.error('getLead failed:', error)
    return res.status(500).json({ error: 'Could not load the lead' })
  }
}

// Status flow + notes. Allowed: new->contacted->closed. Contacted/closed
// stamp the timestamps; every change writes an audit row (who/old/new).
export async function updateLead(req, res) {
  const { leadId } = req.params
  const { status, adminNotes } = req.body
  try {
    const [rows] = await pool.query('SELECT * FROM contact_messages WHERE id = ?', [leadId])
    const lead = rows[0]
    if (!lead) return res.status(404).json({ error: 'Lead not found' })

    const updates = {}
    if (status !== undefined) {
      if (!LEAD_STATUSES.includes(status)) {
        return res.status(422).json({ error: `Status must be one of: ${LEAD_STATUSES.join(', ')}` })
      }
      const allowed = { new: ['contacted', 'closed'], contacted: ['closed', 'new'], closed: ['new'] }
      if (!allowed[lead.status].includes(status)) {
        return res.status(409).json({ error: `Cannot move a ${lead.status} lead to ${status}` })
      }
      updates.status = status
      if (status === 'contacted') updates.contacted_at = new Date()
      if (status === 'closed') updates.closed_at = new Date()
    }
    if (adminNotes !== undefined) updates.admin_notes = String(adminNotes).slice(0, 2000)
    if (!Object.keys(updates).length) {
      return res.status(422).json({ error: 'Nothing to update' })
    }

    const sets = Object.keys(updates).map((key) => `${key} = ?`).join(', ')
    await pool.query(`UPDATE contact_messages SET ${sets} WHERE id = ?`, [
      ...Object.values(updates),
      leadId,
    ])

    await audit(req, 'lead.status_changed', 'contact_message', leadId, { status: lead.status, admin_notes: lead.admin_notes }, updates)
    return res.json({ lead: publicLead({ ...lead, ...updates }) })
  } catch (error) {
    console.error('updateLead failed:', error)
    return res.status(500).json({ error: 'Could not update the lead' })
  }
}

// ============================================================ OUTBOX (admin) =
// What the platform tried to send (or would send once providers are set up).
export async function listOutbox(req, res) {
  const { status, channel } = req.query
  try {
    const clauses = []
    const params = []
    if (status && ['pending', 'sent', 'failed'].includes(status)) {
      clauses.push('status = ?')
      params.push(status)
    }
    if (channel && ['email', 'whatsapp', 'sms'].includes(channel)) {
      clauses.push('channel = ?')
      params.push(channel)
    }
    const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : ''
    const [rows] = await pool.query(
      `SELECT * FROM outbox ${where} ORDER BY created_at DESC LIMIT 200`,
      params,
    )
    return res.json({ messages: rows })
  } catch (error) {
    console.error('listOutbox failed:', error)
    return res.status(500).json({ error: 'Could not load the outbox' })
  }
}
