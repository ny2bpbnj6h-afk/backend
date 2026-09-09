// End-to-end revenue engine test: seed admin + property, exercise quote,
// rule updates, and automatic transaction recording. Cleans up after itself.
const BASE = 'http://localhost:5199/api'

const post = (path, body, token) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
const get = (path, token) =>
  fetch(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
const patch = (path, body, token) =>
  fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })

let passed = 0
let failed = 0
const check = (name, cond, extra = '') => {
  if (cond) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failed++
    console.log(`  ✗ ${name} ${extra}`)
  }
}

const { default: pool } = await import('../db/index.js')
// Remove leftovers from any earlier failed run (properties/txns cascade).
await pool.query("DELETE FROM users WHERE email LIKE '%@t.test'")
// Restore the seed default in case an earlier failed run corrupted it.
await pool.query("UPDATE revenue_rules SET value = 2 WHERE fee_key = 'sale_platform_commission'")

const stamp = Date.now()
const ADMIN = { name: 'Rev Admin', email: `revadmin${stamp}@t.test`, password: 'Passw0rd!', role: 'owner' }
const OWNER = { name: 'Rev Owner', email: `revowner${stamp}@t.test`, password: 'Passw0rd!', role: 'owner' }

// ---- signup ----
for (const u of [ADMIN, OWNER]) {
  const r = await post('/auth/signup', u)
  check(`signup ${u.email}`, r.status === 201 || r.status === 200)
}

// ---- make admin an actual admin ----
await pool.query("UPDATE users SET role = 'admin' WHERE email = ?", [ADMIN.email])

const adminLogin = await (await post('/auth/login', { email: ADMIN.email, password: ADMIN.password })).json()
const adminToken = adminLogin.token || adminLogin.data?.token
check('admin login returns token', !!adminToken)

// non-admin gets 403 on revenue endpoints, guest 401
const ownerLogin = await (await post('/auth/login', { email: OWNER.email, password: OWNER.password })).json()
const ownerToken = ownerLogin.token || ownerLogin.data?.token
const forbidden = await get('/admin/revenue/settings', ownerToken)
check('non-admin blocked from revenue settings (403)', forbidden.status === 403)
const guest = await get('/admin/revenue/settings')
check('guest blocked from revenue settings (401)', guest.status === 401)

// ---- settings: rules loaded from DB, not hard-coded ----
const settings = await (await get('/admin/revenue/settings', adminToken)).json()
const rules = settings.rules || settings
check('settings returns rules array', Array.isArray(rules) && rules.length >= 10, `got ${rules?.length}`)

const saleCommission = rules.find((r) => r.scope === 'sale' && r.fee_key === 'sale_platform_commission')
check('sale_platform_commission rule exists', !!saleCommission)

// ---- update a rule ----
if (saleCommission) {
  const upd = await patch(`/admin/revenue/rules/${saleCommission.id}`, { value: 2, enabled: true }, adminToken)
  check('update rule value (2%)', upd.status === 200)
  const bad = await patch(`/admin/revenue/rules/${saleCommission.id}`, { value: 500 }, adminToken)
  check('percent > 100 rejected (422)', bad.status === 422, `got ${bad.status}`)
}

// ---- quote: ₦100,000,000 sale → platform revenue = ₦2,000,000 (spec example) ----
const quoteRes = await (await post('/admin/revenue/quote', { scope: 'sale', amount: 100000000 }, adminToken)).json()
const q = quoteRes.quote
check('quote returns totals', !!q?.totals, JSON.stringify(quoteRes).slice(0, 200))
// Spec example: platform commission line = 2% of ₦100M = ₦2,000,000.
const commissionLine = q?.lines?.find((l) => l.feeKey === 'sale_platform_commission')
check('commission line = ₦2,000,000 (2% of ₦100M)', Number(commissionLine?.amount) === 2000000, `got ${commissionLine?.amount}`)
// platformRevenue totals every platform-payee fee (buyer + seller + commission).
const platformLineSum = q.lines.filter((l) => l.payee === 'platform').reduce((s, l) => s + Number(l.amount), 0)
check('platformRevenue = sum of platform-payee fees', Number(q?.totals?.platformRevenue) === platformLineSum, `got ${q?.totals?.platformRevenue} vs ${platformLineSum}`)
check('quote lines itemize every fee', Array.isArray(q?.lines) && q.lines.length >= 5)
check('agent commission listed separately', Number(q?.totals?.agentCommission) > 0)
check('buyer/seller burdens computed', q?.totals?.buyerTotal > 0 && q?.totals?.sellerFees > 0)

