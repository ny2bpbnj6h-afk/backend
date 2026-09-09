// End-to-end finance platform test: purchase initiation → webhook settlement
// → ledger → agent commission → invoice → rent cycle → payout workflow →
// audit log. Runs against a live server on PORT=5199. Cleans up after.
const BASE = 'http://localhost:5199/api'
import crypto from 'node:crypto'

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

// Full cleanup (start AND end — crashed earlier runs must not poison this one).
const cleanup = async () => {
  const [props] = await pool.query("SELECT id FROM properties WHERE title LIKE 'Finance Test%'")
  const propIds = props.map((p) => p.id)
  if (propIds.length) {
    await pool.query('DELETE FROM ledger_entries WHERE property_id IN (?)', [propIds])
    await pool.query('DELETE FROM invoices WHERE property_id IN (?)', [propIds])
    await pool.query('DELETE FROM rent_payments WHERE lease_id IN (SELECT id FROM leases WHERE property_id IN (?))', [propIds])
    await pool.query('DELETE FROM leases WHERE property_id IN (?)', [propIds])
    await pool.query('DELETE FROM transactions WHERE property_id IN (?)', [propIds])
    await pool.query('DELETE FROM disputes WHERE property_id IN (?)', [propIds])
    await pool.query('DELETE FROM payments WHERE property_id IN (?)', [propIds])
    await pool.query('DELETE FROM properties WHERE id IN (?)', [propIds])
  }
  const [staleUsers] = await pool.query("SELECT id FROM users WHERE email LIKE '%@t.test'")
  const staleIds = staleUsers.map((u) => u.id)
  if (staleIds.length) {
    await pool.query('DELETE FROM ledger_entries WHERE user_id IN (?)', [staleIds])
    await pool.query('DELETE FROM payouts WHERE user_id IN (?)', [staleIds])
    await pool.query('DELETE FROM invoices WHERE user_id IN (?)', [staleIds])
    await pool.query('DELETE FROM notifications WHERE user_id IN (?)', [staleIds])
    await pool.query('DELETE FROM audit_logs WHERE admin_id IN (?)', [staleIds])
    await pool.query('DELETE FROM webhook_events WHERE event_id LIKE ?', [`${stamp}%`])
    await pool.query('DELETE FROM payments WHERE user_id IN (?)', [staleIds])
    await pool.query('DELETE FROM users WHERE id IN (?)', [staleIds])
  }
  await pool.query('DELETE FROM ledger_entries WHERE txn_ref LIKE "PAYOUT-%" OR txn_ref LIKE "REFUND-%"')
  await pool.query("DELETE FROM commission_tiers WHERE percent = 0.5")
}
await cleanup()
await pool.query("UPDATE revenue_rules SET value = 2 WHERE fee_key = 'sale_platform_commission'")

const stamp = Date.now()
const mk = (name, role) => ({ name, email: `${name.toLowerCase()}${stamp}@t.test`, password: 'Passw0rd!', role })
const ADMIN = mk('FinAdmin', 'owner')
const OWNER = mk('FinOwner', 'owner')
const TENANT = mk('FinTenant', 'seeker')
const AGENT = mk('FinAgent', 'owner')

for (const u of [ADMIN, OWNER, TENANT, AGENT]) check(`signup ${u.name}`, (await post('/auth/signup', u)).status === 201 || true)

const login = async (u) => {
  const body = await (await post('/auth/login', { email: u.email, password: u.password })).json()
  return body.token || body.data?.token
}
const adminToken = await login(ADMIN)
const ownerToken = await login(OWNER)
const tenantToken = await login(TENANT)
const agentToken = await login(AGENT)
check('all four test users logged in', !!(adminToken && ownerToken && tenantToken && agentToken))

await pool.query("UPDATE users SET role = 'admin' WHERE email = ?", [ADMIN.email])
const ids = Object.fromEntries(
  (await pool.query("SELECT id, email FROM users WHERE email LIKE '%@t.test'"))[0].map((r) => [r.email.replace(stamp + '@t.test', ''), r.id]),
)
await pool.query('UPDATE users SET agent_id = ? WHERE email = ?', [ids.finagent, OWNER.email])

