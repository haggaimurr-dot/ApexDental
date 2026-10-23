const roles = { admin: '管理员', frontdesk: '前台' }
function createConfirmations(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS appointment_confirmations (
    id INTEGER PRIMARY KEY, appointment_id TEXT NOT NULL, booking_version INTEGER NOT NULL,
    note TEXT NOT NULL, actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, actor_role TEXT NOT NULL,
    date TEXT NOT NULL, slot TEXT NOT NULL, created_at TEXT NOT NULL,
    UNIQUE(appointment_id,booking_version), FOREIGN KEY(appointment_id) REFERENCES appointments(id)
  )`)
  function save(row, user, note, timestamp) {
    function fail(status, message) { const error = new Error(message); error.status = status; throw error }
    if (!user.isStaff || !roles[user.role]) fail(403, '仅前台和管理员可以确认预约')
    if (typeof note !== 'string' || !note.trim() || note.length > 500) fail(400, '请填写 1–500 字的沟通说明')
    db.prepare(`INSERT INTO appointment_confirmations
      (appointment_id,booking_version,note,actor_id,actor_name,actor_role,date,slot,created_at) VALUES (?,?,?,?,?,?,?,?,?)`)
      .run(row.id,row.booking_version,note.trim(),user.id,user.displayName || '诊所员工',user.role,row.date,row.slot,timestamp)
  }
  function list(id) {
    return db.prepare(`SELECT id,note,actor_id AS actorId,actor_name AS actorName,actor_role AS actorRole,
      date,slot,created_at AS createdAt FROM appointment_confirmations WHERE appointment_id=? ORDER BY id DESC`).all(id)
      .map(row => ({ ...row, actorRoleLabel: roles[row.actorRole] }))
  }
  return { save, list }
}
module.exports = { createConfirmations }
