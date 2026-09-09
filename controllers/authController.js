import crypto from 'node:crypto'
import bcrypt from 'bcryptjs'
import jwt from 'jsonwebtoken'
import pool from '../db/index.js'

const JWT_EXPIRES_IN = process.env.JWT_EXPIRES_IN || '2h'

const signToken = (user) =>
  jwt.sign(
    { sub: user.id, role: user.role, email: user.email },
    process.env.JWT_SECRET || 'housing-agent-dev-secret-change-me',
    { expiresIn: JWT_EXPIRES_IN },
  )

// Public shape of a user — never leaks the password hash.
const publicUser = (user) => ({
  id: user.id,
  name: user.name,
  email: user.email,
  phone: user.phone,
  role: user.role,
  preferredArea: user.preferred_area,
  portfolio: user.portfolio,
})

// Resolve an identifier that may be an email OR a phone number.
// Phones are stored loosely (user-entered), so match on digits only.
const findUserByIdentifier = async (identifier) => {
  const value = String(identifier || '').trim()
  const isEmail = value.includes('@')
  if (isEmail) {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [
      value.toLowerCase(),
    ])
    return rows[0] || null
  }
  const digits = value.replace(/\D/g, '')
  if (!digits) return null
  const [rows] = await pool.query(
    `SELECT * FROM users WHERE REPLACE(REPLACE(REPLACE(REPLACE(phone, ' ', ''), '-', ''), '(', ''), ')', '') LIKE ?`,
    [`%${digits}%`],
  )
  return rows[0] || null
}

export async function signup(req, res) {
  // req.body is already validated + sanitized by Joi middleware
  // (trimmed, lowercased email, unknown fields stripped).
  const { name, email, phone = '', password, role, preferredArea = '', portfolio = '' } = req.body

  try {
    const [existing] = await pool.query('SELECT id FROM users WHERE email = ?', [email])
    if (existing.length) {
      return res.status(409).json({ error: 'An account with this email already exists' })
    }

    const passwordHash = await bcrypt.hash(password, 10)
    const [result] = await pool.query(
      `INSERT INTO users (name, email, phone, password_hash, role, preferred_area, portfolio)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [name, email, phone, passwordHash, role, preferredArea, portfolio],
    )

    const [rows] = await pool.query('SELECT * FROM users WHERE id = ?', [result.insertId])
    const user = rows[0]
    return res.status(201).json({ token: signToken(user), user: publicUser(user), expiresIn: JWT_EXPIRES_IN })
  } catch (error) {
    console.error('signup failed:', error)
    return res.status(500).json({ error: 'Could not create the account' })
  }
}

export async function login(req, res) {
  // req.body is already validated + sanitized by Joi middleware.
  const { email, password } = req.body

  try {
    const [rows] = await pool.query('SELECT * FROM users WHERE email = ?', [email])
    const user = rows[0]
    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({ error: 'Invalid email or password' })
    }
    return res.json({ token: signToken(user), user: publicUser(user), expiresIn: JWT_EXPIRES_IN })
  } catch (error) {
    console.error('login failed:', error)
    return res.status(500).json({ error: 'Could not sign in' })
  }
}

export async function me(req, res) {
  return res.json({ user: publicUser(req.user) })
}

// ---- Forgot / reset password ----

export async function forgotPassword(req, res) {
  const { identifier } = req.body
  try {
    const user = await findUserByIdentifier(identifier)
    // Always answer 200 (never reveal whether an account exists).
    const response = {
      message: 'If that account exists, a 6-digit reset code has been sent.',
    }

    if (user) {
      // Invalidate any previous unused codes for this user.
      await pool.query(
        'UPDATE password_resets SET used_at = NOW() WHERE user_id = ? AND used_at IS NULL',
        [user.id],
      )
      const code = String(crypto.randomInt(0, 1_000_000)).padStart(6, '0')
      const codeHash = await bcrypt.hash(code, 10)
      await pool.query(
        'INSERT INTO password_resets (user_id, code_hash) VALUES (?, ?)',
        [user.id, codeHash],
      )
      // DEV ONLY: no mail/SMS provider is wired up yet, so the code is
      // returned in the response. Remove `devCode` once a provider exists.
      response.devCode = code
      response.sentVia = user.email && identifier.includes('@') ? 'email' : 'phone'
    }
    return res.json(response)
  } catch (error) {
    console.error('forgotPassword failed:', error)
    return res.status(500).json({ error: 'Could not start password reset' })
  }
}

export async function resetPassword(req, res) {
  const { identifier, code, password } = req.body
  try {
    const user = await findUserByIdentifier(identifier)
    // Same generic error for unknown user / bad code — no account enumeration.
    const fail = () => res.status(400).json({ error: 'Invalid or expired reset code' })
    if (!user) return fail()

    const [rows] = await pool.query(
      `SELECT * FROM password_resets
       WHERE user_id = ? AND used_at IS NULL AND expires_at > NOW()
       ORDER BY id DESC LIMIT 1`,
      [user.id],
    )
    const reset = rows[0]
    if (!reset || !(await bcrypt.compare(code, reset.code_hash))) return fail()

    const passwordHash = await bcrypt.hash(password, 10)
    await pool.query('UPDATE users SET password_hash = ? WHERE id = ?', [
      passwordHash,
      user.id,
    ])
    await pool.query('UPDATE password_resets SET used_at = NOW() WHERE id = ?', [
      reset.id,
    ])

    return res.json({ message: 'Password updated — you can sign in now.' })
  } catch (error) {
    console.error('resetPassword failed:', error)
    return res.status(500).json({ error: 'Could not reset the password' })
  }
}
