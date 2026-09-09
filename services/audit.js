// Append-only admin audit trail. Every financial/administrative mutation
// writes a row: who (admin + IP/device), what (action + entity), and the
// before/after values. Nothing ever updates or deletes rows here.
import pool from '../db/index.js'

export const audit = async (req, action, entityType, entityId, previousValue, newValue) => {
  try {
    await pool.query(
      `INSERT INTO audit_logs (admin_id, action, entity_type, entity_id, previous_value, new_value, ip, user_agent)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        req?.user?.id ?? null,
        action,
        entityType,
        String(entityId ?? ''),
        previousValue === undefined ? null : JSON.stringify(previousValue ?? null),
        newValue === undefined ? null : JSON.stringify(newValue ?? null),
        req?.ip || '',
        String(req?.headers?.['user-agent'] || '').slice(0, 300),
      ],
    )
  } catch (error) {
    // Auditing must never break the request, but the failure is logged.
    console.error('audit write failed:', error.message)
  }
}
