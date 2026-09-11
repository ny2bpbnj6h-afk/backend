// Leads + messaging test: contact capture, team notification, admin CRM
// (New -> Contacted -> Closed), customer history, outbox queue, auth walls.
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

const stamp = Date.now()
const EMAIL = `lead${stamp}@t.test`
const ADMIN = { name: 'Lead Admin', email: `leadadmin${stamp}@t.test`, password: 'Passw0rd!', role: 'owner' }

// ---- admin setup FIRST (the capture flow alerts every active admin, so
// the account must exist before submissions for notification checks) ----
await post('/auth/signup', ADMIN)
await pool.query("UPDATE users SET role = 'admin' WHERE email = ?", [ADMIN.email])
const adminToken = (await (await post('/auth/login', { email: ADMIN.email, password: ADMIN.password })).json()).token

// ---- public capture (no auth) ----
const sub1 = await post('/contact', { name: 'Ada Obi', email: EMAIL, phone: '08031234567', role: 'Tenant', message: 'I need a 2-bedroom in Lekki under 2 million per year. Please help.', source: 'contact_page' })
check('public submission accepted', sub1.status === 201, `status=${sub1.status}`)
const sub1Body = await sub1.json()
const leadId = sub1Body.lead?.id
check('lead created with New status', sub1Body.lead?.status === 'new')

// signed-in submission links the account
await post('/auth/signup', { name: 'Lead User', email: `leaduser${stamp}@t.test`, password: 'Passw0rd!', role: 'seeker' })
const userToken = (await (await post('/auth/login', { email: `leaduser${stamp}@t.test`, password: 'Passw0rd!' })).json()).token
const sub2 = await post('/contact', { name: 'Lead User', email: `leaduser${stamp}@t.test`, role: 'Landlord', message: 'I want to list my duplex, what are the fees?' }, userToken)
check('signed-in submission accepted', sub2.status === 201)

// ---- validation walls ----
const bad1 = await post('/contact', { name: 'X', email: 'not-an-email', message: 'hi' })
check('invalid email rejected (422)', bad1.status === 422, `status=${bad1.status}`)
const bad2 = await post('/contact', { name: 'Ada Obi', email: EMAIL, message: 'no role but short' })
check('missing role falls back (201)', bad2.status === 201, `status=${bad2.status}`)
const bad3 = await post('/contact', { name: 'Ada Obi', email: EMAIL, message: 'hi' })
check('too-short message rejected (422)', bad3.status === 422, `status=${bad3.status}`)

const tenantToken = userToken // non-admin for auth walls

// ---- admin CRM ----
const list = await (await get('/admin/leads', adminToken)).json()
check('admin sees the leads', list.leads.some((l) => l.id === leadId))
check('status counts present', typeof list.counts?.new === 'number')

const filtered = await (await get('/admin/leads?status=new', adminToken)).json()
check('status filter works', filtered.leads.every((l) => l.status === 'new'))
const searched = await (await get(`/admin/leads?q=${encodeURIComponent('duplex')}`, adminToken)).json()
check('search matches message', searched.leads.some((l) => l.email === `leaduser${stamp}@t.test`))

// status flow: new -> contacted -> closed
const step1 = await patch(`/admin/leads/${leadId}`, { status: 'contacted' }, adminToken)
check('new -> contacted', step1.status === 200 && (await step1.json()).lead.status === 'contacted')
const step2 = await patch(`/admin/leads/${leadId}`, { status: 'closed' }, adminToken)
check('contacted -> closed', step2.status === 200 && (await step2.json()).lead.status === 'closed')
const badMove = await patch(`/admin/leads/${leadId}`, { status: 'contacted' }, adminToken)
check('closed -> contacted blocked (409)', badMove.status === 409, `status=${badMove.status}`)
const reopen = await patch(`/admin/leads/${leadId}`, { status: 'new' }, adminToken)
check('closed -> new (reopen) allowed', reopen.status === 200)
const bogus = await patch(`/admin/leads/${leadId}`, { status: 'won' }, adminToken)
check('bogus status rejected (422)', bogus.status === 422, `status=${bogus.status}`)
const notes = await patch(`/admin/leads/${leadId}`, { adminNotes: 'Interested in Lekki; call evenings.' }, adminToken)
check('admin notes saved', (await notes.json()).lead.adminNotes.includes('evenings'))

// detail + history (same email accepted twice: sub1 + bad2; bad3 was rejected)
const detail = await (await get(`/admin/leads/${leadId}`, adminToken)).json()
check('lead detail loads', detail.lead?.id === leadId)
check('customer history linked by email', detail.history.length === 1, `history=${detail.history.length}`)

// ---- outbox: the team alert was queued ----
const outbox = await (await get('/admin/outbox?channel=email', adminToken)).json()
check('team alert queued in outbox', outbox.messages.some((m) => m.template === 'lead_new' && m.recipient === ADMIN.email))
check('outbox stays pending without SMTP', outbox.messages.filter((m) => m.template === 'lead_new').every((m) => m.status === 'pending'))

// in-app notification for the admin
const notifs = await (await get('/notifications', adminToken)).json()
check('admin got in-app lead notification', (notifs.notifications || []).some((n) => n.type === 'lead_new'))

// ---- auth walls ----
check('leads list requires admin', (await get('/admin/leads', tenantToken)).status === 403)
check('lead detail requires admin', (await get(`/admin/leads/${leadId}`, tenantToken)).status === 403)
check('lead update requires admin', (await patch(`/admin/leads/${leadId}`, { status: 'closed' }, tenantToken)).status === 403)
check('outbox requires admin', (await get('/admin/outbox', tenantToken)).status === 403)

// ---- audit trail ----
const [audits] = await pool.query("SELECT * FROM audit_logs WHERE action = 'lead.status_changed' AND entity_id = ? ORDER BY id DESC LIMIT 1", [String(leadId)])
check('status change audited', audits.length > 0)

// ---- cleanup ----
await pool.query('DELETE FROM contact_messages WHERE email LIKE ?', [`%${stamp}@t.test`])
await pool.query('DELETE FROM outbox WHERE template = ?', ['lead_new'])
await pool.query('DELETE FROM notifications WHERE type = ?', ['lead_new'])
await pool.query('DELETE FROM users WHERE email LIKE ?', [`%${stamp}@t.test`])
await pool.query("DELETE FROM audit_logs WHERE action = 'lead.status_changed' AND admin_id IS NULL")

console.log(`\n${passed}/${passed + failed} checks passed`)
process.exit(failed ? 1 : 0)
