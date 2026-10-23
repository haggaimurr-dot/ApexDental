const { randomUUID } = require('node:crypto')
const { fail,stamp,text,transaction,fileBytes } = require('./archive-common')
function createRecordTools(db,records,photoTypes,guardians) {
  db.exec(`CREATE TABLE IF NOT EXISTS record_attachments (
    id TEXT PRIMARY KEY,appointment_id TEXT NOT NULL REFERENCES appointments(id),author_id TEXT NOT NULL,
    kind TEXT NOT NULL,name TEXT NOT NULL,tooth TEXT NOT NULL,mime TEXT NOT NULL,bytes BLOB NOT NULL,digest TEXT NOT NULL,
    request_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS health_questionnaires (
    member_id TEXT NOT NULL REFERENCES family_members(id),version INTEGER NOT NULL,answers_json TEXT NOT NULL,
    author_id TEXT NOT NULL,created_at TEXT NOT NULL,PRIMARY KEY(member_id,version)
  ); CREATE TABLE IF NOT EXISTS record_access_logs (
    id INTEGER PRIMARY KEY,actor_id TEXT NOT NULL,actor_role TEXT NOT NULL,member_id TEXT NOT NULL DEFAULT '',
    appointment_id TEXT NOT NULL DEFAULT '',resource_id TEXT NOT NULL DEFAULT '',action TEXT NOT NULL,
    outcome INTEGER NOT NULL,created_at TEXT NOT NULL
  ); CREATE INDEX IF NOT EXISTS record_access_member ON record_access_logs(member_id,id DESC);`)
  const meta = row => ({ id: row.id,appointmentId: row.appointment_id,kind: row.kind,name: row.name,tooth: row.tooth,mime: row.mime,createdAt: row.created_at,size: row.size || row.bytes?.length || 0 })
  function attachments(user,id,scope) {
    records.access(user,db.prepare('SELECT * FROM appointments WHERE id=?').get(id),scope)
    return db.prepare('SELECT id,appointment_id,kind,name,tooth,mime,length(bytes) AS size,created_at FROM record_attachments WHERE appointment_id=? ORDER BY created_at DESC,id').all(id).map(meta)
  }
  async function upload(user,id,query,req) {
    records.writable(user,id)
    const kind = query.get('kind'),name = text(query.get('name'),120,'附件名称'),key = text(query.get('requestKey'),100,'请求标识'),tooth = query.get('tooth') || ''
    if (!['检查单','影像','其他'].includes(kind) || /[\x00-\x1f\\/]/.test(name) || tooth && !/^(?:[1-4][1-8]|[5-8][1-5])$/.test(tooth)) fail(400,'附件分类、名称或牙位无效')
    const file = await fileBytes(req,photoTypes)
    return transaction(db,() => {
      records.writable(user,id)
      const old = db.prepare('SELECT * FROM record_attachments WHERE request_key=?').get(key)
      if (old) {
        if (old.author_id !== user.id || old.appointment_id !== id || old.digest !== file.digest || old.kind !== kind || old.name !== name || old.tooth !== tooth) fail(409,'请求标识已用于其他附件')
        return meta(old)
      }
      if (db.prepare('SELECT COUNT(*) AS n FROM record_attachments WHERE appointment_id=?').get(id).n >= 30) fail(409,'每次就诊最多归档 30 份附件')
      const attachmentId = randomUUID()
      db.prepare('INSERT INTO record_attachments VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(attachmentId,id,user.id,kind,name,tooth,file.mime,file.bytes,file.digest,key,stamp())
      return meta(db.prepare('SELECT * FROM record_attachments WHERE id=?').get(attachmentId))
    })
  }
  function read(user,id,scope) {
    const row = db.prepare('SELECT * FROM record_attachments WHERE id=?').get(id)
    if (!row) fail(404,'附件不存在')
    records.access(user,db.prepare('SELECT * FROM appointments WHERE id=?').get(row.appointment_id),scope)
    return row
  }
  function questionnaire(user,id,scope) {
    records.memberAccess(user,id,scope)
    return db.prepare('SELECT * FROM health_questionnaires WHERE member_id=? ORDER BY version DESC').all(id).map(row => ({ version: row.version,answers: JSON.parse(row.answers_json),createdAt: row.created_at,authorId: row.author_id }))
  }
  function saveQuestionnaire(user,id,body) {
    const member = records.memberAccess(user,id,'mine')
    if (member.owner_id !== user.id) fail(403,'只读共享不能填写问卷')
    guardians.requireVerified(user,id)
    if (!body || body.consent !== true || !Number.isSafeInteger(body.version) || body.version < 0 || !body.answers || typeof body.answers !== 'object' || Array.isArray(body.answers)) fail(400,'请确认问卷内容并提供有效版本')
    const answers = {}
    for (const key of ['allergies','medications','conditions','previousReactions','chiefComplaint']) answers[key] = text(body.answers[key],1000,'问卷回答',true)
    for (const key of ['bleedingHistory','pregnant']) { if (![true,false,null].includes(body.answers[key])) fail(400,'问卷选项无效'); answers[key] = body.answers[key] }
    if (!['none','current','former','unknown'].includes(body.answers.tobacco)) fail(400,'请选择吸烟情况')
    answers.tobacco = body.answers.tobacco
    return transaction(db,() => {
      guardians.requireVerified(user,id)
      const current = db.prepare('SELECT * FROM health_questionnaires WHERE member_id=? ORDER BY version DESC LIMIT 1').get(id),serialized = JSON.stringify(answers)
      if (current?.answers_json === serialized && [body.version,body.version+1].includes(current.version)) return { version: current.version,answers,createdAt: current.created_at }
      if ((current?.version || 0) !== body.version) fail(409,'问卷已更新，请重新加载')
      const now = stamp(),version = body.version+1
      db.prepare('INSERT INTO health_questionnaires VALUES (?,?,?,?,?)').run(id,version,serialized,user.id,now)
      return { version,answers,createdAt: now }
    })
  }
  function audit(user,url,status) {
    const path = url.pathname
    if (!/(?:history|record|care-photos|questionnaire|guardian|privacy|attachment)/.test(path)) return
    let memberId = '',appointmentId = '',resourceId = ''
    const member = path.match(/^\/v1\/members\/([^/]+)/),visit = path.match(/^\/v1\/appointments\/([^/]+)/)
    if (member) memberId = member[1]
    if (visit) appointmentId = visit[1]
    const resource = path.match(/^\/v1\/(record-photos|record-attachments|care-photos|guardian-checks|privacy-requests)\/([^/]+)/)
    if (resource) {
      resourceId = resource[2]
      const row = resource[1] === 'care-photos' ? db.prepare('SELECT c.appointment_id FROM care_photos p JOIN care_tasks c ON c.id=p.task_id WHERE p.id=?').get(resourceId)
        : resource[1] === 'record-photos' ? db.prepare('SELECT appointment_id FROM record_photos WHERE id=?').get(resourceId)
        : resource[1] === 'record-attachments' ? db.prepare('SELECT appointment_id FROM record_attachments WHERE id=?').get(resourceId)
        : resource[1] === 'guardian-checks' ? db.prepare('SELECT member_id FROM guardian_checks WHERE id=?').get(resourceId)
        : db.prepare('SELECT member_id FROM privacy_requests WHERE id=?').get(resourceId)
      appointmentId = row?.appointment_id || appointmentId; memberId = row?.member_id || memberId
    }
    if (appointmentId) memberId = db.prepare('SELECT member_id FROM appointments WHERE id=?').get(appointmentId)?.member_id || memberId
    const action = /\/(?:download|evidence)$/.test(path) || /\/v1\/(?:record-photos|record-attachments|care-photos)\/[^/]+$/.test(path) && url.method === 'GET' ? 'download' : url.method === 'GET' ? 'access' : 'change'
    db.prepare('INSERT INTO record_access_logs (actor_id,actor_role,member_id,appointment_id,resource_id,action,outcome,created_at) VALUES (?,?,?,?,?,?,?,?)').run(user.id,user.role,memberId,appointmentId,resourceId,action,status,stamp())
  }
  function logs(user,query) {
    const scope = query.get('scope') || 'mine',memberId = query.get('member') || '',page = Number(query.get('page') || 1),action = query.get('action') || ''
    if (!['mine','clinic'].includes(scope) || !Number.isSafeInteger(page) || page < 1 || page > 100000 || action && !['access','download','change'].includes(action)) fail(400,'日志查询无效')
    const conditions = [],args = []
    if (scope === 'clinic') { if (!user.isStaff || user.role !== 'admin') fail(403,'仅管理员可查看诊所访问日志') }
    else { conditions.push('(l.actor_id=? OR EXISTS (SELECT 1 FROM family_members m WHERE m.id=l.member_id AND m.owner_id=?))'); args.push(user.id,user.id) }
    if (memberId) { if (scope === 'mine' && !db.prepare('SELECT 1 FROM family_members WHERE id=? AND owner_id=?').get(memberId,user.id)) fail(403,'无权查看此成员的访问日志'); conditions.push('l.member_id=?'); args.push(memberId) }
    if (action) { conditions.push('l.action=?'); args.push(action) }
    const where = conditions.length ? 'WHERE ' + conditions.join(' AND ') : ''
    const total = db.prepare(`SELECT COUNT(*) AS n FROM record_access_logs l ${where}`).get(...args).n
    const items = db.prepare(`SELECT l.id,l.actor_id,l.actor_role AS actorRole,l.member_id AS memberId,l.appointment_id AS appointmentId,l.resource_id AS resourceId,l.action,l.outcome,l.created_at AS createdAt,
      m.name AS memberName,a.date AS visitDate,a.service,s.display_name AS staffName,
      (SELECT recipient_name FROM member_shares ms WHERE ms.member_id=l.member_id AND ms.user_id=l.actor_id LIMIT 1) AS recipientName
      FROM record_access_logs l LEFT JOIN family_members m ON m.id=l.member_id LEFT JOIN appointments a ON a.id=l.appointment_id LEFT JOIN staff s ON s.user_id=l.actor_id ${where} ORDER BY l.id DESC LIMIT 20 OFFSET ?`).all(...args,(page-1)*20).map(row => {
        const { actor_id,staffName,recipientName,...safe } = row
        return {...safe,actorName: actor_id===user.id ? '本人' : staffName || recipientName || '其他账号'}
      })
    return { items,total,page,hasMore: page*20 < total }
  }
  return { attachments,upload,read,questionnaire,saveQuestionnaire,audit,logs }
}
module.exports = { createRecordTools }
