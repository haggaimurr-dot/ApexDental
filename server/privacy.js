const { randomUUID,createHash } = require('node:crypto')
const { fail,stamp,text,transaction } = require('./archive-common')
const { zipFiles } = require('./record-zip')
function createPrivacy(db,records,recordTools,guardians,recordRequests) {
  db.exec(`CREATE TABLE IF NOT EXISTS privacy_requests (
    id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,member_id TEXT NOT NULL DEFAULT '',kind TEXT NOT NULL,details TEXT NOT NULL,
    request_key TEXT NOT NULL, status TEXT NOT NULL,version INTEGER NOT NULL,created_at TEXT NOT NULL,updated_at TEXT NOT NULL,
    UNIQUE(owner_id,request_key)
  ); CREATE TABLE IF NOT EXISTS privacy_events (
    id INTEGER PRIMARY KEY,request_id TEXT NOT NULL REFERENCES privacy_requests(id),status TEXT NOT NULL,note TEXT NOT NULL,actor_id TEXT NOT NULL,created_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS privacy_exports (
    request_id TEXT PRIMARY KEY REFERENCES privacy_requests(id),bytes BLOB NOT NULL,expires_at TEXT NOT NULL,created_at TEXT NOT NULL
  );`)
  db.exec('CREATE TABLE IF NOT EXISTS privacy_export_parts(request_id TEXT NOT NULL REFERENCES privacy_exports(request_id) ON DELETE CASCADE,part INTEGER NOT NULL,bytes BLOB NOT NULL,PRIMARY KEY(request_id,part))')
  function admin(user) { if (!user.isStaff || user.role !== 'admin') fail(403,'仅管理员可办理资料权利请求') }
  function ownMembers(user) { return db.prepare('SELECT id FROM family_members WHERE owner_id=?').all(user.id) }
  function closureReady(user) {
    if (db.prepare('SELECT 1 FROM staff WHERE user_id=? AND enabled=1').get(user.id)) fail(409,'请先由其他管理员停用员工身份并完成工作交接')
    if (db.prepare("SELECT 1 FROM appointments WHERE owner_id=? AND status NOT IN ('已完成','已取消','爽约')").get(user.id)) fail(409,'请先结束或取消未完成的预约')
    for (const member of ownMembers(user)) guardians.requireVerified(user,member.id)
  }
  function view(row) {
    const file = db.prepare('SELECT expires_at FROM privacy_exports WHERE request_id=?').get(row.id)
    return { id: row.id,kind: row.kind,memberId: row.member_id,memberName: db.prepare('SELECT name FROM family_members WHERE id=?').get(row.member_id)?.name || '',details: row.details,status: row.status,version: row.version,createdAt: row.created_at,
      downloadable: row.status === 'completed' && !!file && file.expires_at > stamp() && (!guardians.needs(row.member_id) || guardians.verified(row.member_id,row.owner_id)),expiresAt: file?.expires_at || '',
      parts: file ? [{part:1,size:db.prepare('SELECT length(bytes) size FROM privacy_exports WHERE request_id=?').get(row.id).size},...db.prepare('SELECT part,length(bytes) size FROM privacy_export_parts WHERE request_id=? ORDER BY part').all(row.id)] : [],
      events: db.prepare('SELECT status,note,created_at AS createdAt FROM privacy_events WHERE request_id=? ORDER BY id').all(row.id) }
  }
  function event(id,status,note,user) { db.prepare('INSERT INTO privacy_events (request_id,status,note,actor_id,created_at) VALUES (?,?,?,?,?)').run(id,status,note,user.id,stamp()) }
  function submit(user,body) {
    if (!body || !['access','export','closure'].includes(body.kind)) fail(400,'请选择访问、导出或账号注销')
    const key = text(body.requestKey,100,'请求标识'),details = text(body.details,2000,'申请说明'),memberId = body.kind === 'closure' ? '' : text(body.memberId,100,'成员标识')
    if (body.kind === 'closure') { if (body.confirmed !== true) fail(400,'请确认账号注销范围'); closureReady(user) }
    else guardians.requireVerified(user,memberId)
    return transaction(db,() => {
      const old = db.prepare('SELECT * FROM privacy_requests WHERE owner_id=? AND request_key=?').get(user.id,key)
      if (old) { if (old.kind !== body.kind || old.member_id !== memberId || old.details !== details) fail(409,'请求标识已用于其他申请'); return view(old) }
      if (db.prepare("SELECT 1 FROM privacy_requests WHERE owner_id=? AND kind=? AND member_id=? AND status IN ('submitted','processing')").get(user.id,body.kind,memberId)) fail(409,'已有同类请求正在办理')
      const id=randomUUID(),now=stamp()
      db.prepare("INSERT INTO privacy_requests VALUES (?,?,?,?,?,?,'submitted',1,?,?)").run(id,user.id,memberId,body.kind,details,key,now,now)
      event(id,'submitted','提交申请',user)
      return view(db.prepare('SELECT * FROM privacy_requests WHERE id=?').get(id))
    })
  }
  function list(user,query) {
    const scope = query.get('scope') || 'mine',page = Number(query.get('page') || 1)
    if (!['mine','clinic'].includes(scope) || !Number.isSafeInteger(page) || page < 1 || page > 100000) fail(400,'查询条件无效')
    if (scope === 'clinic') admin(user)
    const where = scope === 'mine' ? 'WHERE owner_id=?' : '',args = scope === 'mine' ? [user.id] : []
    const total = db.prepare(`SELECT COUNT(*) AS n FROM privacy_requests ${where}`).get(...args).n
    return { items: db.prepare(`SELECT * FROM privacy_requests ${where} ORDER BY created_at DESC,id LIMIT 20 OFFSET ?`).all(...args,(page-1)*20).map(view),total,page,hasMore: page*20 < total }
  }
  function packageFor(row,storePart) {
    const owner = { id: row.owner_id,role: 'patient',isStaff: false }
    guardians.requireVerified(owner,row.member_id)
    const record = records.overview(owner,row.member_id,'mine'),questionnaires = recordTools.questionnaire(owner,row.member_id,'mine'),attachments = []; let files = []
    const visits = db.prepare("SELECT * FROM appointments WHERE member_id=? AND owner_id=? AND record_deleted_at=''").all(row.member_id,row.owner_id)
    const total = db.prepare(`SELECT
      (SELECT COALESCE(SUM(length(p.bytes)),0) FROM record_photos p JOIN appointments a ON a.id=p.appointment_id WHERE a.member_id=? AND a.owner_id=? AND a.record_deleted_at='') +
      (SELECT COALESCE(SUM(length(p.bytes)),0) FROM record_attachments p JOIN appointments a ON a.id=p.appointment_id WHERE a.member_id=? AND a.owner_id=? AND a.record_deleted_at='') +
      (SELECT COALESCE(SUM(length(p.bytes)),0) FROM care_photos p JOIN care_tasks c ON c.id=p.task_id JOIN appointments a ON a.id=c.appointment_id WHERE a.member_id=? AND a.owner_id=? AND a.record_deleted_at='' AND (p.attached=1 OR p.owner_id=?)) AS size`).get(row.member_id,row.owner_id,row.member_id,row.owner_id,row.member_id,row.owner_id,row.owner_id).size
    if(total > 2*1024*1024*1024)fail(413,'资料总量超过本次在线导出上限，请按就诊范围分批办理')
    const partLimit=Number(process.env.APEX_EXPORT_PART_BYTES || 48*1024*1024)
    if(!Number.isSafeInteger(partLimit)||partLimit<128*1024||partLimit>64*1024*1024)fail(503,'资料包分卷配置无效')
    let part=0;const flush=()=>{if(files.length){storePart(zipFiles(files),++part);files=[];size=0}}
    let size = 0
    const add = (name,bytes) => { if(bytes.length>partLimit)fail(413,'单份文件超过分卷上限，请调整分卷大小');if(size+bytes.length>partLimit)flush();size += bytes.length;files.push({name,bytes}) }
    for (const visit of visits) {
      for (const attachment of db.prepare('SELECT * FROM record_attachments WHERE appointment_id=?').all(visit.id)) {
        attachments.push({ id: attachment.id,appointmentId: visit.id,name: attachment.name,kind: attachment.kind,tooth: attachment.tooth,mime: attachment.mime,createdAt: attachment.created_at })
        const extraExtension={'image/tiff':'.tiff','image/gif':'.gif','application/vnd.openxmlformats-officedocument.wordprocessingml.document':'.docx','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet':'.xlsx'}[attachment.mime]
        const extension = extraExtension || (attachment.mime === 'application/pdf' ? '.pdf' : attachment.mime === 'application/dicom' ? '.dcm' : attachment.mime === 'image/png' ? '.png' : '.jpg')
        add(`attachments/${attachment.id}${extension}`,attachment.bytes)
      }
      for (const photo of db.prepare('SELECT * FROM record_photos WHERE appointment_id=?').all(visit.id)) add(`photos/${photo.id}${photo.mime === 'image/png' ? '.png' : '.jpg'}`,photo.bytes)
      for (const photo of db.prepare('SELECT p.* FROM care_photos p JOIN care_tasks c ON c.id=p.task_id WHERE c.appointment_id=? AND (p.attached=1 OR p.owner_id=?)').all(visit.id,row.owner_id)) add(`recovery/${photo.id}${photo.mime === 'image/png' ? '.png' : '.jpg'}`,photo.bytes)
    }
    const member = db.prepare('SELECT id,name,relationship,phone,enabled FROM family_members WHERE id=? AND owner_id=?').get(row.member_id,row.owner_id)
    const checks = db.prepare('SELECT id,guardian_name AS guardianName,relationship,phone,birth_date AS birthDate,status,note,created_at AS createdAt,mime FROM guardian_checks WHERE member_id=? AND owner_id=?').all(row.member_id,row.owner_id)
    const extensions={stages:[],teeth:[],acknowledgments:[],screenings:[]}
    for(const visit of visits){for(const [table,key] of [['treatment_stages','stages'],['tooth_states','teeth'],['summary_acknowledgments','acknowledgments']])if(db.prepare("SELECT 1 FROM sqlite_master WHERE name=?").get(table))extensions[key].push(...db.prepare(`SELECT * FROM ${table} WHERE appointment_id=?`).all(visit.id))}
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='screening_cases'").get()){for(const screening of db.prepare('SELECT id,questionnaire,status,review_json,created_at FROM screening_cases WHERE member_id=? AND owner_id=?').all(row.member_id,row.owner_id)){extensions.screenings.push({id:screening.id,questionnaire:JSON.parse(screening.questionnaire),status:screening.status,review:screening.status==='reviewed'?JSON.parse(screening.review_json):null,createdAt:screening.created_at});for(const image of db.prepare('SELECT * FROM screening_images WHERE case_id=?').all(screening.id))add(`screening/${image.id}${image.mime==='image/png'?'.png':'.jpg'}`,image.bytes)}}
    const manifest = { schemaVersion: 2,extensions,generatedAt: stamp(),member:{...member,birthDate:guardians.birthDate(row.member_id)},record,questionnaires,attachments,guardianChecks:checks }
    add('records.json',Buffer.from(JSON.stringify(manifest,null,2)))
    add('README.txt',Buffer.from('records.json 包含成员档案、问卷版本和附件目录。photos/recovery/attachments 中为原始文件，以 ID 对照目录。仅供个人资料查阅，不包含诊所内部沟通和他人记录。'))
    flush();return part
  }
  function closeAccount(user,requestId) {
    closureReady(user)
    const original = db.prepare('SELECT subject FROM users WHERE id=?').get(user.id)
    const now=stamp()
    for (const visit of db.prepare('SELECT id FROM appointments WHERE owner_id=?').all(user.id)) recordRequests.deleteMedicalRecord(visit.id,now)
    for (const member of ownMembers(user)) {
      db.prepare('DELETE FROM health_questionnaires WHERE member_id=?').run(member.id)
      db.prepare("UPDATE member_health_profiles SET birth_date='',version=version+1 WHERE member_id=?").run(member.id)
      db.prepare("UPDATE guardian_checks SET bytes=NULL,guardian_name='已注销',phone='',birth_date='',note='账号已注销',status='revoked',version=version+1 WHERE member_id=?").run(member.id)
      db.prepare("UPDATE guardian_events SET note='账号已注销' WHERE check_id IN (SELECT id FROM guardian_checks WHERE member_id=?)").run(member.id)
    }
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='screening_cases'").get()) { for(const table of ['screening_images','screening_events']) db.prepare(`DELETE FROM ${table} WHERE case_id IN (SELECT id FROM screening_cases WHERE owner_id=?)`).run(user.id); db.prepare('DELETE FROM screening_cases WHERE owner_id=?').run(user.id) }
    for (const [table,column] of [['daily_habits','user_id'],['privacy_consents','user_id'],['article_favorites','user_id'],['article_activity','user_id']]) { if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table)) db.prepare(`DELETE FROM ${table} WHERE ${column}=?`).run(user.id) }
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.id)
    db.prepare("UPDATE staff SET enabled=0,display_name='已注销' WHERE user_id=?").run(user.id)
    db.prepare('UPDATE member_shares SET enabled=0,recipient_name=CASE WHEN user_id=? THEN ? ELSE recipient_name END WHERE owner_id=? OR user_id=?').run(user.id,'已注销',user.id,user.id)
    db.prepare('UPDATE member_share_invites SET revoked=1 WHERE owner_id=? OR used_by=?').run(user.id,user.id)
    db.prepare("UPDATE family_members SET name='已注销成员',phone='',enabled=0,version=version+1 WHERE owner_id=?").run(user.id)
    db.prepare("UPDATE appointments SET patient='已注销患者',phone='',note='' WHERE owner_id=?").run(user.id)
    db.prepare('DELETE FROM privacy_exports WHERE request_id IN (SELECT id FROM privacy_requests WHERE owner_id=?)').run(user.id)
    db.prepare("UPDATE record_requests SET details='账号已注销' WHERE owner_id=?").run(user.id)
    db.prepare("UPDATE record_request_events SET note='账号已注销，保留状态审计' WHERE request_id IN (SELECT id FROM record_requests WHERE owner_id=?)").run(user.id)
    db.prepare("UPDATE privacy_requests SET details='账号已注销' WHERE owner_id=?").run(user.id)
    db.prepare("UPDATE privacy_events SET note='账号已注销，保留状态审计' WHERE request_id IN (SELECT id FROM privacy_requests WHERE owner_id=?)").run(user.id)
    db.prepare("UPDATE appointment_confirmations SET note='账号已注销，保留确认状态' WHERE appointment_id IN (SELECT id FROM appointments WHERE owner_id=?)").run(user.id)
    db.prepare("UPDATE appointment_reschedules SET reason='账号已注销，保留改期时间' WHERE appointment_id IN (SELECT id FROM appointments WHERE owner_id=?)").run(user.id)
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='reschedule_requests'").get())db.prepare("UPDATE reschedule_requests SET payload='{}',note='账号已注销' WHERE owner_id=?").run(user.id)
    if(db.prepare("SELECT 1 FROM sqlite_master WHERE name='billing_entries'").get())db.prepare("UPDATE billing_entries SET reason='账号已注销，保留收款金额及审计' WHERE appointment_id IN (SELECT id FROM appointments WHERE owner_id=?)").run(user.id)
    db.prepare('DELETE FROM notification_subscriptions WHERE owner_id=?').run(user.id)
    const hash = createHash('sha256').update(original.subject).digest('hex')
    db.prepare('INSERT INTO closed_subjects VALUES (?,?)').run(hash,now)
    db.prepare('INSERT INTO account_closures VALUES (?,?,?)').run(user.id,requestId,now)
    db.prepare('UPDATE users SET subject=? WHERE id=?').run('closed:'+hash,user.id)
    for (const other of db.prepare("SELECT id FROM privacy_requests WHERE owner_id=? AND id<>? AND status IN ('submitted','processing')").all(user.id,requestId)) {
      db.prepare("UPDATE privacy_requests SET status='rejected',version=version+1,updated_at=? WHERE id=?").run(now,other.id)
      event(other.id,'rejected','账号已注销，请求已结束',user)
    }
  }
  function update(user,id,body) {
    const note = text(body?.note,2000,'处理说明'),status=body?.status
    return transaction(db,() => {
      const row = db.prepare('SELECT * FROM privacy_requests WHERE id=?').get(id)
      if (!row) fail(404,'资料请求不存在')
      if (status === 'withdrawn') { if (row.owner_id !== user.id) fail(403,'只能撤回自己的请求') } else admin(user)
      if (row.version !== body.version) fail(409,'请求已更新，请刷新')
      if (!({ submitted: ['processing','withdrawn'],processing: ['completed','rejected'] }[row.status] || []).includes(status)) fail(409,'状态变更无效，请先受理')
      if (status === 'completed') {
        if (body.confirmed !== true) fail(400,'请确认执行办理结果')
        if (row.kind === 'closure') closeAccount({ id: row.owner_id },row.id)
        else {
          const now=stamp(),expires=new Date(Date.now()+7*86400000).toISOString()
          packageFor(row,(bytes,part)=>{if(part===1)db.prepare('INSERT INTO privacy_exports VALUES (?,?,?,?)').run(row.id,bytes,expires,now);else db.prepare('INSERT INTO privacy_export_parts VALUES(?,?,?)').run(row.id,part,bytes)})
        }
      }
      db.prepare('UPDATE privacy_requests SET status=?,version=version+1,updated_at=? WHERE id=?').run(status,stamp(),id)
      event(id,status,row.kind==='closure' && status==='completed' ? '账号注销已执行，在线医疗内容已清除，保留脱敏业务与安全审计' : note,user)
      return view(db.prepare('SELECT * FROM privacy_requests WHERE id=?').get(id))
    })
  }
  function download(user,id,part = 1) {
    if(!Number.isSafeInteger(part)||part<1||part>10000)fail(400,'资料包分卷无效')
    const row = db.prepare('SELECT * FROM privacy_requests WHERE id=?').get(id)
    if (!row || row.owner_id !== user.id) fail(403,'只能下载自己的资料包')
    guardians.requireVerified(user,row.member_id)
    const file = db.prepare('SELECT * FROM privacy_exports WHERE request_id=?').get(id)
    if (!file || file.expires_at <= stamp()) fail(410,'资料包已失效，请重新申请')
    if (row.status !== 'completed') fail(409,'资料请求尚未完成')
    if(part===1)return file
    const extra=db.prepare('SELECT bytes FROM privacy_export_parts WHERE request_id=? AND part=?').get(id,part);if(!extra)fail(404,'资料包分卷不存在');return {...file,bytes:extra.bytes}
  }
  function purgeExpired() { db.prepare('DELETE FROM privacy_exports WHERE expires_at<=?').run(stamp()) }
  return { submit,list,update,download,purgeExpired }
}
module.exports = { createPrivacy }
