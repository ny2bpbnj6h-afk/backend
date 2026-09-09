// Removes test/demo users created during development.
// Usage: npm run clean:test-users  (inside backend/)
// Users with @test.com / @example.com emails are treated as test data.
import 'dotenv/config'
import pool from '../db/index.js'

try {
  const [rows] = await pool.query(
    "SELECT id, email, provider FROM users WHERE email LIKE '%@test.com' OR email LIKE '%@example.com'",
  )
  if (!rows.length) {
    console.log('No test users found.')
  } else {
    console.log('Removing test users:')
    rows.forEach((row) => console.log(`  - #${row.id} ${row.email} (${row.provider})`))
    await pool.query(
      "DELETE FROM users WHERE email LIKE '%@test.com' OR email LIKE '%@example.com'",
    )
    console.log(`✓ removed ${rows.length} test user(s)`)
  }
  await pool.end()
  process.exit(0)
} catch (error) {
  console.error('✗ cleanup failed:', error.message)
  process.exit(1)
}