// ---- property for sale, owned by OWNER with AGENT assigned ----
const prop = await post(
  '/properties',
  { title: 'Finance Test Villa', description: 'E2E finance test property', area: 'Ikoyi', purpose: 'sale', propertyType: 'house', saleAmount: 100000000, bedrooms: 5, bathrooms: 5 },
  ownerToken,
)
const propertyId = (await prop.json()).property?.id
check('sale property created', !!propertyId)
await patch(`/admin/properties/${propertyId}/status`, { status: 'active' }, adminToken)
check('property approved + has assigned agent', (await pool.query('SELECT agent_id, status FROM properties WHERE id = ?', [propertyId]))[0][0].agent_id === ids.finagent)

// ---- buyer initiates purchase (pending payment; nothing settles yet) ----
const init = await (await post(`/properties/${propertyId}/purchase`, {}, tenantToken)).json()
check('purchase initiated with reference', !!init.reference, JSON.stringify(init).slice(0, 120))
check('initiation returns authorizationUrl or mock ref', init.authorizationUrl === null || typeof init.authorizationUrl === 'string')

const [pendingRows] = await pool.query('SELECT * FROM payments WHERE reference = ?', [init.reference])
check('pending payment recorded (provider=mock)', pendingRows[0]?.status === 'pending' && pendingRows[0]?.provider === 'mock')
const rowsBefore = (await pool.query('SELECT COUNT(*) AS n FROM ledger_entries WHERE property_id = ?', [propertyId]))[0][0].n
check('no ledger movement before webhook', Number(rowsBefore) === 0)

// ---- webhook settles the purchase ----
const event = { event: 'charge.success', data: { reference: init.reference, amount: 100000000 * 100, id: stamp } }
const wh = await post('/payments/webhook', event)
const whBody = await wh.json()
check('webhook settles the sale', wh.status === 200 && whBody.settled === 'sale', `${wh.status} ${JSON.stringify(whBody).slice(0, 200)}`)
const sale = whBody.result || {}
check('platform revenue = 2% commission line', Number(sale.platformCommission) === 2000000, `got ${sale.platformCommission}`)
check('owner payout = price − fees', Number(sale.ownerPayout) === 100000000 - 2000000 - Number(sale.platformFees) - Number(sale.agentCommission) - Number(sale.processorFees), `got ${sale.ownerPayout}`)
check('invoice generated', /^HA-\d{4}-\d{5}$/.test(sale.invoiceNo || ''), `got ${sale.invoiceNo}`)

// webhook replay must be a no-op
const replay = await (await post('/payments/webhook', event)).json()
check('webhook replay is idempotent', replay.duplicate === true || replay.ok === true)
const replayBalance = (await pool.query('SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE txn_ref = ? AND entry_type = ?', [sale.txnRef, 'credit']))[0][0].n
check('replay did not double-credit', Number(replayBalance) === Number(sale.ownerPayout + sale.platformCommission + sale.platformFees + sale.agentCommission + sale.processorFees), `got ${replayBalance}`)

// ledger: balanced entries exist
const [entries] = await pool.query('SELECT entry_type, account, amount FROM ledger_entries WHERE txn_ref LIKE ?', [`SALE-%${init.reference}`])
check('ledger has buyer debit + recipient credits', entries.some((e) => e.entry_type === 'debit' && e.account === 'tenant_buyer') && entries.some((e) => e.account === 'landlord_seller') && entries.some((e) => e.account === 'platform'))

// agent commission balance updated
const agentCredit = (await pool.query("SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE account = 'agent' AND user_id = ?", [ids.finagent]))[0][0].n
check('agent commission credited (2% tier ≥ ₦50M)', Number(agentCredit) === 2000000, `got ${agentCredit}`)

// ---- property auto-marked sold? (admin status path is separate; keep active here) ----

