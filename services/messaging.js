// Outbound messaging: email + WhatsApp delivery with a durable outbox.
//
// Design: notify() already writes in-app notifications. This module adds
// EMAIL + WHATSAPP delivery that never blocks or breaks a request:
//   1. Every outbound message is first persisted to the `outbox` table
//      (channel, recipient, subject/body, template, entity linkage).
//   2. If provider credentials are configured, delivery is attempted
//      immediately (SMTP via nodemailer; WhatsApp via a generic HTTP API).
//   3. Without credentials, rows stay 'pending' — nothing is lost, and the
//      queue can be inspected/replayed once providers are set up.
// Delivery failures retry up to 5 attempts, then park as 'failed'.
import pool from '../db/index.js'
import { notify } from './ledger.js'

let transporter = null
let transporterChecked = false

const emailConfigured = () =>
  Boolean(process.env.SMTP_HOST && process.env.SMTP_PORT && process.env.SMTP_USER)

const whatsappConfigured = () =>
  Boolean(process.env.WHATSAPP_API_URL && process.env.WHATSAPP_API_TOKEN)

export const deliveryStatus = () => ({
  email: emailConfigured(),
  whatsapp: whatsappConfigured(),
})

const getTransporter = async () => {
  if (!emailConfigured()) return null
  if (transporterChecked) return transporter
  transporterChecked = true
  try {
    const nodemailer = (await import('nodemailer')).default
    const port = Number(process.env.SMTP_PORT || 587)
    transporter = nodemailer.createTransport({
      host: process.env.SMTP_HOST,
      port,
      secure: process.env.SMTP_SECURE === 'true' || port === 465,
      auth: { user: process.env.SMTP_USER, pass: process.env.SMTP_PASS },
    })
  } catch (error) {
    console.error('SMTP init failed (messages will queue in the outbox):', error.message)
    transporter = null
  }
  return transporter
}

// Persist first — the outbox is the source of truth, delivery is best-effort.
export const queueMessage = async ({
  channel = 'email',
  recipient,
  subject = '',
  body = '',
  template = '',
  userId = null,
  entityType = '',
  entityId = null,
}) => {
  if (!recipient) return null
  try {
    const [result] = await pool.query(
      `INSERT INTO outbox (channel, recipient, subject, body, template, user_id, entity_type, entity_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [channel, recipient, subject, body, template, userId, entityType, entityId],
    )
    return result.insertId
  } catch (error) {
    console.error('outbox write failed:', error.message)
    return null
  }
}

// 'sent' | 'blocked' (provider not configured) | throws on provider error.
const deliverEmail = async (row) => {
  const tx = await getTransporter()
  if (!tx) return 'blocked'
  await tx.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: row.recipient,
    subject: row.subject || '(Housing Agent notification)',
    text: row.body,
  })
  return 'sent'
}

const deliverWhatsapp = async (row) => {
  if (!whatsappConfigured()) return 'blocked'
  const response = await fetch(process.env.WHATSAPP_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${process.env.WHATSAPP_API_TOKEN}`,
    },
    body: JSON.stringify({ to: row.recipient, message: row.body }),
  })
  if (!response.ok) {
    throw new Error(`WhatsApp API ${response.status}: ${(await response.text()).slice(0, 200)}`)
  }
  return 'sent'
}

// Worker: attempt pending outbox rows. Called inline on lead capture (small
// batch) and can be scheduled (cron) for the rest of the queue.
export const processOutbox = async (limit = 25) => {
  const [rows] = await pool.query(
    `SELECT * FROM outbox WHERE status = 'pending' ORDER BY created_at ASC LIMIT ?`,
    [limit],
  )
  let sent = 0
  let queued = 0
  let failed = 0
  for (const row of rows) {
    try {
      const outcome = row.channel === 'whatsapp' ? await deliverWhatsapp(row) : await deliverEmail(row)
      if (outcome === 'sent') {
        await pool.query(
          `UPDATE outbox SET status = 'sent', sent_at = NOW(), attempts = attempts + 1, last_error = '' WHERE id = ?`,
          [row.id],
        )
        sent += 1
      } else {
        queued += 1 // provider not configured — stays pending on purpose
      }
    } catch (error) {
      const attempts = row.attempts + 1
      const giveUp = attempts >= 5
      await pool.query(`UPDATE outbox SET status = ?, attempts = ?, last_error = ? WHERE id = ?`, [
        giveUp ? 'failed' : 'pending',
        attempts,
        String(error.message || error).slice(0, 500),
        row.id,
      ])
      if (giveUp) failed += 1
    }
  }
  return { processed: rows.length, sent, queued, failed }
}

// In-app + email(+ WhatsApp when a phone exists) for one user, fire-and-forget.
export const notifyAndDeliver = async (userId, type, title, body, entityType = '', entityId = null) => {
  if (!userId) return
  await notify(userId, type, title, body, entityType, entityId)
  try {
    const [rows] = await pool.query('SELECT email, phone FROM users WHERE id = ?', [userId])
    const user = rows[0]
    if (!user) return
    if (user.email) {
      await queueMessage({ channel: 'email', recipient: user.email, subject: title, body, template: type, userId, entityType, entityId })
    }
    if (user.phone) {
      await queueMessage({ channel: 'whatsapp', recipient: user.phone, body: `${title}\n\n${body}`.slice(0, 4000), template: type, userId, entityType, entityId })
    }
  } catch (error) {
    console.error('notifyAndDeliver failed:', error.message)
  }
}

// Alert every active admin (in-app + email queue) — used for new leads and
// anything that needs staff attention.
export const notifyAdmins = async (type, title, body, entityType = '', entityId = null) => {
  try {
    const [admins] = await pool.query("SELECT id, email FROM users WHERE role = 'admin' AND status = 'active'")
    for (const admin of admins) {
      await notify(admin.id, type, title, body, entityType, entityId)
      if (admin.email) {
        await queueMessage({ channel: 'email', recipient: admin.email, subject: title, body, template: type, userId: admin.id, entityType, entityId })
      }
    }
    return admins.length
  } catch (error) {
    console.error('notifyAdmins failed:', error.message)
    return 0
  }
}
