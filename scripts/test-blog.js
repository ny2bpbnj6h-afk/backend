// Blog API test: public feed + filters + view counting, admin CRUD with
// draft/publish workflow, permission walls. Runs against PORT=5199.
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
const del = (path, token) =>
  fetch(BASE + path, { method: 'DELETE', headers: token ? { Authorization: `Bearer ${token}` } : {} })

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
const ADMIN = { name: 'Blog Admin', email: `blogadmin${stamp}@t.test`, password: 'Passw0rd!', role: 'owner' }
const USER = { name: 'Blog User', email: `bloguser${stamp}@t.test`, password: 'Passw0rd!', role: 'seeker' }
for (const u of [ADMIN, USER]) await post('/auth/signup', u)
await pool.query("UPDATE users SET role = 'admin' WHERE email = ?", [ADMIN.email])
const adminToken = (await (await post('/auth/login', { email: ADMIN.email, password: ADMIN.password })).json()).token
const userToken = (await (await post('/auth/login', { email: USER.email, password: USER.password })).json()).token

// ---- public feed (seeded articles) ----
const feed = await (await get('/blog')).json()
check('public feed returns seeded articles', (feed.posts || []).length >= 4, `got ${feed.posts?.length}`)
check('feed strips content bodies (cards only)', feed.posts.every((p) => p.content === undefined))

// category filter
const guides = await (await get('/blog?category=buying_guide')).json()
check('category filter works', guides.posts.length >= 1 && guides.posts.every((p) => p.category === 'buying_guide'))

// search
const search = await (await get('/blog?q=Lagos')).json()
check('search matches titles/excerpts', search.posts.length >= 1)

// drafts are hidden
const draft = await (await post('/admin/blog', { title: `Secret Draft ${stamp}`, content: 'Hidden content.', category: 'rental_tips', publish: false }, adminToken)).json()
check('draft created', draft.post?.status === 'draft', JSON.stringify(draft).slice(0, 120))
const feedAfter = await (await get('/blog')).json()
check('draft hidden from public feed', !feedAfter.posts.some((p) => p.id === draft.post.id))

// ---- article reader + view counting ----
const published = feed.posts[0]
const read1 = (await (await get(`/blog/${published.slug}`)).json()).post
check('article reader returns full content', typeof read1.content === 'string' && read1.content.length > 100)
const read2 = (await (await get(`/blog/${published.slug}`)).json()).post
check('views increment on read', read2.views === read1.views + 1, `${read1.views} → ${read2.views}`)
const missing = await get('/blog/does-not-exist')
check('unknown slug → 404', missing.status === 404)

// ---- admin CRUD ----
const article = await (await post('/admin/blog', { title: `Test Article ${stamp}`, content: 'First paragraph.\n\nSecond paragraph.', category: 'investment_advice', excerpt: 'Test excerpt', publish: true }, adminToken)).json()
check('publish immediately', article.post?.status === 'published' && /^test-article/.test(article.post.slug))
const publishedFeed = await (await get('/blog?category=investment_advice')).json()
check('published article visible publicly', publishedFeed.posts.some((p) => p.id === article.post.id))

const upd = await patch(`/admin/blog/${article.post.id}`, { title: `Renamed ${stamp}`, status: 'draft' }, adminToken)
check('update + unpublish', upd.status === 200)
const hidden = await (await get(`/blog/${article.post.slug}`)).json()
check('unpublished article 404s publicly', hidden.error === 'Article not found')
const invalid = await patch(`/admin/blog/${article.post.id}`, { status: 'bogus' }, adminToken)
check('invalid status rejected (422)', invalid.status === 422)
const badCat = await patch(`/admin/blog/${article.post.id}`, { category: 'bogus' }, adminToken)
check('invalid category rejected (422)', badCat.status === 422)

// ---- permission walls ----
check('non-admin blocked from admin blog list (403)', (await get('/admin/blog', userToken)).status === 403)
check('non-admin blocked from creating (403)', (await post('/admin/blog', { title: 'X', content: 'Y' }, userToken)).status === 403)
check('guest blocked from creating (401)', (await post('/admin/blog', { title: 'X', content: 'Y' })).status === 401)

// ---- cleanup ----
check('delete works', (await del(`/admin/blog/${article.post.id}`, adminToken)).status === 200)
check('deleted draft gone', (await del(`/admin/blog/${draft.post.id}`, adminToken)).status === 200)
const auditRows = (await pool.query("SELECT COUNT(*) AS n FROM audit_logs WHERE action LIKE 'blog_post.%'"))[0][0].n
check('blog actions audited', Number(auditRows) >= 4, `got ${auditRows}`)

await pool.query("DELETE FROM users WHERE email IN (?, ?)", [ADMIN.email, USER.email])
await pool.end()

console.log(`\n${passed} passed, ${failed} failed`)
process.exit(failed ? 1 : 0)