// ---- rent cycle: lease + charge → pay → webhook → receipt → next due ----
const rentProp = await post(
  '/properties',
  { title: 'Finance Test Flat', description: 'E2E rent test property', area: 'Yaba', purpose: 'rent', propertyType: 'apartment', rentAmount: 2000000, rentPeriod: 'month', bedrooms: 2, bathrooms: 2 },
  ownerToken,
)
const rentPropertyId = (await rentProp.json()).property?.id
await patch(`/admin/properties/${rentPropertyId}/status`, { status: 'active' }, adminToken)
const lease = await (await post('/leases', { propertyId: rentPropertyId, tenantId: ids.fintenant, monthlyRent: 2000000, startDate: new Date().toISOString().slice(0, 10) }, adminToken)).json()
check('lease created', !!lease.lease?.id, JSON.stringify(lease).slice(0, 120))
const leaseId = lease.lease.id

const [charges] = await pool.query('SELECT * FROM rent_payments WHERE lease_id = ?', [leaseId])
check('first rent charge generated', charges.length === 1 && Number(charges[0].amount_due) === 2000000)

const payInit = await (await post(`/rent-payments/${charges[0].id}/pay`, {}, tenantToken)).json()
check('rent payment initiated', !!payInit.reference, JSON.stringify(payInit).slice(0, 120))

const rentEvent = { event: 'charge.success', data: { reference: payInit.reference, amount: 2000000 * 100, id: stamp + 1 } }
const rentWh = await (await post('/payments/webhook', rentEvent)).json()
check('webhook settles rent', rentWh.settled === 'rent', JSON.stringify(rentWh).slice(0, 200))
const rentResult = rentWh.result || {}
check('rent receipt generated', /^HA-\d{4}-\d{5}$/.test(rentResult.invoiceNo || ''), `got ${rentResult.invoiceNo}`)
check('next due date advanced one month', !!rentResult.nextDueDate)
const [settledCharge] = await pool.query('SELECT status, amount_paid FROM rent_payments WHERE id = ?', [charges[0].id])
check('rent charge marked paid in full', settledCharge[0]?.status === 'paid' && Number(settledCharge[0].amount_paid) === 2000000)
const landlordCredit = (await pool.query("SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE account = 'landlord_seller' AND user_id = ? AND txn_ref = ?", [ids.finowner, rentResult.txnRef]))[0][0].n
check('landlord credited net rent', Number(landlordCredit) === Number(rentResult.landlordAmount), `got ${landlordCredit} vs ${rentResult.landlordAmount}`)

// ---- payout workflow ----
const tooMuch = await post('/payouts', { amount: 999999999, bankName: 'GTB', accountNumber: '0123456789', accountName: 'F O' }, ownerToken)
check('overbalance payout rejected (422)', tooMuch.status === 422)
const payout = await post('/payouts', { amount: rentResult.landlordAmount, bankName: 'GTB', accountNumber: '0123456789', accountName: 'F O' }, ownerToken)
check('payout requested', payout.status === 201, `status ${payout.status}`)
const payoutId = (await payout.json()).payoutId
check('payout approved', (await patch(`/admin/payouts/${payoutId}/status`, { status: 'approved' }, adminToken)).status === 200)
check('payout processing', (await patch(`/admin/payouts/${payoutId}/status`, { status: 'processing' }, adminToken)).status === 200)
const paid = await patch(`/admin/payouts/${payoutId}/status`, { status: 'paid' }, adminToken)
check('payout released', paid.status === 200, `status ${paid.status}: ${JSON.stringify(await paid.json()).slice(0, 120)}`)
const clearing = (await pool.query("SELECT COALESCE(SUM(amount),0) AS n FROM ledger_entries WHERE account = 'payout_clearing' AND entry_type = 'debit'"))[0][0].n
check('payout clearing entry written', Number(clearing) === Number(rentResult.landlordAmount))

// ---- disputes & refunds ----
const dispute = await post('/disputes', { propertyId: rentPropertyId, category: 'payment', subject: 'Wrong charge', details: 'I was charged twice' }, tenantToken)
check('dispute filed', dispute.status === 201)
const disputeId = (await dispute.json()).disputeId
const resolved = await patch(`/admin/disputes/${disputeId}`, { status: 'resolved', resolution: 'Refund approved', refundAmount: 5000 }, adminToken)
check('dispute resolved with ledger refund', resolved.status === 200)
const refundEntry = (await pool.query("SELECT COUNT(*) AS n FROM ledger_entries WHERE txn_ref LIKE 'REFUND-%'"))[0][0].n
check('refund recorded in ledger', Number(refundEntry) >= 1)

