// Tenant integrations test: favorites, compare, price alerts (incl. real
// price-drop triggering), inquiries (tenant + owner views), auth walls.
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
const OWNER = { name: 'Ten Owner', email: `tenowner${stamp}@t.test`, password: 'Passw0rd!', role: 'owner' }
const TENANT = { name: 'Ten Tenant', email: `tentenant${stamp}@t.test`, password: 'Passw0rd!', role: 'seeker' }
for (const u of [OWNER, TENANT]) await post('/auth/signup', u)
const ownerToken = (await (await post('/auth/login', { email: OWNER.email, password: OWNER.password })).json()).token
const tenantToken = (await (await post('/auth/login', { email: TENANT.email, password: TENANT.password })).json()).token

// ---- rent property, active ----
const prop = await post(
  '/properties',
  { title: 'Alert Test Flat', description: 'Tenant integration test', area: 'Surulere', purpose: 'rent', propertyType: 'apartment', rentAmount: 1000000, bedrooms: 2, bathrooms: 2 },
  ownerToken,
)
const propertyId = (await prop.json()).property?.id
await patch(`/admin/properties/${propertyId}/status`, { status: 'active' }, (await (async () => {
  await post('/auth/signup', { name: 'Ten Admin', email: `tenadmin${stamp}@t.test`, password: 'Passw0rd!', role: 'owner' })
  await pool.query("UPDATE users SET role = 'admin' WHERE email = ?", [`tenadmin${stamp}@t.test`])
  return (await (await post('/auth/login', { email: `tenadmin${stamp}@t.test`, password: 'Passw0rd!' })).json()).token
})()))
check('active rent property ready', !!propertyId)

// second property for compare
const prop2 = await post(
  '/properties',
  { title: 'Compare Test Flat', description: 'Compare test', area: 'Yaba', purpose: 'rent', propertyType: 'house', rentAmount: 1500000, bedrooms: 3, bathrooms: 3 },
  ownerToken,
)
const property2Id = (await prop2.json()).property?.id

// ---- favorites: toggle on / off ----
const favOn = await (await post(`/properties/${propertyId}/favorite`, {}, tenantToken)).json()
check('favorite saved', favOn.saved === true)
const favOff = await (await post(`/properties/${propertyId}/favorite`, {}, tenantToken)).json()
check('favorite toggled off (undo)', favOff.saved === false)
await post(`/properties/${propertyId}/favorite`, {}, tenantToken) // save again for list test
const favs = await (await get('/favorites', tenantToken)).json()
check('favorites list shows saved property', favs.favorites.some((f) => f.id === propertyId))
check('favorites include image + price fields', favs.favorites.every((f) => 'rentAmount' in f && 'image' in f))

// guests blocked
check('guest cannot favorite (401)', (await post(`/properties/${propertyId}/favorite`, {})).status === 401)

// ---- compare ----
const cmp = await (await post('/properties/compare', { propertyIds: [propertyId, property2Id] }, tenantToken)).json()
check('compare returns both properties', cmp.properties?.length === 2)
check('compare includes detail fields', 'description' in (cmp.properties?.[0] || {}) && 'ownerName' in (cmp.properties?.[0] || {}))
const cmpEmpty = await (await post('/properties/compare', { propertyIds: [] }, tenantToken)).json()
check('compare with empty list returns empty', cmpEmpty.properties?.length === 0)

// ---- price alerts + real price drop ----
const alertOn = await (await post(`/properties/${propertyId}/alert`, { targetPrice: 900000 }, tenantToken)).json()
check('price alert watching', alertOn.watching === true)
const alerts = await (await get('/price-alerts', tenantToken)).json()
check('alerts list shows watch', alerts.alerts.some((a) => a.id === propertyId && a.targetPrice === 900000))

// owner drops the price to 850k — should trigger the tenant's alert (≤ 900k target)
const beforeNotifs = (await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = (SELECT id FROM users WHERE email = ?)', [TENANT.email]))[0][0].n
await patch(`/properties/${propertyId}`, { rentAmount: 850000 }, ownerToken)
const afterNotifs = (await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = (SELECT id FROM users WHERE email = ?)', [TENANT.email]))[0][0].n
check('price drop triggered a notification', Number(afterNotifs) > Number(beforeNotifs), `${beforeNotifs} → ${afterNotifs}`)
const alertAfter = await (await get('/price-alerts', tenantToken)).json()
const triggered = alertAfter.alerts.find((a) => a.id === propertyId)
check('alert marked triggered', triggered?.alertStatus === 'triggered', `got ${triggered?.alertStatus}`)

// owner raises the price — no new notification
const beforeRaise = (await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = (SELECT id FROM users WHERE email = ?)', [TENANT.email]))[0][0].n
await patch(`/properties/${propertyId}`, { rentAmount: 900000 }, ownerToken)
const afterRaise = (await pool.query('SELECT COUNT(*) AS n FROM notifications WHERE user_id = (SELECT id FROM users WHERE email = ?)', [TENANT.email]))[0][0].n
check('price increase does not notify', Number(afterRaise) === Number(beforeRaise))

// alert toggle off
const alertOff = await (await post(`/properties/${propertyId}/alert`, {}, tenantToken)).json()
check('alert toggled off (undo)', alertOff.watching === false)

// ---- inquiries ----
const inq = await post(`/properties/${propertyId}/inquire`, { message: 'Is this still available? Can I view on Saturday?' }, tenantToken)
check('inquiry sent (201)', inq.status === 201, `status ${inq.status}`)
const inqNoMsg = await post(`/properties/${propertyId}/inquire`, { message: '' }, tenantToken)
check('empty message rejected (422)', inqNoMsg.status === 422)

const myInq = await (await get('/my/inquiries', tenantToken)).json()
check('tenant inquiry history', myInq.inquiries.some((i) => i.property_id === propertyId && i.message.includes('Saturday')))

const ownerInq = await (await get('/owner/inquiries', ownerToken)).json()
check('owner sees the lead with contact details', ownerInq.inquiries.some((i) => i.property_id === propertyId && i.email === TENANT.email))

// landlord notified
const ownerNotifs = (await pool.query("SELECT COUNT(*) AS n FROM notifications n JOIN users u ON u.id = n.user_id WHERE u.email = ? AND n.type = 'new_inquiry'", [OWNER.email]))[0][0].n
check('landlord got new-inquiry notification', Number(ownerNotifs) >= 1)

// ownership guard on edit
check('tenant cannot edit owner listing (403)', (await patch(`/properties/${propertyId}`, { title: 'Hacked' }, tenantToken)).status === 403)

// ---- cleanup ----
await pool.query('DELETE FROM notifications WHERE user_id IN (SELECT id FROM users WHERE email LIKE ?)', [`%${stamp}@t.test`])
await pool.query('DELETE FROM price_alerts WHERE property_id IN (?, ?)', [propertyId, property2Id])
await pool.query('DELETE FROM favorites WHERE property_id IN (?, ?)', [propertyId, property2Id])
await pool.query('DELETE FROM inquiries WHERE property_id IN (?, ?)', [propertyId, property2Id])
await pool.query('DELETE FROM properties WHERE id IN (?, ?)', [propertyId, property2Id])
await pool.query("DELETE FROM users WHERE email LIKE ?", [`%${stamp}@t.test`])
await pool.end()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
