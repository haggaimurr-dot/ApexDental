const { randomUUID, createHash } = require('node:crypto')
function createPatientRecords(db, history, sharing, carePhotos) {
  db.exec(`CREATE TABLE IF NOT EXISTS record_photos (
    id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL REFERENCES appointments(id),
    author_id TEXT NOT NULL, category TEXT NOT NULL, caption TEXT NOT NULL,
    mime TEXT NOT NULL, bytes BLOB NOT NULL, digest TEXT NOT NULL, request_key TEXT NOT NULL UNIQUE, created_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS record_photos_visit ON record_photos(appointment_id,created_at);`)
  db.exec(`CREATE TABLE IF NOT EXISTS record_photo_details (photo_id TEXT PRIMARY KEY REFERENCES record_photos(id) ON DELETE CASCADE,angle TEXT NOT NULL,tooth TEXT NOT NULL,captured_on TEXT NOT NULL);`)
  function fail(status, message) { const error = new Error(message); error.status = status; throw error }
  function access(user, row, scope) {
    if (!row) fail(404, '档案不存在')
    if (!['mine','clinic'].includes(scope)) fail(400, '查询范围无效')
    if (scope === 'clinic') {
      if (!user.isStaff || !['admin','doctor'].includes(user.role) || user.role === 'doctor' && row.doctor !== user.doctorName) fail(403, '无权查看此档案')
    } else if (!sharing.canRead(user, row)) fail(403, '无权查看此档案')
    if (row.record_deleted_at) fail(410, '该次健康档案已删除')
  }
  function photoView(row, source = 'record') {
    const detail = source === 'record' ? db.prepare('SELECT angle,tooth,captured_on AS capturedOn FROM record_photo_details WHERE photo_id=?').get(row.id) : null
    return { id: row.id, appointmentId: row.appointment_id, category: row.category || '恢复反馈', caption: row.caption || '', mime: row.mime, createdAt: row.created_at, source,angle: detail?.angle || '未标注',tooth: detail?.tooth || '',capturedOn: detail?.capturedOn || row.created_at.slice(0,10) }
  }
  function photos(user, id, scope) {
    access(user, db.prepare('SELECT * FROM appointments WHERE id=?').get(id), scope)
    return [...db.prepare('SELECT id,appointment_id,category,caption,mime,created_at FROM record_photos WHERE appointment_id=?').all(id).map(row => photoView(row)),
      ...db.prepare(`SELECT p.id,c.appointment_id,p.mime,p.created_at FROM care_photos p JOIN care_tasks c ON c.id=p.task_id WHERE c.appointment_id=? AND p.attached=1`).all(id).map(row => photoView(row, 'care'))].sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
  }
  function overview(user, memberId, scope = 'mine') {
    if (!['mine','clinic'].includes(scope)) fail(400, '查询范围无效')
    const member = db.prepare('SELECT * FROM family_members WHERE id=?').get(memberId)
    if (!member) fail(404, '成员档案不存在')
    if (scope === 'mine') access(user, { owner_id: member.owner_id, member_id: member.id }, scope)
    else if (!user.isStaff || !['admin','doctor'].includes(user.role)) fail(403, '无权查看健康档案')
    let appointments = db.prepare("SELECT * FROM appointments WHERE member_id=? AND owner_id=? AND record_deleted_at='' ORDER BY date DESC,slot DESC,id").all(memberId,member.owner_id)
    if (scope === 'clinic' && user.role === 'doctor') {
      appointments = appointments.filter(row => row.doctor === user.doctorName)
      if (!appointments.length) fail(403, '只能查看本人接诊的档案')
    }
    const details = appointments.map(row => history.detail(user,row.id,scope))
    const entries = details.flatMap(detail => detail.entries.map(entry => ({ ...entry, appointmentId: detail.appointment.id, visitDate: detail.appointment.date, service: detail.appointment.service, doctor: detail.appointment.doctor })))
      .sort((a,b) => b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    for (const questionnaire of db.prepare('SELECT version,created_at FROM health_questionnaires WHERE member_id=?').all(memberId)) entries.push({id:`questionnaire-${memberId}-${questionnaire.version}`,type:'questionnaire',title:`健康问卷 · 第 ${questionnaire.version} 版`,at:questionnaire.created_at,text:'成员管理账号提交健康情况，历次版本可在健康问卷查看',appointmentId:''})
    entries.sort((a,b)=>b.at.localeCompare(a.at) || a.id.localeCompare(b.id))
    const archivedPhotos = appointments.flatMap(row => photos(user,row.id,scope)).sort((a,b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id))
    return { member: { id: member.id, name: member.name, mayManage: member.owner_id === user.id, relationship: member.owner_id === user.id ? member.relationship : '已授权查看' },
      stats: { visits: appointments.length, completed: appointments.filter(row => row.status === '已完成').length, summaries: details.filter(row => row.summary).length, photos: archivedPhotos.length },
      lastVisit: appointments.find(row => row.status === '已完成')?.date || '',
      summaries: details.filter(row => row.summary).map(row => ({ appointmentId: row.appointment.id, date: row.appointment.date, service: row.appointment.service, ...row.summary })),
      recalls: details.filter(row => row.recall).map(row => row.recall), entries, photos: archivedPhotos }
  }
  function writable(user,id) {
    const row = db.prepare('SELECT * FROM appointments WHERE id=?').get(id)
    access(user,row,'clinic')
    if (row.status !== '已完成') fail(409,'请先完成接诊再归档照片')
    return row
  }
  async function upload(user,id,query,req) {
    writable(user,id)
    const category = query.get('category') || '', caption = query.get('caption') || '', key = query.get('requestKey') || ''
    if (!['检查','治疗前','治疗后','影像','其他'].includes(category) || caption.length > 200 || !key || key.length > 100) fail(400,'请选择照片分类、填写有效说明和请求标识')
    const angle = query.get('angle') || '未标注',tooth = query.get('tooth') || '',capturedOn = query.get('capturedOn') || new Date().toISOString().slice(0,10)
    const { validDate } = require('./archive-common')
    if (!['未标注','正面','左侧','右侧','上颌咬合','下颌咬合','局部'].includes(angle) || tooth && !/^(?:[1-4][1-8]|[5-8][1-5])$/.test(tooth) || angle === '局部' && !tooth || !validDate(capturedOn) || capturedOn > new Date(Date.now()+8*3600000).toISOString().slice(0,10)) fail(400,'请填写有效拍摄角度、牙位和拍摄日期；局部照片必须指定牙位')
    const chunks = []; let size = 0
    for await (const chunk of req) { size += chunk.length; if (size > 3 * 1024 * 1024) fail(413,'单张照片不能超过 3 MB'); chunks.push(chunk) }
    const bytes = Buffer.concat(chunks), mime = carePhotos.imageType(bytes), digest = createHash('sha256').update(bytes).digest('hex')
    db.exec('BEGIN IMMEDIATE')
    try {
      writable(user,id)
      const old = db.prepare('SELECT * FROM record_photos WHERE request_key=?').get(key)
      if (old) {
        const detail = photoView(old)
        if (old.appointment_id !== id || old.author_id !== user.id || old.digest !== digest || old.category !== category || old.caption !== caption.trim() || detail.angle !== angle || detail.tooth !== tooth || detail.capturedOn !== capturedOn) fail(409,'请求标识已用于其他照片')
        db.exec('COMMIT'); return photoView(old)
      }
      if (db.prepare('SELECT COUNT(*) AS n FROM record_photos WHERE appointment_id=?').get(id).n >= 30) fail(409,'每次就诊最多归档 30 张照片')
      const photoId = randomUUID(), timestamp = new Date().toISOString()
      db.prepare('INSERT INTO record_photos VALUES (?,?,?,?,?,?,?,?,?,?)').run(photoId,id,user.id,category,caption.trim(),mime,bytes,digest,key,timestamp)
      db.prepare('INSERT INTO record_photo_details VALUES (?,?,?,?)').run(photoId,angle,tooth,capturedOn)
      const saved = photoView(db.prepare('SELECT * FROM record_photos WHERE id=?').get(photoId))
      db.exec('COMMIT'); return saved
    } catch (error) { db.exec('ROLLBACK'); throw error }
  }
  function read(user,id,scope) {
    const row = db.prepare('SELECT * FROM record_photos WHERE id=?').get(id)
    if (!row) fail(404,'照片不存在')
    access(user,db.prepare('SELECT * FROM appointments WHERE id=?').get(row.appointment_id),scope)
    return row
  }
  function memberAccess(user,id,scope = 'mine') {
    const member = db.prepare('SELECT * FROM family_members WHERE id=?').get(id)
    if (!member) fail(404,'成员档案不存在')
    if (scope === 'mine') access(user,{ owner_id: member.owner_id,member_id: member.id },scope)
    else {
      if (scope !== 'clinic') fail(400,'查询范围无效')
      if (!user.isStaff || !['admin','doctor'].includes(user.role) || user.role === 'doctor' && !db.prepare("SELECT 1 FROM appointments WHERE member_id=? AND owner_id=? AND doctor=? AND record_deleted_at=''").get(id,member.owner_id,user.doctorName)) fail(403,'无权查看此成员档案')
    }
    return member
  }
  function compare(user,id,left,right,scope) {
    memberAccess(user,id,scope)
    if (!left || left === right) fail(400,'请选择两张不同照片')
    const rows = [left,right].map(photoId => {
      const row = read(user,photoId,scope),appointment = db.prepare('SELECT member_id FROM appointments WHERE id=?').get(row.appointment_id)
      if (appointment.member_id !== id) fail(403,'只能比较同一成员的照片')
      return photoView(row)
    })
    if (rows[0].angle === '未标注' || rows[0].angle !== rows[1].angle || rows[0].tooth !== rows[1].tooth) fail(400,'请选择相同拍摄角度和牙位的归档照片')
    return { left: rows[0],right: rows[1] }
  }
  return { overview, photos, upload, read,access,writable,memberAccess,compare }
}
module.exports = { createPatientRecords }
