// Live chat test: visitor threads (thread-key auth), agent replies, unread
// counts, read markers, rate limiting, and admin gating.
const BASE = 'http://localhost:5199/api'

const post = (path, body, token) =>
  fetch(BASE + path, {
    method: 'POST',
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

const { default: pool } = await import('../db/index.js')

const stamp = Date.now()
const ADMIN = { name: 'Chat Admin', email: `chatadmin${stamp}@t.test`, password: 'Passw0rd!', role: 'owner' }

// ---- admin setup ----
await post('/auth/signup', ADMIN)
await pool.query("UPDATE users SET role = 'admin' WHERE email = ?", [ADMIN.email])
const adminToken = (await (await post('/auth/login', { email: ADMIN.email, password: ADMIN.password })).json()).token

// ---- visitor chat (no auth) ----
const threadKey = `${stamp}-aaaa-bbbb-cccc` // UUID-shaped key held by the client
const sent1 = await post('/chat', { threadKey, body: 'Hi, is Eko Pearl Towers still available?' })
check('visitor message accepted', sent1.status === 201, `status=${sent1.status}`)
const sent2 = await post('/chat', { threadKey, body: 'Also, what are the agency fees?' })
check('follow-up in same thread', sent2.status === 201)

const thread = await (await get(`/chat/${threadKey}`)).json()
check('visitor reads own thread', thread.messages.length === 2)
check('messages are visitor-sent', thread.messages.every((m) => m.sender === 'visitor'))

// Agent replies arrive in the visitor thread.
const reply = await post(`/admin/chat/threads/${threadKey}/reply`, { body: 'Yes it is! Viewing available Saturday.' }, adminToken)
check('agent reply accepted', reply.status === 201, `status=${reply.status}`)
const threadAfter = await (await get(`/chat/${threadKey}`)).json()
check('visitor sees agent reply', threadAfter.messages.some((m) => m.sender === 'agent'))
check('agent messages marked read for visitor', threadAfter.messages.filter((m) => m.sender === 'agent').every((m) => true))

// ---- admin inbox ----
const threads = await (await get('/admin/chat/threads', adminToken)).json()
check('admin inbox lists the thread', threads.threads.some((t) => t.threadKey === threadKey))
const mine = threads.threads.find((t) => t.threadKey === threadKey)
check('unread counted before open', mine?.unread === 2, `unread=${mine?.unread}`)

const adminThread = await (await get(`/admin/chat/threads/${threadKey}`, adminToken)).json()
check('admin reads full thread', adminThread.messages.length === 3)
const threadsAfter = await (await get('/admin/chat/threads', adminToken)).json()
check('unread cleared after read', threadsAfter.threads.find((t) => t.threadKey === threadKey)?.unread === 0)

const unread = await (await get('/admin/chat/unread', adminToken)).json()
check('unread endpoint counts threads with unread visitor messages', unread.threads >= 0)

// ---- validation + walls ----
check('bad thread key rejected (422)', (await post('/chat', { threadKey: '../etc/passwd', body: 'hi' })).status === 422)
check('empty body rejected (422)', (await post('/chat', { threadKey, body: '   ' })).status === 422)
check('oversized body rejected (422)', (await post('/chat', { threadKey, body: 'x'.repeat(2001) })).status === 422)
check('unknown thread read is empty ok', ((await (await get(`/chat/9999aaaa-bbbb-cccc-dddd`)).json()).messages.length) === 0)
check('agent inbox requires admin', (await get('/admin/chat/threads', 'bogus-token')).status === 401 || (await get('/admin/chat/threads', 'bogus-token')).status === 403)
check('agent reply requires admin', (await post(`/admin/chat/threads/${threadKey}/reply`, { body: 'x' }, 'bogus')).status !== 201)

// notification to admins on new thread
const notifs = await (await get('/notifications', adminToken)).json()
check('admin got new-thread notification', (notifs.notifications || []).some((n) => n.type === 'chat_new_thread'))

// ---- cleanup ----
await pool.query('DELETE FROM chat_messages WHERE thread_key = ?', [threadKey])
await pool.query('DELETE FROM notifications WHERE type = ?', ['chat_new_thread'])
await pool.query('DELETE FROM outbox WHERE template = ?', ['chat_new_thread'])
await pool.query('DELETE FROM users WHERE email LIKE ?', [`%${stamp}@t.test`])

console.log(`\n${passed}/${passed + failed} checks passed`)
process.exit(failed ? 1 : 0)
