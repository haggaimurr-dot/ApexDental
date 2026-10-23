const { validDate } = require('./schedules')
function fail(status, message) { const error = new Error(message); error.status = status; throw error }
function createRescheduling(db, catalog, confirmations,resources) {
  if (!db.prepare('PRAGMA table_info(appointments)').all().some(row => row.name === 'booking_version')) {
    db.exec('ALTER TABLE appointments ADD COLUMN booking_version INTEGER NOT NULL DEFAULT 0')
  }
  db.exec(`CREATE TABLE IF NOT EXISTS appointment_reschedules (
    id INTEGER PRIMARY KEY,appointment_id TEXT NOT NULL,actor_id TEXT NOT NULL,actor_name TEXT NOT NULL,
    request_key TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,old_date TEXT NOT NULL,old_slot TEXT NOT NULL,
    new_date TEXT NOT NULL,new_slot TEXT NOT NULL,old_status TEXT NOT NULL,reason TEXT NOT NULL,created_at TEXT NOT NULL,
    FOREIGN KEY(appointment_id) REFERENCES appointments(id)
  ); CREATE INDEX IF NOT EXISTS reschedules_appointment ON appointment_reschedules(appointment_id,id);`)
  function access(user, id, scope) {
    const row = db.prepare('SELECT * FROM appointments WHERE id=?').get(id)
    if (!row) fail(404, '预约不存在')
    if (!['mine', 'clinic'].includes(scope)) fail(400, '操作范围无效')
    if (scope === 'clinic') {
      if (!user.isStaff || !['admin', 'frontdesk'].includes(user.role)) fail(403, '仅管理员和前台可代为改期')
    } else if (row.owner_id !== user.id) fail(403, '只有预约管理人可改期')
    return row
  }
  function changes(id) {
    return db.prepare(`SELECT id,old_date AS oldDate,old_slot AS oldSlot,new_date AS newDate,new_slot AS newSlot,
      old_status AS oldStatus,reason,actor_name AS actorName,created_at AS createdAt FROM appointment_reschedules WHERE appointment_id=? ORDER BY id`).all(id)
  }
  function view(row, scope = 'mine') {
    return { id: row.id, patient: row.patient, doctor: row.doctor, service: row.service, date: row.date, slot: row.slot,
      ...(scope === 'clinic' ? { phone: row.phone, note: row.note, source: row.source, confirmations: confirmations.list(row.id) } : {}),
      status: row.status, version: row.booking_version, canChange: ['待确认', '已预约'].includes(row.status), changes: changes(row.id) }
  }
  function get(user, id, scope) { return view(access(user, id, scope), scope) }
  function save(user, id, body, withinTransaction = false) {
    const scope = body.scope || 'mine', { date, slot, version } = body
    const key = body.requestKey, reason = body.reason
    if (typeof key !== 'string' || !key || key.length > 100 || !Number.isSafeInteger(version) || version < 0) fail(400, '请重新加载预约后改期')
    if (typeof reason !== 'string' || reason.trim().length < 2 || reason.length > 500) fail(400, '请填写 2–500 字的改期原因')
    if (typeof date !== 'string' || typeof slot !== 'string' || !/^([01]\d|2[0-3]):(00|30)$/.test(slot)) fail(400, '预约时间无效')
    const payload = JSON.stringify({ id, scope, date, slot, version, reason: reason.trim() })
    if (!withinTransaction) db.exec('BEGIN IMMEDIATE')
    try {
      const row = access(user, id, scope)
      const previous = db.prepare('SELECT * FROM appointment_reschedules WHERE request_key=?').get(key)
      if (previous) {
        if (previous.actor_id !== user.id || previous.payload !== payload) fail(409, '请求标识已用于其他改期，请重新加载')
        const result = { appointment: view(row, scope), repeated: true }
        if (!withinTransaction) db.exec('COMMIT'); return result
      }
      if (row.booking_version !== version) fail(409, '预约已被处理或改期，请重新加载后操作')
      if (!['待确认', '已预约'].includes(row.status)) fail(409, '仅待确认和已预约的预约可以改期')
      if (!validDate(date)) fail(400, '请选择明天至未来 30 天内的日期')
      if (row.date === date && row.slot === slot) fail(400, '请选择不同于原预约的时间')
      if (!catalog.permits(row.doctor, row.service)) fail(409, '原医生或服务已停用，或服务范围已调整，请联系诊所；原预约仍保留')
      if (require('./booking-capacity').remaining(db,row.doctor,date,slot,row.duration_minutes || 30,id) < 1) fail(409, '新时段及连续占用时段未开放或已约满；原预约仍保留')
      if(resources&&!resources.permits(row.doctor,date,slot,row.duration_minutes||30,row.service,id))fail(409,'新时段资源不足或已停诊')
      if(require('./booking-capacity').patientConflict(db,row,date,slot,row.duration_minutes || 30,id))fail(409,'同一就诊人已有重叠时段预约；原预约仍保留')
      const timestamp = new Date().toISOString(), actorName = scope === 'mine' ? '预约管理人' : `${user.displayName || '诊所员工'}（${user.role === 'admin' ? '管理员' : '前台'}）`
      db.prepare(`INSERT INTO appointment_reschedules (appointment_id,actor_id,actor_name,request_key,payload,old_date,old_slot,new_date,new_slot,old_status,reason,created_at)
        VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`).run(id, user.id, actorName, key, payload, row.date, row.slot, date, slot, row.status, reason.trim(), timestamp)
      db.prepare("UPDATE appointments SET date=?,slot=?,status='待确认',booking_version=booking_version+1,updated_at=? WHERE id=?").run(date, slot, timestamp, id)
      if(resources)resources.reserve(id,row.service)
      // The dedicated audit event records the reset to pending; avoid inventing another submission event.
      const result = { appointment: view(db.prepare('SELECT * FROM appointments WHERE id=?').get(id), scope), repeated: false }
      if (!withinTransaction) db.exec('COMMIT'); return result
    } catch (error) { if (!withinTransaction) db.exec('ROLLBACK'); throw error }
  }
  return { get, save, changes }
}
module.exports = { createRescheduling }
