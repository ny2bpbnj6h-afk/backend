// Live chat: visitors (and signed-in users) chat with the support team via a
// floating widget. The visitor holds an unguessable thread_key (UUID) in
// localStorage — that key IS the credential for their thread. Agents work
// from the admin panel. Long-poll friendly: reads are cheap; the widget polls
// every ~4s while open.
import crypto from 'node:crypto'
import pool from '../db/index.js'
import { audit } from '../services/audit.js'
import { processOutbox, notifyAdmins } from '../services/messaging.js'

const MAX_LENGTH = 2000
const WINDOW_MS = 10_000
const WINDOW_MAX = 8

// Simple in-memory rate limiter per thread (per server process).
const recentPosts = new Map()
const rateLimited = (threadKey) => {
  const now = Date.now()
  const entry = recentPosts.get(threadKey)
  if (!entry || now > entry.resetAt) {
    recentPosts.set(threadKey, { count: 1, resetAt: now + WINDOW_MS })
    return false
  }
  entry.count += 1
  return entry.count > WINDOW_MAX
}

const publicMessage = (row) => ({
  id: row.id,
  sender: row.sender,
  senderName: row.sender_name,
  body: row.body,
  createdAt: row.created_at,
})

// ============================================================ VISITOR SIDE ===
// Get-or-create semantics: POSTing with a new key opens the thread. The key
// must be UUID-shaped (64-bit-safe, unguessable); rejects traversal attempts.
export async function postChatMessage(req, res) {
  let { threadKey, body, name } = req.body
  if (!threadKey || typeof threadKey !== 'string' || !/^[a-f0-9-]{10,64}$/i.test(threadKey)) {
    return res.status(422).json({ error: 'Invalid thread key' })
  }
  const text = String(body ?? '').trim()
  if (!text) return res.status(422).json({ error: 'Message is required' })
  if (text.length > MAX_LENGTH) return res.status(422).json({ error: `Message must be at most ${MAX_LENGTH} characters` })
  if (rateLimited(threadKey)) return res.status(429).json({ error: 'Sending too fast — please wait a moment' })

  try {
    // Link to the account when signed in; otherwise a plain visitor thread.
    const userId = req.user?.id ?? null
    const senderName = String(name ?? req.user?.name ?? 'Visitor').slice(0, 120) || 'Visitor'

    const [result] = await pool.query(
      `INSERT INTO chat_messages (thread_key, user_id, sender, sender_name, body)
       VALUES (?, ?, ?, 'visitor', ?)`,
      [threadKey, userId, senderName, text],
    )

    // First visitor message in the thread -> alert the team (best-effort).
    const [[{ total }]] = await pool.query(
      'SELECT COUNT(*) AS total FROM chat_messages WHERE thread_key = ? AND sender = ?',
      [threadKey, 'visitor'],
    )
    if (total === 1) {
      await notifyAdmins('chat_new_thread', 'New chat started', `${senderName}: ${text.slice(0, 200)}`, 'chat', threadKey === undefined ? null : null)
      processOutbox(5).catch(() => {})
    }

    return res.status(201).json({ message: publicMessage({ ...{ sender: 'visitor', sender_name: senderName }, id: result.insertId, body: text, created_at: new Date() }) })
  } catch (error) {
    console.error('postChatMessage failed:', error)
    return res.status(500).json({ error: 'Could not send the message' })
  }
}

// Visitor fetches their thread (poll endpoint). Marks agent messages read.
export async function getChatThread(req, res) {
  const { threadKey } = req.params
  if (!threadKey || !/^[a-f0-9-]{10,64}$/i.test(threadKey)) {
    return res.status(422).json({ error: 'Invalid thread key' })
  }
  try {
    const [messages] = await pool.query(
      `SELECT * FROM chat_messages WHERE thread_key = ? ORDER BY created_at ASC, id ASC LIMIT 300`,
      [threadKey],
    )
    await pool.query(
      `UPDATE chat_messages SET read_by_visitor_at = NOW()
       WHERE thread_key = ? AND sender = 'agent' AND read_by_visitor_at IS NULL`,
      [threadKey],
    )
    return res.json({ messages: messages.map(publicMessage) })
  } catch (error) {
    console.error('getChatThread failed:', error)
    return res.status(500).json({ error: 'Could not load the conversation' })
  }
}