// rent quote
const rentQuote = await (await post('/admin/revenue/quote', { scope: 'rent', amount: 2000000 }, adminToken)).json()
check('rent quote computes totals', Number(rentQuote?.quote?.totals?.totalFees) > 0)

// ---- create a property as owner, then admin marks it sold ----
const prop = await post(
  '/properties',
  {
    title: 'Revenue Test Duplex',
    description: 'A test property for revenue engine verification',
    area: 'Lekki',
    purpose: 'sale',
    propertyType: 'house',
    saleAmount: 100000000,
    bedrooms: 4,
    bathrooms: 4,
  },
  ownerToken,
)
const propBody = await prop.json()
const propId = propBody.property?.id
check('owner creates sale property (pending)', prop.status === 201 && !!propId, `status ${prop.status}: ${JSON.stringify(propBody).slice(0, 160)}`)

const appr = await patch(`/admin/properties/${propId}/status`, { status: 'active' }, adminToken)
check('admin approves property', appr.status === 200, `status ${appr.status}`)
const sold = await patch(`/admin/properties/${propId}/status`, { status: 'sold' }, adminToken)
const soldRes = await sold.json()
check('admin marks property sold', sold.status === 200, `status ${sold.status}`)
check('sold response carries the fee snapshot', !!soldRes.transaction && soldRes.transaction.lines.length >= 5, JSON.stringify(soldRes).slice(0, 160))

// ---- transactions ledger shows the recorded sale ----
const txns = await (await get('/admin/revenue/transactions', adminToken)).json()
const saleTxn = (txns.transactions || []).find((t) => String(t.property?.id) === String(propId) && t.kind === 'sale')
check('sale transaction recorded in ledger', !!saleTxn)
if (saleTxn) {
  const txnCommission = saleTxn.lines.find((l) => l.feeKey === 'sale_platform_commission')
  check('ledger commission line = ₦2,000,000', Number(txnCommission?.amount) === 2000000, `got ${txnCommission?.amount}`)
  check('ledger txn gross = ₦100,000,000', saleTxn.grossAmount === 100000000, `got ${saleTxn.grossAmount}`)
  check('ledger txn platformRevenue = sum of platform lines', saleTxn.platformRevenue === saleTxn.lines.filter((l) => l.payee === 'platform').reduce((s, l) => s + l.amount, 0), `got ${saleTxn.platformRevenue}`)
  check('ledger txn itemizes lines', saleTxn.lines.length >= 5)
}
check('payee totals present', Array.isArray(txns.payeeTotals) && txns.payeeTotals.length >= 3)

// manual record/refresh endpoint (offline completion flow)
const manual = await post(
  '/admin/revenue/transactions',
  { propertyId: Number(propId), kind: 'rent', amount: 2000000 },
  adminToken,
)
check('manual rent transaction recorded (201)', manual.status === 201, `status ${manual.status}`)
const notFound = await post('/admin/revenue/transactions', { propertyId: 99999999, kind: 'rent', amount: 1000 }, adminToken)
check('unknown property rejected (404)', notFound.status === 404, `got ${notFound.status}`)

// ---- cleanup: remove test rows (orders matter for FKs) ----
await pool.query('DELETE FROM transaction_lines WHERE transaction_id IN (SELECT id FROM transactions WHERE property_id = ?)', [propId])
await pool.query('DELETE FROM transactions WHERE property_id = ?', [propId])
await pool.query('DELETE FROM payments WHERE property_id = ?', [propId])
await pool.query('DELETE FROM properties WHERE id = ?', [propId])
await pool.query("DELETE FROM users WHERE email LIKE '%@t.test'")
await pool.end()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
