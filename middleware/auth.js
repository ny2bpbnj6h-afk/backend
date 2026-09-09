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
        'SELECT id, name, email, phone, role, preferred_area, portfolio FROM users WHERE id = ?',
        [payload.sub],
      )
      if (!rows.length) return done(null, false)
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
    if (role && user.role !== role) {
      return res.status(403).json({ error: `Requires a ${role} account` })
    }
    req.user = user
    return next()
  })(req, res, next)
}

export default passport
