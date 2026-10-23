function fail(status, message) { const error = new Error(message); error.status = status; throw error }
function validDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) &&
    new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value
}
function createRecordSearch(db, sharing, doctors) {
  db.exec('CREATE INDEX IF NOT EXISTS appointments_record_date ON appointments(date DESC,slot DESC,id DESC); CREATE INDEX IF NOT EXISTS appointments_doctor_date ON appointments(doctor,date DESC);')
  function list(user, query) {
    const scope = query.get('scope') || 'mine'
    if (!['mine', 'clinic'].includes(scope)) fail(400, '查询范围无效')
    if (scope === 'clinic' && (!user.isStaff || !['admin', 'doctor'].includes(user.role))) fail(403, '仅医生和管理员可检索诊所就诊记录')
    const name = (query.get('name') || '').trim(), from = query.get('from') || '', to = query.get('to') || ''
    const doctor = query.get('doctor') || '', member = query.get('member') || 'all', pageText = query.get('page') || '1'
    if (name.length > 60 || member.length > 100) fail(400, '查询条件过长')
    if ((from && !validDate(from)) || (to && !validDate(to)) || (from && to && from > to)) fail(400, '请选择有效的起止日期')
    if (doctor && !doctors.includes(doctor)) fail(400, '医生不存在')
    if (!/^[1-9]\d{0,5}$/.test(pageText)) fail(400, '页码无效')
    const conditions = ["a.record_deleted_at=''"], args = [], page = Number(pageText), pageSize = 20
    if (scope === 'mine') { conditions.push(sharing.readableCondition); args.push(user.id, user.id) }
    if (scope === 'clinic' && user.role === 'doctor') {
      if (doctor && doctor !== user.doctorName) fail(403, '只能检索本人接诊记录')
      conditions.push('a.doctor=?'); args.push(user.doctorName)
    } else if (doctor) { conditions.push('a.doctor=?'); args.push(doctor) }
    if (name) { conditions.push('instr(lower(a.patient),lower(?))>0'); args.push(name) }
    if (from) { conditions.push('a.date>=?'); args.push(from) }
    if (to) { conditions.push('a.date<=?'); args.push(to) }
    if (scope === 'mine' && member !== 'all') {
      if (member === 'unassigned') conditions.push("a.member_id=''")
      else { conditions.push('a.member_id=?'); args.push(member) }
    }
    const where = conditions.length ? ' WHERE ' + conditions.join(' AND ') : ''
    const total = db.prepare('SELECT count(*) AS total FROM appointments a' + where).get(...args).total
    const rows = db.prepare(`SELECT a.id,a.patient,a.service,a.doctor,a.date,a.slot,a.status,a.member_id,
      a.owner_id=? AS may_manage, EXISTS(SELECT 1 FROM visit_summaries v WHERE v.appointment_id=a.id) AS has_summary
      FROM appointments a${where} ORDER BY a.date DESC,a.slot DESC,a.created_at DESC,a.id DESC LIMIT ? OFFSET ?`).all(user.id, ...args, pageSize, (page - 1) * pageSize)
    return { items: rows.map(row => ({ id: row.id, patient: row.patient, service: row.service, doctor: row.doctor,
      date: row.date, slot: row.slot, status: row.status, memberId: row.member_id, mayManage: Boolean(row.may_manage), hasSummary: Boolean(row.has_summary) })),
      total, page, pageSize, hasMore: page * pageSize < total }
  }
  return { list }
}
module.exports = { createRecordSearch }
