// One-shot script: applies backend/schema.sql (idempotent) and verifies the DB connection.
// Run with: npm run db:init  (inside backend/)
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import 'dotenv/config'
import pool from '../db/index.js'

const schemaPath = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'schema.sql',
)

try {
  const schema = await readFile(schemaPath, 'utf8')
  // Run one statement at a time: the pool doesn't enable multipleStatements
  // (safer), and mysql2 can't run several statements in one query call.
  const statements = schema
    .split(';')
    .map((statement) => statement.replace(/^\s*--[^\n]*$/gm, '').trim())
    .filter(Boolean)
  for (const statement of statements) {
    await pool.query(statement, [])
  }
  const [rows] = await pool.query('SELECT COUNT(*) AS users FROM users')
  console.log(`✓ schema applied (${statements.length} statements, ${rows[0].users} existing users)`)
  await pool.end()
  process.exit(0)
} catch (error) {
  console.error('✗ DB init failed:', error.message)
  process.exit(1)
}
