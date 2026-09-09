// Blog: public article feed + reader, admin publishing (drafts stay hidden
// until published). Categories: buying guides, rental tips, market updates,
// investment advice.
import pool from '../db/index.js'
import { audit } from '../services/audit.js'

const CATEGORIES = ['buying_guide', 'rental_tips', 'market_updates', 'investment_advice']

const publicPost = (row) => ({
  id: row.id,
  slug: row.slug,
  title: row.title,
  category: row.category,
  excerpt: row.excerpt,
  content: row.content,
  coverImageUrl: row.cover_image_url,
  views: row.views,
  authorName: row.author_name || 'Housing Agent',
  publishedAt: row.published_at,
  createdAt: row.createdAt,
})

const slugify = (text) =>
  String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 180) || `post-${Date.now()}`

// ---- Public ----
export async function listBlogPosts(req, res) {
  const { category, q, limit } = req.query
  try {
    const where = ["p.status = 'published'"]
    const params = []
    if (category && CATEGORIES.includes(category)) {
      where.push('p.category = ?')
      params.push(category)
    }
    if (q) {
      where.push('(p.title LIKE ? OR p.excerpt LIKE ?)')
      params.push(`%${q}%`, `%${q}%`)
    }
    const max = Math.min(Number(limit) || 50, 100)
    const [rows] = await pool.query(
      `SELECT p.*, u.name AS author_name
       FROM blog_posts p LEFT JOIN users u ON u.id = p.author_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.published_at DESC LIMIT ${max}`,
      params,
    )
    return res.json({ posts: rows.map((row) => ({ ...publicPost(row), content: undefined })) })
  } catch (error) {
    console.error('listBlogPosts failed:', error)
    return res.status(500).json({ error: 'Could not load articles' })
  }
}

export async function getBlogPost(req, res) {
  const { slug } = req.params
  try {
    const [rows] = await pool.query(
      `SELECT p.*, u.name AS author_name FROM blog_posts p
       LEFT JOIN users u ON u.id = p.author_id
       WHERE p.slug = ? AND p.status = 'published'`,
      [slug],
    )
    if (!rows.length) return res.status(404).json({ error: 'Article not found' })
    await pool.query('UPDATE blog_posts SET views = views + 1 WHERE id = ?', [rows[0].id])
    return res.json({ post: publicPost(rows[0]) })
  } catch (error) {
    console.error('getBlogPost failed:', error)
    return res.status(500).json({ error: 'Could not load the article' })
  }
}

// ---- Admin ----
export async function adminListPosts(req, res) {
  try {
    const [rows] = await pool.query(
      `SELECT p.*, u.name AS author_name FROM blog_posts p
       LEFT JOIN users u ON u.id = p.author_id
       ORDER BY p.created_at DESC LIMIT 200`,
    )
    return res.json({ posts: rows.map((row) => ({ ...publicPost(row), content: undefined })) })
  } catch (error) {
    console.error('adminListPosts failed:', error)
    return res.status(500).json({ error: 'Could not load posts' })
  }
}

export async function createBlogPost(req, res) {
  const { title, category, excerpt, content, coverImageUrl, publish } = req.body
  if (!title || !content) return res.status(422).json({ error: 'Title and content are required' })
  if (category && !CATEGORIES.includes(category)) {
    return res.status(422).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` })
  }
  try {
    let slug = slugify(title)
    const [clash] = await pool.query('SELECT id FROM blog_posts WHERE slug = ?', [slug])
    if (clash.length) slug = `${slug}-${Date.now().toString(36)}`
    const [result] = await pool.query(
      `INSERT INTO blog_posts (slug, title, category, excerpt, content, cover_image_url, author_id, status, published_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        slug,
        title,
        category || 'buying_guide',
        excerpt || String(content).slice(0, 300),
        content,
        coverImageUrl || '',
        req.user.id,
        publish ? 'published' : 'draft',
        publish ? new Date() : null,
      ],
    )
    await audit(req, 'blog_post.created', 'blog_post', result.insertId, null, { title, status: publish ? 'published' : 'draft' })
    const [rows] = await pool.query('SELECT * FROM blog_posts WHERE id = ?', [result.insertId])
    return res.status(201).json({ post: publicPost({ ...rows[0], author_name: req.user.name }) })
  } catch (error) {
    console.error('createBlogPost failed:', error)
    return res.status(500).json({ error: 'Could not create the article' })
  }
}

export async function updateBlogPost(req, res) {
  const { postId } = req.params
  const { title, category, excerpt, content, coverImageUrl, status } = req.body
  if (status && !['draft', 'published'].includes(status)) {
    return res.status(422).json({ error: 'status must be draft or published' })
  }
  if (category && !CATEGORIES.includes(category)) {
    return res.status(422).json({ error: `category must be one of: ${CATEGORIES.join(', ')}` })
  }
  try {
    const [current] = await pool.query('SELECT * FROM blog_posts WHERE id = ?', [postId])
    if (!current.length) return res.status(404).json({ error: 'Article not found' })
    const post = current[0]
    await pool.query(
      `UPDATE blog_posts SET
         title = COALESCE(?, title),
         category = COALESCE(?, category),
         excerpt = COALESCE(?, excerpt),
         content = COALESCE(?, content),
         cover_image_url = COALESCE(?, cover_image_url),
         status = COALESCE(?, status),
         published_at = COALESCE(published_at, ?)
       WHERE id = ?`,
      [title || null, category || null, excerpt || null, content || null, coverImageUrl || null, status || null, status === 'published' ? new Date() : null, postId],
    )
    await audit(req, 'blog_post.updated', 'blog_post', postId, { status: post.status, title: post.title }, { status: status || post.status, title: title || post.title })
    return res.json({ ok: true })
  } catch (error) {
    console.error('updateBlogPost failed:', error)
    return res.status(500).json({ error: 'Could not update the article' })
  }
}

export async function deleteBlogPost(req, res) {
  const { postId } = req.params
  try {
    const [current] = await pool.query('SELECT * FROM blog_posts WHERE id = ?', [postId])
    if (!current.length) return res.status(404).json({ error: 'Article not found' })
    await pool.query('DELETE FROM blog_posts WHERE id = ?', [postId])
    await audit(req, 'blog_post.deleted', 'blog_post', postId, { title: current[0].title }, null)
    return res.json({ ok: true })
  } catch (error) {
    console.error('deleteBlogPost failed:', error)
    return res.status(500).json({ error: 'Could not delete the article' })
  }
}
