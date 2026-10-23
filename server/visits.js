function createVisits(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS visit_summaries (
    appointment_id TEXT NOT NULL, version INTEGER NOT NULL, findings TEXT NOT NULL,
    treatment TEXT NOT NULL, next_steps TEXT NOT NULL, author_id TEXT NOT NULL,
    author_name TEXT NOT NULL, created_at TEXT NOT NULL,
    PRIMARY KEY (appointment_id,version), FOREIGN KEY (appointment_id) REFERENCES appointments(id)
  );`)
  if (!db.prepare('PRAGMA table_info(visit_summaries)').all().some(row => row.name === 'structured_json')) db.exec("ALTER TABLE visit_summaries ADD COLUMN structured_json TEXT NOT NULL DEFAULT '{}' ")
  if (!db.prepare('PRAGMA table_info(appointments)').all().some(row => row.name === 'record_deleted_at')) db.exec("ALTER TABLE appointments ADD COLUMN record_deleted_at TEXT NOT NULL DEFAULT ''")
  function fail(status, message) { const error = new Error(message); error.status = status; throw error }
  function view(row) {
    return row ? { version: row.version, findings: row.findings, treatment: row.treatment,
      nextSteps: row.next_steps, structured: JSON.parse(row.structured_json || '{}'), authorName: row.author_name, savedAt: row.created_at } : null
  }
  function revisions(id) {
    return db.prepare('SELECT * FROM visit_summaries WHERE appointment_id=? ORDER BY version').all(id).map(view)
  }
  function save(user, id, body, withinTransaction = false) {
    if (!body || typeof body !== 'object' || Array.isArray(body)) fail(400, '小结格式无效')
    if (!['doctor', 'admin'].includes(user.role)) fail(403, '仅医生或管理员可填写就诊小结')
    const fields = [['findings', '检查结果', 2000], ['treatment', '处置说明', 2000], ['nextSteps', '后续安排', 1500]]
    for (const [key, label, max] of fields) {
      if (typeof body[key] !== 'string' || !body[key].trim() || body[key].length > max) fail(400, `请填写${label}（最多 ${max} 字）`)
    }
    if (!Number.isSafeInteger(body.version) || body.version < 0) fail(400, '缺少有效的小结版本，请重新加载')
    if (!withinTransaction) db.exec('BEGIN IMMEDIATE')
    try {
      const appointment = db.prepare('SELECT * FROM appointments WHERE id=?').get(id)
      if (!appointment) fail(404, '就诊记录不存在')
      if (appointment.record_deleted_at) fail(410, '该次健康档案已删除')
      if (user.role === 'doctor' && appointment.doctor !== user.doctorName) fail(403, '只能填写本人接诊的就诊小结')
      if (appointment.status !== '已完成') fail(409, '请先完成接诊，再填写就诊小结')
      const current = db.prepare('SELECT * FROM visit_summaries WHERE appointment_id=? ORDER BY version DESC LIMIT 1').get(id)
      const version = current ? current.version : 0
      const findings = body.findings.trim(), treatment = body.treatment.trim(), nextSteps = body.nextSteps.trim()
      const structured = normalizeStructured(body.structured === undefined ? JSON.parse(current?.structured_json || '{}') : body.structured)
      const sameStructured = current && current.structured_json === structured
      // A retry after a lost response returns the same saved revision.
      if (current && sameStructured && version === body.version + 1 && current.author_id === user.id && current.findings === findings && current.treatment === treatment && current.next_steps === nextSteps) {
        if (!withinTransaction) db.exec('COMMIT'); return view(current)
      }
      if (version !== body.version) fail(409, '小结已被更新，请返回时间轴重新加载后编辑')
      if (current && sameStructured && current.findings === findings && current.treatment === treatment && current.next_steps === nextSteps) {
        if (!withinTransaction) db.exec('COMMIT'); return view(current)
      }
      db.prepare('INSERT INTO visit_summaries (appointment_id,version,findings,treatment,next_steps,author_id,author_name,created_at,structured_json) VALUES (?,?,?,?,?,?,?,?,?)').run(id, version + 1, findings, treatment, nextSteps,
        user.id, user.displayName || user.doctorName || '诊所管理员', new Date().toISOString(), structured)
      const saved = db.prepare('SELECT * FROM visit_summaries WHERE appointment_id=? AND version=?').get(id, version + 1)
      if (!withinTransaction) db.exec('COMMIT'); return view(saved)
    } catch (error) { if (!withinTransaction) db.exec('ROLLBACK'); throw error }
  }
  return { revisions, save }
}
module.exports = { createVisits }
function normalizeStructured(value) {
  const fail = message => { const error = new Error(message); error.status = 400; throw error }
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail('结构化治疗记录格式无效')
  const result = {}
  for (const [key, max] of [['diagnosis',1000],['procedure',1000],['materials',500]]) {
    if (value[key] !== undefined && (typeof value[key] !== 'string' || value[key].length > max)) fail('诊断、治疗项目或材料内容无效')
    result[key] = (value[key] || '').trim()
  }
  if (value.teeth !== undefined && (!Array.isArray(value.teeth) || value.teeth.length > 52 || value.teeth.some(tooth => typeof tooth !== 'string' || !/^(?:[1-4][1-8]|[5-8][1-5])$/.test(tooth)))) fail('牙位须使用 FDI 两位编号，如 11、36、55')
  result.teeth = [...new Set(value.teeth || [])].sort()
  return JSON.stringify(result)
}
module.exports.normalizeStructured = normalizeStructured