// ============================================================= AGENT SIDE ====
// Admin inbox: one row per thread with last message + unread counts.
export async function listChatThreads(req, res) {
  try {
    const [threads] = await pool.query(
      `SELECT c.thread_key,
              MAX(c.created_at) AS last_at,
              SUM(c.sender = 'visitor') AS visitor_count,
              SUM(c.sender = 'agent') AS agent_count,
              SUM(c.sender = 'visitor' AND c.read_by_admin_at IS NULL) AS unread
         FROM chat_messages c
        GROUP BY c.thread_key
        ORDER BY last_at DESC
        LIMIT 200`,
    )
    // Latest message per thread (correlated subquery is fine at this scale).
    const [latest] = await pool.query(
      `SELECT c.thread_key, c.sender, c.sender_name, c.body, c.created_at
         FROM chat_messages c
         JOIN (SELECT thread_key, MAX(id) AS max_id FROM chat_messages GROUP BY thread_key) m
           ON m.max_id = c.id`,
    )
    const lastByThread = new Map(latest.map((row) => [row.thread_key, row]))
    const [users] = await pool.query(
      `SELECT DISTINCT c.thread_key, u.name, u.email
         FROM chat_messages c JOIN users u ON u.id = c.user_id
        WHERE c.user_id IS NOT NULL`,
    )
    const userByThread = new Map()
    for (const row of users) if (!userByThread.has(row.thread_key)) userByThread.set(row.thread_key, row)

    return res.json({
      threads: threads.map((thread) => ({
        threadKey: thread.thread_key,
        userName: userByThread.get(thread.thread_key)?.name || lastByThread.get(thread.thread_key)?.sender_name || 'Visitor',
        userEmail: userByThread.get(thread.thread_key)?.email || null,
        lastMessage: lastByThread.get(thread.thread_key)?.body || '',
        lastSender: lastByThread.get(thread.thread_key)?.sender || '',
        lastAt: thread.last_at,
        unread: Number(thread.unread) || 0,
      })),
    })
  } catch (error) {
    console.error('listChatThreads failed:', error)
    return res.status(500).json({ error: 'Could not load chat threads' })
  }
}

// Agent reads one thread (marks visitor messages read).
export async function getAdminChatThread(req, res) {
  const { threadKey } = req.params
  try {
    const [messages] = await pool.query(
      `SELECT * FROM chat_messages WHERE thread_key = ? ORDER BY created_at ASC, id ASC LIMIT 500`,
      [threadKey],
    )
    await pool.query(
      `UPDATE chat_messages SET read_by_admin_at = NOW()
       WHERE thread_key = ? AND sender = 'visitor' AND read_by_admin_at IS NULL`,
      [threadKey],
    )
    return res.json({ messages: messages.map(publicMessage) })
  } catch (error) {
    console.error('getAdminChatThread failed:', error)
    return res.status(500).json({ error: 'Could not load the thread' })
  }
}

// Agent reply (from the admin panel).
export async function replyToChatThread(req, res) {
  const { threadKey } = req.params
  const text = String(req.body?.body ?? '').trim()
  if (!text) return res.status(422).json({ error: 'Message is required' })
  if (text.length > MAX_LENGTH) return res.status(422).json({ error: `Message must be at most ${MAX_LENGTH} characters` })
  try {
    const [result] = await pool.query(
      `INSERT INTO chat_messages (thread_key, sender, sender_name, body)
       VALUES (?, 'agent', ?, ?)`,
      [threadKey, req.user?.name || 'Housing Agent Team', text],
    )
    await audit(req, 'chat.replied', 'chat', threadKey, null, { length: text.length })
    return res.status(201).json({ message: publicMessage({ id: result.insertId, sender: 'agent', sender_name: req.user?.name || 'Housing Agent Team', body: text, created_at: new Date() }) })
  } catch (error) {
    console.error('replyToChatThread failed:', error)
    return res.status(500).json({ error: 'Could not send the reply' })
  }
}

// Unread badge count for the admin nav.
export async function chatUnreadCount(req, res) {
  try {
    const [[{ total }]] = await pool.query(
      `SELECT COUNT(DISTINCT thread_key) AS total
         FROM chat_messages
        WHERE sender = 'visitor' AND read_by_admin_at IS NULL`,
    )
    return res.json({ threads: Number(total) || 0 })
  } catch (error) {
    console.error('chatUnreadCount failed:', error)
    return res.status(500).json({ error: 'Could not count unread chats' })
  }
}

export const newThreadKey = () => crypto.randomUUID()
