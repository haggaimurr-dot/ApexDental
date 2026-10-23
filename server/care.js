const { randomUUID } = require('node:crypto')
function fail(status, message) { const error = new Error(message); error.status = status; throw error }
function today() {
  const now = new Date(Date.now() + 8 * 60 * 60 * 1000)
  return now.toISOString().slice(0, 10)
}
function createCare(db) {
  let sharing
  db.exec(`
    CREATE TABLE IF NOT EXISTS care_tasks (
      id TEXT PRIMARY KEY,appointment_id TEXT NOT NULL,title TEXT NOT NULL,instructions TEXT NOT NULL,
      due_date TEXT NOT NULL,status TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,
      created_by TEXT NOT NULL,created_at TEXT NOT NULL,published_at TEXT,
      FOREIGN KEY(appointment_id) REFERENCES appointments(id)
    );
    CREATE TABLE IF NOT EXISTS care_feedback (
      task_id TEXT PRIMARY KEY,pain TEXT NOT NULL,bleeding INTEGER NOT NULL,swelling INTEGER NOT NULL,
      note TEXT NOT NULL,attention INTEGER NOT NULL,created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES care_tasks(id)
    );
    CREATE TABLE IF NOT EXISTS care_resolutions (
      task_id TEXT PRIMARY KEY,staff_id TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL,
      FOREIGN KEY(task_id) REFERENCES care_tasks(id)
    );
    CREATE TABLE IF NOT EXISTS care_events (id INTEGER PRIMARY KEY,task_id TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,created_at TEXT NOT NULL);
    INSERT OR IGNORE INTO care_tasks (id,appointment_id,title,instructions,due_date,status,request_key,created_by,created_at)
      SELECT id,appointment_id,title,description,substr(created_at,1,10),CASE WHEN status='待处理' THEN 'draft' ELSE 'archived' END,'legacy:'||id,'migration',created_at FROM tasks;
  `)
  const joined = `SELECT c.*,a.owner_id,a.member_id,a.patient,a.doctor,a.service FROM care_tasks c JOIN appointments a ON a.id=c.appointment_id`
  function staffAccess(user, appointment) {
    if (!['admin', 'doctor'].includes(user.role)) fail(403, '仅医生或管理员可安排护理')
    if (user.role === 'doctor' && appointment.doctor !== user.doctorName) fail(403, '只能处理本人患者的护理任务')
  }
  function rules(id) {
    // Plans are initialized after care; standalone tasks retain manual review.
    if (!db.prepare("SELECT 1 FROM sqlite_master WHERE name='care_plan_nodes'").get()) return {}
    const link = db.prepare('SELECT p.nodes_json,n.position FROM care_plan_nodes n JOIN care_plans p ON p.id=n.plan_id WHERE n.task_id=?').get(id)
    return link ? JSON.parse(link.nodes_json)[link.position] || {} : {}
  }
  function contacts(id) {
    return db.prepare("SELECT action,created_at FROM care_events WHERE task_id=? AND action LIKE 'followup:%' ORDER BY id").all(id)
      .map(row => ({ ...JSON.parse(row.action.slice(9)), savedAt: row.created_at }))
  }
  function view(row) {
    const feedback = db.prepare('SELECT pain,bleeding,swelling,note,attention,created_at AS submittedAt FROM care_feedback WHERE task_id=?').get(row.id)
    if (feedback) feedback.photos = db.prepare('SELECT id,mime FROM care_photos WHERE task_id=? AND attached=1 ORDER BY created_at,id').all(row.id)
    const resolution = db.prepare('SELECT note,created_at AS handledAt FROM care_resolutions WHERE task_id=?').get(row.id)
    const policy = rules(row.id), history = contacts(row.id), last = history.at(-1)
    const overdueDays = Math.max(0, Math.floor((Date.parse(today()) - Date.parse(row.due_date)) / 86400000))
    const lost = row.status === 'published' && (overdueDays >= (policy.lossAfterDays || 7) || history.slice(-3).length === 3 && history.slice(-3).every(item => item.outcome === 'unreachable'))
    return { phase: policy.phase || '', autoNormal: policy.autoNormal === true, lossAfterDays: policy.lossAfterDays || 7, followupIntervalDays: policy.followupIntervalDays || 3,
      followupState: row.status !== 'published' ? 'responded' : lost ? 'lost' : overdueDays ? 'overdue' : 'pending',
      nextContactDate: last?.nextContactDate || '', overdueDays,
      id: row.id, appointmentId: row.appointment_id, memberId: row.member_id || '', title: row.title, instructions: row.instructions,
      dueDate: row.due_date, status: row.status, patient: row.patient, doctor: row.doctor, service: row.service,
      feedback: feedback || null, resolution: resolution || null }
  }
  function get(id) {
    const row = db.prepare(joined + ' WHERE c.id=?').get(id)
    if (!row) fail(404, '护理任务不存在')
    return row
  }
  function list(user, scope) {
    let rows
    if (scope === 'clinic') {
      if (!['admin', 'doctor'].includes(user.role)) fail(403, '当前角色不能查看护理工作队列')
      rows = user.role === 'doctor'
        ? db.prepare(joined + " WHERE a.doctor=? AND c.status<>'archived' ORDER BY c.created_at DESC").all(user.doctorName)
        : db.prepare(joined + " WHERE c.status<>'archived' ORDER BY c.created_at DESC").all()
    } else rows = db.prepare(joined + ` WHERE ${sharing.readableCondition} AND c.status IN ('published','waiting_review','resolved') ORDER BY c.due_date,c.created_at`).all(user.id,user.id)
    return rows.map(row => ({ ...view(row), ...(scope === 'clinic' ? { followups: contacts(row.id), triage:db.prepare("SELECT 1 FROM sqlite_master WHERE name='care_triage'").get()?db.prepare('SELECT * FROM care_triage WHERE task_id=?').get(row.id)||null:null } : {}), mayManage: row.owner_id === user.id }))
  }
  function checkContent(body) {
    if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 80) fail(400, '请填写 1–80 字任务标题')
    if (typeof body.instructions !== 'string' || !body.instructions.trim() || body.instructions.length > 3000) fail(400, '请填写护理说明（最多 3000 字）')
    const due = new Date(`${body.dueDate}T00:00:00Z`)
    const last = new Date(`${today()}T00:00:00Z`); last.setUTCDate(last.getUTCDate() + 365)
    if (!/^\d{4}-\d{2}-\d{2}$/.test(body.dueDate || '') || !Number.isFinite(due.getTime()) || due.toISOString().slice(0, 10) !== body.dueDate || body.dueDate < today() || due > last) fail(400, '反馈日期应在今天至未来一年内')
  }
  function event(id, user, action) { db.prepare('INSERT INTO care_events (task_id,actor,action,created_at) VALUES (?,?,?,?)').run(id, user.id, action, new Date().toISOString()) }
  // Called inside the visit-completion transaction. Drafts are never visible to patients.
  function draft(appointment, user) {
    const id = `C-${randomUUID()}`
    db.prepare('INSERT INTO care_tasks (id,appointment_id,title,instructions,due_date,status,request_key,created_by,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(
      id, appointment.id, `${appointment.service}后护理`, '', today(), 'draft', `visit:${appointment.id}`, user.id, new Date().toISOString())
    event(id, user, 'draft_created')
  }
  function publish(user, body, draftId, templates) {
    checkContent(body)
    if (!draftId && (typeof body.requestKey !== 'string' || !body.requestKey || body.requestKey.length > 100)) fail(400, '缺少请求标识')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = draftId ? get(draftId) : null
      const appointment = row || db.prepare('SELECT * FROM appointments WHERE id=?').get(body.appointmentId)
      if (!appointment) fail(404, '就诊记录不存在')
      if (appointment.record_deleted_at) fail(410, '该次健康档案已删除')
      staffAccess(user, appointment)
      if (!appointment.owner_id) fail(409, '该旧记录尚未关联患者账号，不能发送护理任务')
      if (!row && appointment.status !== '已完成') fail(409, '请先完成接诊，再安排护理任务')
      if (row && row.status !== 'draft') fail(409, '该任务已发送，请重新加载')
      if (!row) {
        const existing = db.prepare(joined + ' WHERE c.request_key=?').get(body.requestKey)
        if (existing) {
          if (existing.created_by !== user.id || existing.appointment_id !== body.appointmentId) fail(409, '请求标识已被使用')
          db.exec('COMMIT'); return view(existing)
        }
      }
      const id = row ? row.id : `C-${randomUUID()}`, timestamp = new Date().toISOString()
      if (row) db.prepare("UPDATE care_tasks SET title=?,instructions=?,due_date=?,status='published',published_at=? WHERE id=?").run(body.title.trim(), body.instructions.trim(), body.dueDate, timestamp, id)
      else db.prepare('INSERT INTO care_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run(id, appointment.id, body.title.trim(), body.instructions.trim(), body.dueDate, 'published', body.requestKey, user.id, timestamp, timestamp)
      if (templates) templates.recordUsage(user, id, body, appointment.service)
      event(id, user, 'published')
      db.exec('COMMIT'); return view(get(id))
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function feedback(user, id, body) {
    if (!['无疼痛', '轻微不适', '明显疼痛'].includes(body.pain) || typeof body.bleeding !== 'boolean' || typeof body.swelling !== 'boolean' || typeof body.note !== 'string' || body.note.length > 1000) fail(400, '请填写完整反馈（补充说明最多 1000 字）')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = get(id)
      if (row.owner_id !== user.id || row.status === 'draft') fail(403, '无权提交此任务的反馈')
      if (row.status !== 'published') fail(409, '反馈已提交，不能重复提交')
      const photos = body.photos === undefined ? [] : body.photos
      if (!Array.isArray(photos) || photos.length > 3 || new Set(photos).size !== photos.length || photos.some(photo => typeof photo !== 'string')) fail(400,'反馈最多附 3 张照片')
      for (const photoId of photos) {
        const photo = db.prepare('SELECT * FROM care_photos WHERE id=?').get(photoId)
        if (!photo || photo.owner_id !== user.id || photo.task_id !== id || photo.attached || photo.created_at < new Date(Date.now() - 86400000).toISOString()) fail(409,'照片已过期或不属于本次反馈，请重新上传')
      }
      for (const photoId of photos) db.prepare('UPDATE care_photos SET attached=1 WHERE id=?').run(photoId)
      db.prepare('DELETE FROM care_photos WHERE task_id=? AND attached=0').run(id)
      const attention = body.pain !== '无疼痛' || body.bleeding || body.swelling || !!body.note.trim() || photos.length > 0
      db.prepare('INSERT INTO care_feedback VALUES (?,?,?,?,?,?,?)').run(id, body.pain, Number(body.bleeding), Number(body.swelling), body.note.trim(), Number(attention), new Date().toISOString())
      db.prepare("UPDATE care_tasks SET status='waiting_review' WHERE id=?").run(id)
      event(id, user, 'feedback_submitted')
      if (!attention && rules(id).autoNormal === true) {
        db.prepare('INSERT INTO care_resolutions VALUES (?,?,?,?)').run(id, 'system', '已记录本阶段无异常反馈，请继续按计划完成后续任务。', new Date().toISOString())
        db.prepare("UPDATE care_tasks SET status='resolved' WHERE id=?").run(id)
        event(id, { id: 'system' }, 'normal_auto_resolved')
      }
      db.exec('COMMIT'); return view(get(id))
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function resolve(user, id, body) {
    if (typeof body.note !== 'string' || body.note.trim().length < 2 || body.note.length > 1000) fail(400, '请填写处理意见（2–1000 字）')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = get(id)
      staffAccess(user, row)
      if (row.status !== 'waiting_review') fail(409, '请先等待患者反馈，不能直接完成任务')
      db.prepare('INSERT INTO care_resolutions VALUES (?,?,?,?)').run(id, user.id, body.note.trim(), new Date().toISOString())
      db.prepare("UPDATE care_tasks SET status='resolved' WHERE id=?").run(id)
      event(id, user, 'resolved')
      db.exec('COMMIT'); return view(get(id))
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function followup(user, id, body) {
    if (!body || !['reached', 'unreachable', 'declined'].includes(body.outcome) || typeof body.note !== 'string' || body.note.trim().length < 2 || body.note.length > 1000 || typeof body.requestKey !== 'string' || !body.requestKey || body.requestKey.length > 100) fail(400, '请填写联系结果、跟进说明和请求标识')
    db.exec('BEGIN IMMEDIATE')
    try {
      const row = get(id); staffAccess(user, row)
      const history = contacts(id), existing = history.find(item => item.requestKey === body.requestKey)
      if (existing) {
        if (existing.actor !== user.id || existing.outcome !== body.outcome || existing.note !== body.note.trim()) fail(409, '请求标识已用于其他内容')
        db.exec('COMMIT'); return view(row)
      }
      if (row.status !== 'published' || row.due_date >= today()) fail(409, '仅可跟进逾期未反馈任务')
      if (history.at(-1)?.nextContactDate > today()) fail(409, '尚未到再次联系日期')
      const nextContactDate = new Date(Date.parse(today()) + (rules(id).followupIntervalDays || 3) * 86400000).toISOString().slice(0, 10)
      event(id, user, 'followup:' + JSON.stringify({ outcome: body.outcome, note: body.note.trim(), requestKey: body.requestKey, actor: user.id, nextContactDate }))
      db.exec('COMMIT'); return view(row)
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  return { followup, list, draft, publish, feedback, resolve, view, checkContent, setSharing: value => { sharing = value } }
}
module.exports = { createCare }
