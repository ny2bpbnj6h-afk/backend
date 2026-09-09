// Payment provider abstraction — the platform never trusts the frontend's
// "payment succeeded"; success comes only from provider verification or a
// signature-verified webhook. Providers plug in here (mock, Paystack today;
// Flutterwave/Stripe follow the same two-method shape).
//
// Secret keys live ONLY in backend env (PAYSTACK_SECRET_KEY). The frontend
// gets back an authorization URL, never a key.
import crypto from 'node:crypto'
import 'dotenv/config'
import pool from '../db/index.js'

// ---------------------------------------------------------------- mock ----
// Used for local/dev and the integration test suite: verification is driven
// by calling the provider's webhook endpoint with the correct idempotency
// reference. If PAYSTACK_SECRET_KEY is absent, webhook signatures are not
// enforced (dev mode) — production must configure a real provider secret.
const mockProvider = {
  name: 'mock',
  async initiate({ amount, reference, email }) {
    return {
      provider: 'mock',
      reference,
      amount,
      currency: 'NGN',
      authorizationUrl: null,
      email,
    }
  },
}

// ------------------------------------------------------------ paystack ----
const PAYSTACK_BASE = 'https://api.paystack.co'

const paystackProvider = {
  name: 'paystack',
  async initiate({ amount, reference, email, meta }) {
    const key = process.env.PAYSTACK_SECRET_KEY
    if (!key) throw new Error('Paystack is not configured (missing PAYSTACK_SECRET_KEY)')
    const response = await fetch(`${PAYSTACK_BASE}/transaction/initialize`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        // Paystack expects kobo.
        amount: Math.round(Number(amount) * 100),
        email,
        reference,
        currency: 'NGN',
        metadata: meta || {},
      }),
    })
    const body = await response.json()
    if (!response.ok || !body?.status) {
      throw new Error(body?.message || 'Paystack initialization failed')
    }
    return {
      provider: 'paystack',
      reference,
      amount,
      currency: 'NGN',
      authorizationUrl: body.data.authorization_url,
      accessCode: body.data.access_code,
    }
  },
  // Server-to-server verification (the "don't trust the frontend" path).
  async verify(reference) {
    const key = process.env.PAYSTACK_SECRET_KEY
    if (!key) throw new Error('Paystack is not configured (missing PAYSTACK_SECRET_KEY)')
    const response = await fetch(`${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`, {
      headers: { Authorization: `Bearer ${key}` },
    })
    const body = await response.json()
    if (!response.ok || !body?.status) {
      throw new Error(body?.message || 'Paystack verification failed')
    }
    return {
      status: body.data.status === 'success' ? 'success' : body.data.status,
      amount: Number(body.data.amount) / 100, // kobo → naira
      paidAt: body.data.paid_at || null,
      provider: 'paystack',
    }
  },
}

const PROVIDERS = { mock: mockProvider, paystack: paystackProvider }

export const activeProviderName = () =>
  process.env.PAYSTACK_SECRET_KEY ? 'paystack' : 'mock'

export const getProvider = (name = activeProviderName()) => {
  const provider = PROVIDERS[name]
  if (!provider) throw new Error(`Unknown payment provider: ${name}`)
  return provider
}

// HMAC-SHA512 signature check (Paystack's scheme). `rawBody` is captured by
// the express.json verify callback in server.js — do not re-parse JSON here.
export const verifyWebhookSignature = (rawBody, signature) => {
  const secret = process.env.PAYSTACK_SECRET_KEY
  if (!secret) {
    // Dev/mock mode: no provider secret configured. Accept but mark it, so
    // tests still exercise the flow while prod is never accidentally open.
    return { ok: true, mode: 'unverified' }
  }
  if (!signature) return { ok: false, mode: 'missing-signature' }
  const expected = crypto.createHmac('sha512', secret).update(rawBody).digest('hex')
  const provided = String(signature)
  const ok =
    expected.length === provided.length &&
    crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(provided))
  return { ok, mode: 'hmac-sha512' }
}

// Unique reference generator (idempotency key surface). Collisions are also
// guarded by the DB unique keys that consume references.
export const newReference = (prefix = 'HA') =>
  `${prefix}-${Date.now().toString(36)}-${crypto.randomBytes(5).toString('hex')}`.toUpperCase()

// Persist the initiated payment as pending before leaving the platform —
// the webhook settles it. Duplicate references throw on the unique key.
export const recordPendingPayment = async ({ userId, propertyId, kind, amount, reference, provider, purpose, meta }) => {
  const [result] = await pool.query(
    `INSERT INTO payments (user_id, property_id, kind, amount, status, method, reference, provider, purpose, meta)
     VALUES (?, ?, ?, ?, 'pending', 'card', ?, ?, ?, ?)`,
    [userId, propertyId ?? null, kind, amount, reference, provider, purpose || '', meta ? JSON.stringify(meta) : null],
  )
  return result.insertId
}

// Idempotent settlement helper: flips a pending payment to completed only if
// it is still pending (unique-reference callers stay race-free).
export const markPaymentCompleted = async (reference, method = 'card') => {
  const [result] = await pool.query(
    `UPDATE payments SET status = 'completed', method = ? WHERE reference = ? AND status = 'pending'`,
    [method, reference],
  )
  if (!result.affectedRows) return null
  const [rows] = await pool.query('SELECT * FROM payments WHERE reference = ? LIMIT 1', [reference])
  return rows[0]
}

export const markPaymentFailed = async (reference) => {
  await pool.query(`UPDATE payments SET status = 'failed' WHERE reference = ? AND status = 'pending'`, [reference])
}
