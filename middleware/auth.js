import { Strategy as JwtStrategy, ExtractJwt } from 'passport-jwt'
import passport from 'passport'
import pool from '../db/index.js'

const opts = {
  jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
  secretOrKey: process.env.JWT_SECRET || 'housing-agent-dev-secret-change-me',
}

passport.use(
  new JwtStrategy(opts, async (payload, done) => {
    try {
      const [rows] = await pool.query(
        'SELECT id, name, email, phone, role, preferred_area, portfolio, status FROM users WHERE id = ?',
        [payload.sub],
      )
      if (!rows.length) return done(null, false)
      if (rows[0].status === 'suspended') {
        // Account suspended by an admin — treat as unauthenticated.
        return done(null, false)
      }
      return done(null, rows[0])
    } catch (error) {
      return done(error, false)
    }
  }),
)

// Wrapper for Express route handlers: requires a valid Bearer token and
// attaches the user row to req.user. Pass a role ('seeker'|'owner') to
// additionally enforce the account type.
export const requireAuth = (role) => (req, res, next) => {
  passport.authenticate('jwt', { session: false }, (error, user) => {
    if (error) return next(error)
    if (!user) {
      return res.status(401).json({ error: 'Authentication required' })
    }
    // `role` may be one role or a list (e.g. landlords AND agents can list).
    const roles = Array.isArray(role) ? role : role ? [role] : []
    if (roles.length && !roles.includes(user.role)) {
      return res.status(403).json({ error: `Requires a ${roles.join(' or ')} account` })
    }
    req.user = user
    return next()
  })(req, res, next)
}

// Same as requireAuth but tolerates missing/invalid tokens: guests pass
// through with req.user = null. Use only on read-only endpoints (e.g.
// property detail) where signed-out visitors are allowed.
export const optionalAuth = (req, res, next) => {
  passport.authenticate('jwt', { session: false }, (error, user) => {
    if (error) return next(error)
    req.user = user || null
    return next()
  })(req, res, next)
}

export default passport
