const { randomUUID } = require('node:crypto')
function createRecordRequests(db, visits) {
  let guardians
  db.exec(`CREATE TABLE IF NOT EXISTS record_requests (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, appointment_id TEXT NOT NULL,
    request_key TEXT NOT NULL, kind TEXT NOT NULL, details TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'submitted', version INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(owner_id,request_key),
    FOREIGN KEY(appointment_id) REFERENCES appointments(id)
  ); CREATE TABLE IF NOT EXISTS record_request_events (
    id INTEGER PRIMARY KEY, request_id TEXT NOT NULL, status TEXT NOT NULL, note TEXT NOT NULL,
    actor_id TEXT NOT NULL, actor_name TEXT NOT NULL, created_at TEXT NOT NULL,
    FOREIGN KEY(request_id) REFERENCES record_requests(id)
  )`)
  db.exec('CREATE INDEX IF NOT EXISTS record_requests_owner ON record_requests(owner_id,created_at); CREATE INDEX IF NOT EXISTS record_requests_status ON record_requests(status,created_at); CREATE INDEX IF NOT EXISTS record_request_events_request ON record_request_events(request_id,id)')
  function fail(status, message) { const error = new Error(message); error.status = status; throw error }
  function clinic(user) { if (!user.isStaff || user.role !== 'admin') fail(403, '仅管理员可以处理资料请求') }
  function text(value, limit, label) {
    if (typeof value !== 'string' || !value.trim() || value.length > limit) fail(400, `${label}须为 1–${limit} 字`)
    return value.trim()
  }
  function view(row) {
    const appointment = db.prepare('SELECT patient,service,date FROM appointments WHERE id=?').get(row.appointment_id)
    return { id: row.id, appointmentId: row.appointment_id, kind: row.kind, details: row.details,
      status: row.status, version: row.version, createdAt: row.created_at, updatedAt: row.updated_at,
      ...appointment, events: db.prepare('SELECT status,note,actor_name AS actorName,created_at AS createdAt FROM record_request_events WHERE request_id=? ORDER BY id').all(row.id) }
  }
  function event(row, user, note, timestamp) {
    db.prepare('INSERT INTO record_request_events (request_id,status,note,actor_id,actor_name,created_at) VALUES (?,?,?,?,?,?)')
      .run(row.id, row.status, note, user.id, user.displayName || '申请人', timestamp)
  }
  function transaction(action) {
    db.exec('BEGIN IMMEDIATE')
    try { const result = action(); db.exec('COMMIT'); return result } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function submit(user, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '申请格式无效')
    if (!['correction', 'deletion'].includes(body.kind)) fail(400, '请选择更正或删除申请')
    const details = text(body.details, 2000, '申请说明'), key = text(body.requestKey, 100, '请求标识')
    if (typeof body.appointmentId !== 'string') fail(400, '请选择就诊记录')
    const appointment = db.prepare('SELECT * FROM appointments WHERE id=?').get(body.appointmentId)
    if (!appointment) fail(404, '就诊记录不存在')
    if (appointment.record_deleted_at) fail(410, '该次健康档案已删除')
    if (appointment.owner_id !== user.id) fail(403, '只有记录管理账号可以申请，家人只读授权不包含此权限')
    if (appointment.member_id) guardians?.requireVerified(user,appointment.member_id)
    const previous = db.prepare('SELECT * FROM record_requests WHERE owner_id=? AND request_key=?').get(user.id, key)
    if (previous) {
      if (previous.appointment_id !== body.appointmentId || previous.kind !== body.kind || previous.details !== details) fail(409, '请求标识已用于其他申请')
      return view(previous)
    }
    if (db.prepare("SELECT id FROM record_requests WHERE appointment_id=? AND kind=? AND status IN ('submitted','processing')").get(body.appointmentId, body.kind)) fail(409, '同类申请尚在处理中，请先查看原申请')
    return transaction(() => {
      const timestamp = new Date().toISOString(), id = randomUUID()
      db.prepare('INSERT INTO record_requests (id,owner_id,appointment_id,request_key,kind,details,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)')
        .run(id, user.id, body.appointmentId, key, body.kind, details, timestamp, timestamp)
      const row = db.prepare('SELECT * FROM record_requests WHERE id=?').get(id)
      event(row, user, '提交申请', timestamp); return view(row)
    })
  }
  function list(user, params) {
    const scope = params.get('scope') || 'mine', status = params.get('status') || ''
    if (!['mine', 'clinic'].includes(scope)) fail(400, '查询范围无效')
    if (scope === 'clinic') clinic(user)
    if (status && !['submitted','processing','completed','rejected','withdrawn'].includes(status)) fail(400, '状态无效')
    const page = Number(params.get('page') || 1)
    if (!Number.isSafeInteger(page) || page < 1 || page > 1000000) fail(400, '页码无效')
    const conditions = [], values = []
    if (scope === 'mine') { conditions.push('owner_id=?'); values.push(user.id) }
    if (status) { conditions.push('status=?'); values.push(status) }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : ''
    const total = db.prepare(`SELECT COUNT(*) AS total FROM record_requests ${where}`).get(...values).total
    const items = db.prepare(`SELECT * FROM record_requests ${where} ORDER BY created_at DESC,id LIMIT 20 OFFSET ?`).all(...values, (page - 1) * 20).map(view)
    return { items, total, page, hasMore: page * 20 < total }
  }
  function update(user, id, body) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '处理格式无效')
    const row = db.prepare('SELECT * FROM record_requests WHERE id=?').get(id)
    if (!row) fail(404, '申请不存在')
    if (body.status === 'withdrawn') { if (row.owner_id !== user.id) fail(403, '只能撤回自己的申请') }
    else clinic(user)
    if (body.version !== row.version) fail(409, '申请已更新，请刷新后重试')
    const allowed = { submitted: ['processing','withdrawn'], processing: ['completed','rejected'] }
    if (!(allowed[row.status] || []).includes(body.status)) fail(409, '不能执行此状态变更；请先受理再填写结果')
    const note = text(body.note, 2000, '处理说明')
    if (body.status === 'completed' && body.confirmed !== true) fail(400, '请确认执行更正或删除，保存后立即生效')
    return transaction(() => {
      const timestamp = new Date().toISOString()
      if (body.status === 'completed') {
        const appointment = db.prepare('SELECT * FROM appointments WHERE id=?').get(row.appointment_id)
        if (appointment.member_id) guardians?.requireVerified({ id: row.owner_id },appointment.member_id)
        if (appointment.record_deleted_at) fail(410, '该次健康档案已删除')
        if (row.kind === 'correction') {
          if (!body.correction || !visits) fail(400, '请填写更正后的就诊小结')
          const before = visits.revisions(row.appointment_id).at(-1)
          const saved = visits.save(user, row.appointment_id, body.correction, true)
          if (before && saved.version === before.version) fail(400, '更正内容未发生变化')
        } else {
          if (!['已完成','已取消'].includes(appointment.status)) fail(409, '请先结束本次预约，再删除健康档案')
          deleteMedicalRecord(row.appointment_id, timestamp)
          const others = db.prepare("SELECT * FROM record_requests WHERE appointment_id=? AND id<>? AND status IN ('submitted','processing')").all(row.appointment_id,id)
          for (const other of others) {
            db.prepare("UPDATE record_requests SET status='rejected',version=version+1,updated_at=? WHERE id=?").run(timestamp,other.id)
            event({ ...other,status: 'rejected' },user,'该次健康档案已按删除申请清除，本申请结束',timestamp)
          }
        }
      }
      db.prepare('UPDATE record_requests SET status=?,version=version+1,updated_at=? WHERE id=?').run(body.status, timestamp, id)
      const updated = db.prepare('SELECT * FROM record_requests WHERE id=?').get(id)
      event(updated, user, note, timestamp); return view(updated)
    })
  }
  function deleteMedicalRecord(id, timestamp) {
    for (const table of ['stage_events','treatment_stages','tooth_states','summary_acknowledgments']) {
      if (db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.prepare(table === 'stage_events' ? 'DELETE FROM stage_events WHERE stage_id IN (SELECT id FROM treatment_stages WHERE appointment_id=?)' : `DELETE FROM ${table} WHERE appointment_id=?`).run(id)
    }
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='care_plan_holds'").get())db.prepare('DELETE FROM care_plan_holds WHERE task_id IN (SELECT id FROM care_tasks WHERE appointment_id=?)').run(id)
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='backup_erasures'").get())db.prepare('INSERT INTO backup_erasures(requested_at) VALUES(?)').run(timestamp)
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='care_task_release'").get())db.prepare('DELETE FROM care_task_release WHERE task_id IN (SELECT id FROM care_tasks WHERE appointment_id=?)').run(id)
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='recall_nodes'").get()){db.prepare('DELETE FROM recall_node_events WHERE node_id IN (SELECT id FROM recall_nodes WHERE appointment_id=?)').run(id);db.prepare('DELETE FROM recall_nodes WHERE appointment_id=?').run(id)}
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='care_triage'").get())db.prepare('DELETE FROM care_triage WHERE task_id IN (SELECT id FROM care_tasks WHERE appointment_id=?)').run(id)
    const taskIds = 'SELECT id FROM care_tasks WHERE appointment_id=?'
    const planIds = 'SELECT id FROM care_plans WHERE appointment_id=?'
    for (const table of ['care_plan_nodes','care_plan_events']) db.prepare(`DELETE FROM ${table} WHERE plan_id IN (${planIds})`).run(id)
    db.prepare('DELETE FROM care_plan_nodes WHERE task_id IN (' + taskIds + ')').run(id)
    for (const table of ['care_photos','care_feedback','care_resolutions','care_events']) db.prepare(`DELETE FROM ${table} WHERE task_id IN (${taskIds})`).run(id)
    for (const table of ['care_plans','care_tasks','visit_summaries','record_photos','recall_plans','recall_events','recall_followups','tasks']) db.prepare(`DELETE FROM ${table} WHERE appointment_id=?`).run(id)
    db.prepare('DELETE FROM record_attachments WHERE appointment_id=?').run(id)
    const appointment = db.prepare('SELECT owner_id,member_id FROM appointments WHERE id=?').get(id)
    db.prepare('DELETE FROM privacy_exports WHERE request_id IN (SELECT id FROM privacy_requests WHERE owner_id=? AND member_id=?)').run(appointment.owner_id,appointment.member_id)
    db.prepare('DELETE FROM notification_attempts WHERE message_id IN (SELECT id FROM notification_messages WHERE appointment_id=?)').run(id)
    db.prepare('DELETE FROM notification_messages WHERE appointment_id=?').run(id)
    db.prepare("UPDATE appointments SET note='',record_deleted_at=?,updated_at=? WHERE id=?").run(timestamp,timestamp,id)
  }
  return { submit, list, update,deleteMedicalRecord,setGuardians: value => { guardians = value } }
}
module.exports = { createRecordRequests }
