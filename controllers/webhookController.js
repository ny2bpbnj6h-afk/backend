// Payment webhook handler — the platform's trust boundary for money.
// The frontend saying "payment succeeded" means nothing; only a verified
// provider webhook (or server-side verification) settles funds here.
//
// Security: raw-body HMAC-SHA512 signature verification (via the express
// json verify hook), reference idempotency (unique keys + status guards),
// and replay-safe ledger writes (ON DUPLICATE KEY).
import crypto from 'node:crypto'
import pool from '../db/index.js'
import { markPaymentCompleted, markPaymentFailed, verifyWebhookSignature, getProvider } from '../services/payments.js'
import { settleRentPayment, settleSale } from '../services/ledger.js'

export async function paymentWebhook(req, res) {
  // 1. Verify the signature against the RAW body (captured by server.js).
  const signature = req.headers['x-paystack-signature']
  const { ok, mode } = verifyWebhookSignature(req.rawBody, signature)
  if (!ok) {
    return res.status(401).json({ error: 'Invalid webhook signature' })
  }

  let event
  try {
    event = JSON.parse(req.rawBody.toString('utf8'))
  } catch {
    return res.status(400).json({ error: 'Invalid webhook payload' })
  }

  const eventName = event?.event
  const data = event?.data
  const reference = data?.reference
  if (!reference) return res.status(400).json({ error: 'Missing reference' })

  // 2. Idempotency: remember processed events (unique event id when the
  //    provider sends one; fall back to reference+event hash).
  const eventId = String(data?.id || crypto.createHash('sha256').update(`${eventName}:${reference}`).digest('hex'))
  try {
    await pool.query(
      `INSERT INTO webhook_events (event_id, provider, event_name, reference) VALUES (?, ?, ?, ?)`,
      [eventId, mode === 'unverified' ? 'mock' : 'paystack', eventName || '', reference],
    )
  } catch {
    // Duplicate event — already processed, acknowledge without re-settling.
    return res.json({ ok: true, duplicate: true })
  }

  try {
    if (eventName === 'charge.success') {
      // 3. Verify amount server-side where the pending payment is known.
      const [pending] = await pool.query('SELECT * FROM payments WHERE reference = ?', [reference])
      const payment = pending[0]
      if (!payment) return res.json({ ok: true, ignored: 'unknown reference' })

      if (data.amount != null) {
        const webhookAmount = Number(data.amount) / 100 // kobo → naira
        if (Math.abs(webhookAmount - Number(payment.amount)) > 0.01) {
          await markPaymentFailed(reference)
          return res.status(422).json({ error: 'Amount mismatch — payment rejected' })
        }
      }

      // 4. Flip the pending payment → completed (idempotent by reference).
      const settled = await markPaymentCompleted(reference, (payment.provider || 'card') === 'paystack' ? 'card' : 'card')
      if (!settled) return res.json({ ok: true, duplicate: true })

      // 5. Dispatch by purpose: rent charges settle their lease; direct
      //    property purchases settle the sale pipeline.
      const purpose = payment.purpose || ''
      if (purpose.startsWith('rent_payment:')) {
        const rentPaymentId = Number(purpose.split(':')[1])
        const result = await settleRentPayment({ rentPaymentId, reference })
        return res.json({ ok: true, settled: 'rent', result })
      }
      if (purpose.startsWith('sale:')) {
        const propertyId = Number(purpose.split(':')[1])
        const result = await settleSale({
          propertyId,
          buyerId: payment.user_id,
          price: Number(payment.meta?.price || payment.amount),
          reference,
          agentId: payment.meta?.agentId ?? null,
        })
        return res.json({ ok: true, settled: 'sale', result })
      }
      // Other kinds (listing fees, subscriptions, promotions) just complete.
      return res.json({ ok: true, settled: 'payment' })
    }

    if (eventName === 'charge.failed') {
      await markPaymentFailed(reference)
      return res.json({ ok: true, failed: true })
    }

    return res.json({ ok: true, ignored: eventName || 'unknown event' })
  } catch (error) {
    // Remove the event marker so the provider's retry can re-process.
    await pool.query('DELETE FROM webhook_events WHERE event_id = ?', [eventId]).catch(() => {})
    console.error('paymentWebhook failed:', error)
    return res.status(500).json({ error: 'Webhook processing failed' })
  }
}

// Server-side verification fallback (e.g. user returns from the provider
// and the webhook hasn't landed yet). Verifies with the provider directly —
// never trusts the client's claim.
export async function verifyPayment(req, res) {
  const { reference } = req.params
  try {
    const [rows] = await pool.query('SELECT * FROM payments WHERE reference = ?', [reference])
    const payment = rows[0]
    if (!payment) return res.status(404).json({ error: 'Payment not found' })
    if (payment.status === 'completed') {
      return res.json({ ok: true, status: 'completed' })
    }
    const provider = getProvider(payment.provider || undefined)
    if (provider.name === 'mock') {
      return res.status(409).json({ error: 'Mock provider has no verification endpoint; settle via webhook' })
    }
    const verification = await provider.verify(reference)
    if (verification.status !== 'success') {
      return res.json({ ok: true, status: verification.status })
    }
    // Settle exactly like the webhook does.
    if (payment.purpose?.startsWith('rent_payment:')) {
      const result = await settleRentPayment({ rentPaymentId: Number(payment.purpose.split(':')[1]), reference })
      return res.json({ ok: true, settled: 'rent', result })
    }
    if (payment.purpose?.startsWith('sale:')) {
      const result = await settleSale({
        propertyId: Number(payment.purpose.split(':')[1]),
        buyerId: payment.user_id,
        price: Number(payment.meta?.price || payment.amount),
        reference,
        agentId: payment.meta?.agentId ?? null,
      })
      return res.json({ ok: true, settled: 'sale', result })
    }
    await markPaymentCompleted(reference)
    return res.json({ ok: true, settled: 'payment' })
  } catch (error) {
    console.error('verifyPayment failed:', error)
    return res.status(500).json({ error: 'Verification failed' })
  }
}
