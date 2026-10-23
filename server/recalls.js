function createRecalls(db) {
  let sharing
  db.exec(`CREATE TABLE IF NOT EXISTS recall_plans (
    appointment_id TEXT PRIMARY KEY, due_date TEXT NOT NULL, instructions TEXT NOT NULL,
    version INTEGER NOT NULL, author_id TEXT NOT NULL, updated_at TEXT NOT NULL,
    FOREIGN KEY (appointment_id) REFERENCES appointments(id)
  );
  CREATE TABLE IF NOT EXISTS recall_events (
    id INTEGER PRIMARY KEY, appointment_id TEXT NOT NULL, due_date TEXT NOT NULL,
    instructions TEXT NOT NULL, version INTEGER NOT NULL, actor TEXT NOT NULL, created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS recall_followups (
    id INTEGER PRIMARY KEY, appointment_id TEXT NOT NULL, plan_version INTEGER NOT NULL,
    note TEXT NOT NULL, next_contact_date TEXT NOT NULL, actor TEXT NOT NULL,
    request_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL,
    FOREIGN KEY (appointment_id) REFERENCES appointments(id)
  );`)
  if (!db.prepare('PRAGMA table_info(recall_followups)').all().some(row => row.name === 'outcome')) db.exec("ALTER TABLE recall_followups ADD COLUMN outcome TEXT NOT NULL DEFAULT 'reached'")
  if (!db.prepare('PRAGMA table_info(appointments)').all().some(row => row.name === 'recall_id')) {
    db.exec("ALTER TABLE appointments ADD COLUMN recall_id TEXT NOT NULL DEFAULT ''")
  }
  db.exec('CREATE INDEX IF NOT EXISTS appointments_recall ON appointments(recall_id)')
  function fail(status, message) { const error = new Error(message); error.status = status; throw error }
  function today() { return new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) }
  function linked(id) { return db.prepare("SELECT * FROM appointments WHERE recall_id=? AND status<>'已取消' ORDER BY created_at DESC LIMIT 1").get(id) }
  function view(row) {
    if (!row) return null
    const booking = linked(row.appointment_id)
    const recent = db.prepare('SELECT outcome FROM recall_followups WHERE appointment_id=? AND plan_version=? ORDER BY id DESC LIMIT 3').all(row.appointment_id, row.version)
    const lost = !booking && ((Date.parse(today()) - Date.parse(row.due_date)) / 86400000 >= 7 || recent.length === 3 && recent.every(item => item.outcome === 'unreachable'))
    return { appointmentId: row.appointment_id, memberId: row.member_id || '', patient: row.patient, doctor: row.doctor, service: row.service,
      dueDate: row.due_date, instructions: row.instructions, version: row.version,
      status: booking ? (booking.status === '已完成' ? 'completed' : 'booked') : 'pending',
      followupState: booking ? 'responded' : lost ? 'lost' : row.due_date < today() ? 'overdue' : 'pending',
      countdownDays: Math.ceil((Date.parse(booking ? booking.date : row.due_date) - Date.parse(today())) / 86400000),
      overdue: !booking && row.due_date < today(),
      booking: booking ? { id: booking.id, date: booking.date, slot: booking.slot, status: booking.status } : null }
  }
  const joined = 'SELECT r.*,a.patient,a.doctor,a.service,a.owner_id,a.member_id FROM recall_plans r JOIN appointments a ON a.id=r.appointment_id'
  function get(id) { return view(db.prepare(joined + ' WHERE r.appointment_id=?').get(id)) }
  function list(user, scope) {
    if (scope === 'clinic' && !['admin', 'doctor'].includes(user.role)) fail(403, '当前角色不能查看复查安排')
    const query = scope !== 'clinic' ? ` WHERE ${sharing.readableCondition}` : user.role === 'doctor' ? ' WHERE a.doctor=?' : ''
    const args = scope !== 'clinic' ? [user.id,user.id] : user.role === 'doctor' ? [user.doctorName] : []
    return db.prepare(joined + query + ' ORDER BY r.due_date,r.appointment_id').all(...args).map(row => ({ ...view(row),mayManage: row.owner_id === user.id }))
  }
  function save(user, id, body) {
    if (!['admin', 'doctor'].includes(user.role)) fail(403, '仅医生或管理员可安排复查')
    const due = new Date(`${body.dueDate}T00:00:00Z`), last = new Date(`${today()}T00:00:00Z`)
    last.setUTCDate(last.getUTCDate() + 365)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate || '') || !Number.isFinite(due.getTime()) || due.toISOString().slice(0, 10) !== body.dueDate || body.dueDate < today() || due > last) fail(400, '复查日期应在今天至未来一年内')
    if (typeof body.instructions !== 'string' || !body.instructions.trim() || body.instructions.length > 1500) fail(400, '请填写复查说明（最多 1500 字）')
    if (!Number.isSafeInteger(body.version) || body.version < 0) fail(400, '复查版本无效，请重新加载')
    db.exec('BEGIN IMMEDIATE')
    try {
      const appointment = db.prepare('SELECT * FROM appointments WHERE id=?').get(id)
      if (!appointment) fail(404, '就诊记录不存在')
      if (user.role === 'doctor' && appointment.doctor !== user.doctorName) fail(403, '只能安排本人接诊患者的复查')
      if (appointment.status !== '已完成' || !db.prepare('SELECT 1 FROM visit_summaries WHERE appointment_id=?').get(id)) fail(409, '请先完成接诊并保存就诊小结')
      if (!appointment.owner_id) fail(409, '旧记录尚未关联患者账号，不能发送复查安排')
      const current = db.prepare('SELECT * FROM recall_plans WHERE appointment_id=?').get(id)
      const version = current ? current.version : 0, instructions = body.instructions.trim()
      if (current && [body.version, body.version + 1].includes(version) && current.due_date === body.dueDate && current.instructions === instructions && current.author_id === user.id) {
        db.exec('COMMIT'); return get(id)
      }
      if (version !== body.version) fail(409, '复查安排已更新，请返回时间轴重新加载')
      if (linked(id)) fail(409, '患者已预约复查，请先处理现有预约')
      const timestamp = new Date().toISOString()
      db.prepare('INSERT INTO recall_plans VALUES (?,?,?,?,?,?) ON CONFLICT(appointment_id) DO UPDATE SET due_date=excluded.due_date,instructions=excluded.instructions,version=excluded.version,author_id=excluded.author_id,updated_at=excluded.updated_at').run(id, body.dueDate, instructions, version + 1, user.id, timestamp)
      db.prepare('INSERT INTO recall_events (appointment_id,due_date,instructions,version,actor,created_at) VALUES (?,?,?,?,?,?)').run(id, body.dueDate, instructions, version + 1, user.id, timestamp)
      db.exec('COMMIT'); return get(id)
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  // Used inside appointment creation's transaction; dates still follow ordinary availability rules.
  function bookingContext(user, id, version) {
    const plan = db.prepare(joined + ' WHERE r.appointment_id=?').get(id)
    if (!plan || plan.owner_id !== user.id) fail(403, '无权预约此复查安排')
    if (plan.version !== version) fail(409, '复查安排已更新，请返回复查列表重新选择')
    if (linked(id)) fail(409, '已有复查预约，请勿重复提交')
    return plan
  }
  function followup(id, version) {
    return db.prepare('SELECT note,outcome,next_contact_date AS nextContactDate,created_at AS savedAt FROM recall_followups WHERE appointment_id=? AND plan_version=? ORDER BY id DESC LIMIT 1').get(id, version) || null
  }
  function saveFollowup(user, id, body) {
    if (!['admin', 'doctor'].includes(user.role)) fail(403, '仅医生或管理员可记录复查跟进')
    if (body.outcome !== undefined && !['reached', 'unreachable', 'declined'].includes(body.outcome)) fail(400, '联系结果无效')
    if (typeof body.note !== 'string' || body.note.trim().length < 2 || body.note.length > 1000) fail(400, '请填写跟进记录（2–1000 字）')
    const date = new Date(`${body.nextContactDate}T00:00:00Z`), last = new Date(`${today()}T00:00:00Z`)
    last.setUTCDate(last.getUTCDate() + 30)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.nextContactDate || '') || !Number.isFinite(date.getTime()) || date.toISOString().slice(0, 10) !== body.nextContactDate || body.nextContactDate <= today() || date > last) fail(400, '再次跟进日期应在明天至未来 30 天内')
    if (typeof body.requestKey !== 'string' || !body.requestKey || body.requestKey.length > 100 || !Number.isSafeInteger(body.version)) fail(400, '跟进请求无效，请重新加载')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = db.prepare(joined + ' WHERE r.appointment_id=?').get(id)
      if (!row) fail(404, '复查安排不存在')
      if (user.role === 'doctor' && row.doctor !== user.doctorName) fail(403, '只能跟进本人患者的复查')
      const existing = db.prepare('SELECT * FROM recall_followups WHERE request_key=?').get(body.requestKey)
      if (existing) {
        if (existing.actor !== user.id || existing.appointment_id !== id || existing.note !== body.note.trim() || existing.next_contact_date !== body.nextContactDate || existing.outcome !== (body.outcome || 'reached')) fail(409, '请求标识已使用')
        db.exec('COMMIT'); return { saved: true }
      }
      if (row.version !== body.version) fail(409, '复查安排已变更，请重新加载待办')
      if (!view(row).overdue) fail(409, '该复查已预约或尚未逾期，请重新加载待办')
      const current = followup(id, row.version)
      if (current && current.nextContactDate > today()) fail(409, '已有再次跟进安排，请重新加载待办')
      db.prepare('INSERT INTO recall_followups (appointment_id,plan_version,note,next_contact_date,actor,request_key,created_at,outcome) VALUES (?,?,?,?,?,?,?,?)').run(id, row.version, body.note.trim(), body.nextContactDate, user.id, body.requestKey, new Date().toISOString(), body.outcome || 'reached')
      db.exec('COMMIT'); return { saved: true }
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  return { get, list, save, bookingContext, followup, saveFollowup,setSharing: value => { sharing = value } }
}
module.exports = { createRecalls }
