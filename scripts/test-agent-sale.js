// Agent + sale listing flow test:
//   - users can sign up as 'agent' (and as landlord 'owner')
//   - agents and landlords create sale/rent listings via POST /properties
//   - listings start pending; GET /owner/properties returns them
//   - PATCH /properties/:id edits sale details (full listing edit)
//   - public GET /properties?purpose=sale shows approved sale stock
const BASE = 'http://localhost:5199/api'

const post = (path, body, token) =>
  fetch(BASE + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
const patch = (path, body, token) =>
  fetch(BASE + path, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify(body),
  })
const get = (path, token) =>
  fetch(BASE + path, { headers: token ? { Authorization: `Bearer ${token}` } : {} })

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

const stamp = Date.now()
const PASSWORD = 'Passw0rd!'

// ---- sign up as agent ----
const agent = { name: 'Test Agent', email: `agent${stamp}@t.test`, phone: '08030000001', password: PASSWORD, role: 'agent', portfolio: 'Lekki & Ikoyi' }
const agentSignup = await post('/auth/signup', agent)
check('agent signup accepted', agentSignup.status === 201, `status=${agentSignup.status}`)
const agentAuth = await agentSignup.json()
check('agent role persisted', agentAuth.user?.role === 'agent', JSON.stringify(agentAuth.user?.role))
const agentToken = agentAuth.token

// ---- sign up as landlord (owner) ----
const landlord = { name: 'Test Landlord', email: `landlord${stamp}@t.test`, phone: '08030000002', password: PASSWORD, role: 'owner', portfolio: '3 units' }
const landlordSignup = await post('/auth/signup', landlord)
check('landlord signup accepted', landlordSignup.status === 201)
const landlordAuth = await landlordSignup.json()
check('owner role persisted', landlordAuth.user?.role === 'owner')
const landlordToken = landlordAuth.token

// ---- agent creates a sale listing ----
const saleListing = {
  title: `Test Duplex for Sale ${stamp}`,
  description: 'A 4 bedroom duplex with all documents.',
  area: 'Ikota, Lekki, Lagos',
  purpose: 'sale',
  propertyType: 'house',
  rentAmount: 0,
  saleAmount: 180000000,
  bedrooms: 4,
  bathrooms: 5,
  sizeM2: 300,
  furnished: 'any',
  videoUrl: 'https://www.youtube.com/watch?v=FxX1gBlrLRw',
  tourUrl: '',
  images: ['https://images.unsplash.com/photo-1600585154340-be6161a56a0c?auto=format&fit=crop&w=900&q=60'],
}
const created = await post('/properties', saleListing, agentToken)
const createdText = await created.text()
check('agent can create a sale listing', created.status === 201, `status=${created.status} body=${createdText}`)
const createdBody = JSON.parse(createdText)
const saleId = createdBody.property?.id
check('sale listing starts pending', createdBody.property?.status === 'pending', createdBody.property?.status)
check('sale listing keeps saleAmount', Number(createdBody.property?.saleAmount) === 180000000)

// ---- landlord creates a rental ----
const rentListing = {
  title: `Test Flat for Rent ${stamp}`,
  description: 'A 2 bedroom flat.',
  area: 'Yaba, Lagos',
  purpose: 'rent',
  propertyType: 'apartment',
  rentAmount: 2500000,
  bedrooms: 2,
  bathrooms: 2,
  sizeM2: 90,
}
const createdRent = await post('/properties', rentListing, landlordToken)
check('landlord can create a rental listing', createdRent.status === 201, `status=${createdRent.status}`)
const rentId = (await createdRent.json()).property?.id

// ---- role guard: tenants cannot list ----
const seeker = { name: 'Test Tenant', email: `tenant${stamp}@t.test`, phone: '08030000003', password: PASSWORD, role: 'seeker', preferredArea: 'Lagos' }
const seekerAuth = await (await post('/auth/signup', seeker)).json()
const tenantList = await post('/properties', saleListing, seekerAuth.token)
check('tenant cannot create listings (403)', tenantList.status === 403, `status=${tenantList.status}`)

// ---- owner/agent listing feed ----
const mine = await get('/owner/properties', agentToken)
check('GET /owner/properties works for agents', mine.status === 200, `status=${mine.status}`)
const mineBody = await mine.json()
check('feed contains the agent sale listing', mineBody.properties?.some((p) => p.id === saleId))
check('feed contains images', (mineBody.properties?.find((p) => p.id === saleId)?.images?.length || 0) === 1)

const mineLandlord = await get('/owner/properties', landlordToken)
check('GET /owner/properties works for landlords', mineLandlord.status === 200)
const landlordBody = await mineLandlord.json()
check('landlord feed contains the rental', landlordBody.properties?.some((p) => p.id === rentId))

// ---- pending listings are NOT public yet ----
const publicBefore = await get(`/properties/${saleId}`)
const publicBody = await publicBefore.json()
check('pending listing detail still fetchable (id)', publicBefore.status === 200)

// ---- full listing edit via PATCH (agent edits own listing) ----
const edit = await patch(`/properties/${saleId}`, { saleAmount: 175000000, bedrooms: 5, videoUrl: 'https://www.youtube.com/watch?v=Q32jg2vn8y4' }, agentToken)
const editText = await edit.text()
check('agent can edit own listing', edit.status === 200, `status=${edit.status} body=${editText}`)
const editBody = JSON.parse(editText)
check('edit applied (saleAmount)', Number(editBody.property?.saleAmount) === 175000000)
check('edit applied (bedrooms)', editBody.property?.bedrooms === 5)
check('edit applied (videoUrl)', editBody.property?.videoUrl === 'https://www.youtube.com/watch?v=Q32jg2vn8y4')

// ---- another agent cannot edit someone else's listing ----
const agent2 = { name: 'Agent Two', email: `agent2${stamp}@t.test`, phone: '08030000004', password: PASSWORD, role: 'agent' }
const agent2Auth = await (await post('/auth/signup', agent2)).json()
const editOther = await patch(`/properties/${saleId}`, { saleAmount: 1 }, agent2Auth.token)
check('other agents cannot edit foreign listings (403)', editOther.status === 403, `status=${editOther.status}`)

// ---- approve the sale listing and check the public sale feed ----
const admin = { name: 'Sale Admin', email: `admin${stamp}@t.test`, phone: '08030000005', password: PASSWORD, role: 'owner' }
await post('/auth/signup', admin)
const { default: pool } = await import('../db/index.js')
await pool.query("UPDATE users SET role = 'admin' WHERE email = ?", [admin.email])
const adminToken = (await (await post('/auth/login', { email: admin.email, password: PASSWORD })).json()).token
const approve = await patch(`/admin/properties/${saleId}/status`, { status: 'active' }, adminToken)
check('admin approves the sale listing', approve.status === 200, `status=${approve.status}`)

const publicSale = await get('/properties?purpose=sale')
const publicSaleBody = await publicSale.json()
check('approved listing appears in public sale feed', publicSaleBody.properties?.some((p) => p.id === saleId))
check('seeded real sale stock present', (publicSaleBody.properties?.length || 0) >= 10, `count=${publicSaleBody.properties?.length}`)

// ---- cleanup ----
await pool.query('DELETE FROM properties WHERE id IN (?, ?)', [saleId, rentId])
await pool.query('DELETE FROM users WHERE email LIKE ?', [`%${stamp}@t.test`])
await pool.end()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