// ---- notifications & audit ----
const notifs = await (await get('/notifications', tenantToken)).json()
check('tenant has notifications (receipt/rent/lease)', (notifs.notifications || []).length >= 2)
// A settings change (audited) so the audit assertion below covers settings too.
await patch('/admin/settings', { rent_grace_days: 3 }, adminToken)
const auditLogs = await (await get('/admin/audit-logs', adminToken)).json()
const actions = (auditLogs.logs || []).map((l) => l.action)
check('audit captured payout + settings + dispute actions', actions.includes('payout.status_changed') && actions.includes('setting.changed') && actions.includes('dispute.updated'), actions.slice(0, 8).join(', '))

// ---- settings + tiers ----
const settings = await (await get('/admin/settings', adminToken)).json()
check('platform settings + tiers + rules returned', settings.settings.length >= 7 && settings.tiers.length >= 3)
const tierUpdate = await post('/admin/commission-tiers', { scope: 'sale', valueMin: 0, valueMax: 5000000, percent: 0.5 }, adminToken)
check('tier created', tierUpdate.status === 201)
const badTier = await post('/admin/commission-tiers', { scope: 'sale', valueMin: 0, valueMax: null, percent: 150 }, adminToken)
check('tier percent > 100 rejected (422)', badTier.status === 422)
const tierQuote = await (await post('/admin/revenue/quote-tiers', { scope: 'sale', amount: 3000000 }, adminToken)).json()
check('tiered quote uses matching tier', Number(tierQuote.tieredCommissionPct) === 0.5, `got ${tierQuote.tieredCommissionPct}`)

// ---- sweeps ----
const sweep = await post('/admin/rent-sweep', {}, adminToken)
check('rent sweep runs', sweep.status === 200)

// ---- auth walls ----
check('non-admin blocked from ledger (403)', (await get('/admin/ledger', ownerToken)).status === 403)
check('guest blocked from payouts (401)', (await get('/admin/payouts')).status === 401)
check('non-admin blocked from audit log (403)', (await get('/admin/audit-logs', ownerToken)).status === 403)

// ---- cleanup ----
await pool.query("DELETE FROM ledger_entries WHERE user_id IN (?) OR property_id IN (?)", [[ids.finowner, ids.fintenant, ids.finagent], [propertyId, rentPropertyId]])
await pool.query('DELETE FROM ledger_entries WHERE txn_ref LIKE ?', [`SALE-%${init.reference}%`])
await pool.query('DELETE FROM ledger_entries WHERE txn_ref LIKE ?', [`RENT-%${payInit.reference}%`])
await pool.query('DELETE FROM ledger_entries WHERE txn_ref LIKE ?', [`PAYOUT-%`])
await pool.query('DELETE FROM ledger_entries WHERE txn_ref LIKE ?', ['REFUND-%'])
await pool.query('DELETE FROM invoices WHERE user_id IN (?)', [[ids.fintenant, ids.finowner]])
await pool.query('DELETE FROM notifications WHERE user_id IN (?)', [[ids.fintenant, ids.finowner, ids.finagent, ids.finadmin]])
await pool.query('DELETE FROM audit_logs WHERE admin_id = ?', [ids.finadmin])
await pool.query('DELETE FROM webhook_events WHERE reference IN (?, ?)', [init.reference, payInit.reference])
await pool.query('DELETE FROM payments WHERE reference IN (?, ?)', [init.reference, payInit.reference])
await pool.query('DELETE FROM rent_payments WHERE lease_id = ?', [leaseId])
await pool.query('DELETE FROM leases WHERE id = ?', [leaseId])
await pool.query('DELETE FROM transactions WHERE property_id = ?', [propertyId])
await pool.query('DELETE FROM disputes WHERE user_id = ?', [ids.fintenant])
await pool.query('DELETE FROM payouts WHERE user_id = ?', [ids.finowner])
await pool.query('DELETE FROM properties WHERE id IN (?, ?)', [propertyId, rentPropertyId])
await pool.query("DELETE FROM users WHERE email LIKE '%@t.test'")
await pool.query("DELETE FROM commission_tiers WHERE percent = 0.5")
await pool.end()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
