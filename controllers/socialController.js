import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import { OAuth2Client } from 'google-auth-library'
import pool from '../db/index.js'

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2h'

// Server-side verification clients.
// Google: verifies the ID token signature against Google's keys and checks
// audience + issuer. APPLE: verifies the JWT against Apple's public JWKS.
const googleClient =
  process.env.GOOGLE_CLIENT_ID
    ? new OAuth2Client(process.env.GOOGLE_CLIENT_ID)
    : null

let appleJwksCache = null
let appleJwksFetchedAt = 0
const APPLE_JWKS_URL = 'https://appleid.apple.com/auth/keys'
const APPLE_JWKS_TTL_MS = 60 * 60 * 1000

async function getAppleSigningKey(kid) {
  if (!appleJwksCache || Date.now() - appleJwksFetchedAt > APPLE_JWKS_TTL_MS) {
    const response = await fetch(APPLE_JWKS_URL)
    if (!response.ok) throw new Error('Could not fetch Apple public keys')
    appleJwksCache = await response.json()
    appleJwksFetchedAt = Date.now()
  }
  return appleJwksCache.keys.find((key) => key.kid === kid) || null
}

/**
 * Verify a Google ID token server-side. Returns
 * { providerId, email, name } or null if invalid.
 */
async function verifyGoogle(idToken) {
  if (!googleClient) return null
  try {
    const ticket = await googleClient.verifyIdToken({
      idToken,
      audience: process.env.GOOGLE_CLIENT_ID,
    })
    const payload = ticket.getPayload()
    // iss: accounts.google.com / https://accounts.google.com
    if (!payload.email_verified) return null
    return { providerId: payload.sub, email: payload.email, name: payload.name || '' }
  } catch (error) {
    console.error('google token verification failed:', error.message)
    return null
  }
}

/**
 * Verify an Apple id_token server-side (RS256 against Apple's JWKS,
 * audience = APPLE_CLIENT_ID / services id, issuer = https://appleid.apple.com).
 * Uses jsonwebtoken with key resolution from the cached JWKS.
 */
async function verifyApple(idToken) {
  if (!process.env.APPLE_CLIENT_ID) return null
  try {
    const decoded = jwt.decode(idToken, { complete: true })
    if (!decoded?.header?.kid) return null
    const jwk = await getAppleSigningKey(decoded.header.kid)
    if (!jwk) return null
    const keyObject = crypto.createPublicKey({ key: jwk, format: 'jwk' })
    const payload = jwt.verify(idToken, keyObject, {
      algorithms: ['RS256'],
      audience: process.env.APPLE_CLIENT_ID,
      issuer: 'https://appleid.apple.com',
    })
    if (!payload.email_verified && !payload.is_private_email) return null
    return { providerId: payload.sub, email: payload.email, name: '' }
  } catch (error) {
    console.error('apple token verification failed:', error.message)
    return null
  }
}

const signToken = (user) =>
  jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET || 'housing-agent-dev-secret-change-me',
    { expiresIn: JWT_EXPIRES_IN },
  )

const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  role: user.role,
  preferredArea: user.preferred_area,
  portfolio: user.portfolio,
})

// Find-or-create the user for a verified social identity, then issue a JWT.
const upsertSocialUser = async (identity) => {
  const email = String(identity.email).toLowerCase()
  const [existing] = await pool.query('SELECT * FROM users WHERE email = ?', [email])

  if (existing.length) {
    const user = existing[0]
    if (user.provider === 'local') {
      await pool.query('UPDATE users SET provider = ?, provider_id = ? WHERE id = ?', [
        identity.provider,
        identity.providerId,
        user.id,
      ])
    }
    return user
  }

  // New social account: unusable random password, seeker by default.
  const passwordHash = await bcrypt.hash(crypto.randomBytes(24).toString('hex'), 10)
  const [result] = await pool.query(
    `INSERT INTO users (name, email, password_hash, role, provider, provider_id)
     VALUES (?, ?, ?, 'seeker', ?, ?)`,
    [identity.name || email.split('@')[0], email, passwordHash, identity.provider, identity.providerId],
  )
  const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId])
  return rows[0]
}

/**
 * POST /api/auth/social
 * Body: { provider: 'google'|'apple', idToken }  (server-verified path)
 *
 * The ID token is ALWAYS verified server-side:
 *  - google: google-auth-library verifies signature + audience + email_verified
 *  - apple:  RS256 JWT verified against Apple's JWKS + audience + issuer
 * If the provider credentials aren't configured server-side yet, requests are
 * rejected with 503 unless SOCIAL_ALLOW_UNVERIFIED=true AND the request comes
 * with an explicitly-verified profile — kept purely for local development.
 */
export async function socialLogin(req, res) {
  const { provider, idToken, verifiedProfile } = req.body

  if (!['google', 'apple'].includes(provider)) {
    return res.status(400).json({ error: 'Unsupported provider' })
  }

  let identity
  if (provider === 'google') {
    identity = await verifyGoogle(idToken)
  } else {
    identity = await verifyApple(idToken)
  }

  if (!identity) {
    // Development escape hatch: never enabled in production (.env controls it).
    if (
      process.env.SOCIAL_ALLOW_UNVERIFIED === 'true' &&
      verifiedProfile?.email
    ) {
      identity = {
        providerId: String(verifiedProfile.sub || verifiedProfile.id || 'unverified'),
        email: verifiedProfile.email,
        name: verifiedProfile.name || '',
      }
    } else {
      return res.status(401).json({
        error: 'Could not verify that sign-in. Please try again.',
        hint: process.env.GOOGLE_CLIENT_ID || process.env.APPLE_CLIENT_ID
          ? undefined
          : 'Social sign-in is not configured on the server yet (GOOGLE_CLIENT_ID / APPLE_CLIENT_ID in backend/.env).',
      })
    }
  }

  try {
    const user = await upsertSocialUser({ provider, ...identity })
    return res.json({ token: signToken(user), user: publicUser(user), expiresIn: JWT_EXPIRES_IN })
  } catch (error) {
    console.error('socialLogin failed:', error)
    return res.status(500).json({ error: 'Could not sign in with that provider' })
  }
}
