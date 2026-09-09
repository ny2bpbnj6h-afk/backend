import express from 'express'
import cors from 'cors'
import 'dotenv/config'
import passport from './middleware/auth.js'
import routes from './routes/index.js'

const app = express()
app.use(cors())
// Capture the raw body for webhook HMAC signature verification (the JSON
// parser still runs — rawBody rides along for /payments/webhook).
app.use(
  express.json({
    verify: (req, _res, buf) => {
      req.rawBody = buf
    },
  }),
)
app.use(passport.initialize())

app.get('/api/health', (_req, res) => res.json({ ok: true }))
app.use('/api', routes)

// 404 for unknown API paths
app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found' }))

const port = Number(process.env.PORT || 5174)
app.listen(port, () => {
  console.log(`Housing Agent API listening on http://localhost:${port}`)
})
