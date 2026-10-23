const { randomUUID } = require('node:crypto')
const { fail,stamp,text,transaction,validDate,minor,fileBytes } = require('./archive-common')
function createGuardians(db,photoTypes) {
  const projection = 'id,member_id,owner_id,guardian_name,relationship,phone,birth_date,mime,digest,request_key,status,version,note,reviewer_id,created_at,updated_at,CASE WHEN bytes IS NULL THEN 0 ELSE 1 END AS has_evidence,external_consent,external_pending,external_result_json'
  db.exec(`CREATE TABLE IF NOT EXISTS member_health_profiles (
    member_id TEXT PRIMARY KEY REFERENCES family_members(id),birth_date TEXT NOT NULL DEFAULT '',
    minor_required INTEGER NOT NULL DEFAULT 0, adult_verified INTEGER NOT NULL DEFAULT 0, version INTEGER NOT NULL DEFAULT 1
  ); CREATE TABLE IF NOT EXISTS guardian_checks (
    id TEXT PRIMARY KEY,member_id TEXT NOT NULL REFERENCES family_members(id),owner_id TEXT NOT NULL,
    guardian_name TEXT NOT NULL,relationship TEXT NOT NULL,phone TEXT NOT NULL,birth_date TEXT NOT NULL,
    mime TEXT NOT NULL,bytes BLOB,digest TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,
    status TEXT NOT NULL,version INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',reviewer_id TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,updated_at TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS guardian_events (
    id INTEGER PRIMARY KEY,check_id TEXT NOT NULL REFERENCES guardian_checks(id),action TEXT NOT NULL,actor_id TEXT NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL
  );`)
  for(const [name,type] of [['external_consent','INTEGER NOT NULL DEFAULT 0'],['external_pending','INTEGER NOT NULL DEFAULT 0'],['external_result_json',"TEXT NOT NULL DEFAULT '{}'"]])if(!db.prepare('PRAGMA table_info(guardian_checks)').all().some(column=>column.name===name))db.exec(`ALTER TABLE guardian_checks ADD COLUMN ${name} ${type}`)
  db.prepare("INSERT OR IGNORE INTO member_health_profiles (member_id,minor_required) SELECT id,1 FROM family_members WHERE relationship='子女'").run()
  function owned(user,id) {
    const row = db.prepare('SELECT * FROM family_members WHERE id=? AND owner_id=?').get(id,user.id)
    if (!row) fail(403,'只有成员管理账号可办理监护核验')
    return row
  }
  function markChild(member) {
    if (member.relationship === '子女') db.prepare('INSERT INTO member_health_profiles (member_id,minor_required) VALUES (?,1) ON CONFLICT(member_id) DO UPDATE SET minor_required=CASE WHEN adult_verified=1 THEN 0 ELSE 1 END').run(member.id)
  }
  function birthDate(id) { return db.prepare('SELECT birth_date FROM member_health_profiles WHERE member_id=?').get(id)?.birth_date || '' }
  function markProfile(member,date) {
    markChild(member)
    if (date === undefined) return
    if (date && (!validDate(date) || date > new Date(Date.now()+8*3600000).toISOString().slice(0,10) || date < '1900-01-01')) fail(400,'成员出生日期无效')
    const previous = db.prepare('SELECT * FROM member_health_profiles WHERE member_id=?').get(member.id)
    if (previous && previous.birth_date === date) return
    // A previously protected profile cannot become unprotected by editing its birthday or relationship.
    const required = Number(minor(date) || previous?.minor_required || member.relationship === '子女')
    db.prepare('INSERT INTO member_health_profiles (member_id,birth_date,minor_required) VALUES (?,?,?) ON CONFLICT(member_id) DO UPDATE SET birth_date=excluded.birth_date,minor_required=excluded.minor_required,adult_verified=0,version=version+1').run(member.id,date,required)
    const checks = db.prepare("SELECT id FROM guardian_checks WHERE member_id=? AND status IN ('approved','adult_confirmed')").all(member.id)
    for (const check of checks) {
      db.prepare("UPDATE guardian_checks SET status='revoked',version=version+1,note='出生日期变更，需重新核验',updated_at=? WHERE id=?").run(stamp(),check.id)
      event(check.id,'revoked',member.owner_id,'出生日期变更，需重新核验',stamp())
    }
    if (checks.length || required) revokeMember(member.id)
  }
  function needs(id) {
    const member = db.prepare('SELECT * FROM family_members WHERE id=?').get(id)
    if (!member) return false
    const profile = db.prepare('SELECT * FROM member_health_profiles WHERE member_id=?').get(id)
    return Boolean(profile?.minor_required || minor(profile?.birth_date) || member.relationship === '子女' && !profile?.adult_verified)
  }
  function verified(id,ownerId) {
    return !!db.prepare("SELECT 1 FROM guardian_checks WHERE member_id=? AND owner_id=? AND status='approved'").get(id,ownerId)
  }
  function requireVerified(user,id) {
    const member = owned(user,id)
    if (needs(id) && !verified(id,member.owner_id)) fail(409,'请先完成该成员的监护人核验')
  }
  function view(row) {
    return { id: row.id,memberId: row.member_id,guardianName: row.guardian_name,relationship: row.relationship,birthDate: row.birth_date,
      externalConsent:!!row.external_consent,externalPending:!!row.external_pending,externalResult:JSON.parse(row.external_result_json||'{}'),status: row.status,version: row.version,note: row.note,mime: row.mime,phone: row.phone,createdAt: row.created_at,updatedAt: row.updated_at,hasEvidence: row.has_evidence === undefined ? !!row.bytes : !!row.has_evidence,
      memberName: db.prepare('SELECT name FROM family_members WHERE id=?').get(row.member_id)?.name || '',
      events: db.prepare('SELECT action,note,created_at AS createdAt FROM guardian_events WHERE check_id=? ORDER BY id').all(row.id) }
  }
  function status(user,id) {
    owned(user,id)
    const profile = db.prepare('SELECT * FROM member_health_profiles WHERE member_id=?').get(id)
    return { required: needs(id),verified: verified(id,user.id),birthDate: profile?.birth_date || '',checks: db.prepare(`SELECT ${projection} FROM guardian_checks WHERE member_id=? ORDER BY created_at DESC,id`).all(id).map(view) }
  }
  async function submit(user,id,query,req) {
    owned(user,id)
    const name = text(query.get('name'),60,'监护人姓名'), relationship = query.get('relationship'),phone = query.get('phone'),birthDate = query.get('birthDate'),key = text(query.get('requestKey'),100,'请求标识')
    if (!['父亲','母亲','其他监护人'].includes(relationship) || !/^1\d{10}$/.test(phone || '') || !validDate(birthDate) || birthDate > stamp().slice(0,10) || birthDate < '1900-01-01') fail(400,'请填写关系、联系电话与成员出生日期')
    const file = await fileBytes(req,photoTypes)
    if (!['application/pdf','image/jpeg','image/png'].includes(file.mime)) fail(400,'监护关系材料请使用 PDF 或照片')
    return transaction(db,() => {
      owned(user,id)
      const old = db.prepare('SELECT * FROM guardian_checks WHERE request_key=?').get(key)
      if (old) {
        if (old.owner_id !== user.id || old.member_id !== id || old.digest !== file.digest || old.guardian_name !== name || old.phone !== phone || old.relationship !== relationship || old.birth_date !== birthDate) fail(409,'请求标识已用于其他核验材料')
        return view(old)
      }
      if (db.prepare("SELECT 1 FROM guardian_checks WHERE member_id=? AND status IN ('submitted','approved')").get(id)) fail(409,'已有待核验或有效核验，请先查看原记录')
      const checkId = randomUUID(),now = stamp()
      db.prepare(`INSERT INTO guardian_checks (id,member_id,owner_id,guardian_name,relationship,phone,birth_date,mime,bytes,digest,request_key,status,version,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,'submitted',1,?,?)`).run(checkId,id,user.id,name,relationship,phone,birthDate,file.mime,file.bytes,file.digest,key,now,now)
      db.prepare('UPDATE guardian_checks SET external_consent=? WHERE id=?').run(Number(query.get('externalConsent')==='true'),checkId)
      db.prepare('INSERT INTO member_health_profiles (member_id,birth_date,minor_required) VALUES (?,?,1) ON CONFLICT(member_id) DO UPDATE SET birth_date=excluded.birth_date,minor_required=1,adult_verified=0,version=version+1').run(id,birthDate)
      event(checkId,'submitted',user.id,'提交监护关系材料',now)
      return view(db.prepare('SELECT * FROM guardian_checks WHERE id=?').get(checkId))
    })
  }
  function admin(user) { if (!user.isStaff || user.role !== 'admin') fail(403,'仅管理员可核验监护关系') }
  function list(user,query) {
    admin(user)
    const page = Number(query?.get('page') || 1)
    if (!Number.isSafeInteger(page) || page < 1 || page > 100000) fail(400,'页码无效')
    const total = db.prepare('SELECT COUNT(*) AS n FROM guardian_checks').get().n
    return { items: db.prepare(`SELECT ${projection} FROM guardian_checks ORDER BY updated_at DESC,id LIMIT 20 OFFSET ?`).all((page-1)*20).map(view),total,page,hasMore: page*20 < total }
  }
  function event(id,action,actor,note,now) { db.prepare('INSERT INTO guardian_events (check_id,action,actor_id,note,created_at) VALUES (?,?,?,?,?)').run(id,action,actor,note,now) }
  function revokeMember(id) {
    db.prepare('UPDATE member_shares SET enabled=0 WHERE member_id=?').run(id)
    db.prepare('UPDATE member_share_invites SET revoked=1 WHERE member_id=?').run(id)
    db.prepare('DELETE FROM privacy_exports WHERE request_id IN (SELECT id FROM privacy_requests WHERE member_id=?)').run(id)
  }
  function review(user,id,body) {
    admin(user)
    const note = text(body?.note,1000,'核验说明'),status = body?.status
    if (!['approved','rejected','revoked','adult_confirmed'].includes(status)) fail(400,'核验状态无效')
    return transaction(db,() => {
      const row = db.prepare('SELECT * FROM guardian_checks WHERE id=?').get(id)
      if (!row) fail(404,'核验记录不存在')
      if (row.owner_id === user.id) fail(403,'不能自行核验本人提交的材料，请交由另一位管理员')
      if (row.version !== body.version) fail(409,'核验记录已更新')
      if (status === 'revoked' ? !['approved','adult_confirmed'].includes(row.status) : row.status !== 'submitted') fail(409,'当前状态不能执行该操作')
      if (status === 'approved' && (!row.bytes || body.identityChecked !== true || body.relationshipChecked !== true)) fail(400,'请核对申请人身份及监护关系材料')
      if (['approved','adult_confirmed'].includes(status) && row.birth_date !== birthDate(row.member_id)) fail(409,'成员出生日期已变更，请重新提交材料')
      if (status === 'adult_confirmed' && (minor(row.birth_date) || body.identityChecked !== true)) fail(400,'请核对已成年成员身份及出生日期')
      const now = stamp()
      db.prepare('UPDATE guardian_checks SET status=?,external_pending=0,version=version+1,note=?,reviewer_id=?,updated_at=? WHERE id=?').run(status,note,user.id,now,id)
      if (status === 'adult_confirmed') db.prepare('UPDATE member_health_profiles SET minor_required=0,adult_verified=1,version=version+1 WHERE member_id=?').run(row.member_id)
      if (status === 'revoked') db.prepare('UPDATE member_health_profiles SET minor_required=1,adult_verified=0,version=version+1 WHERE member_id=?').run(row.member_id)
      if (['rejected','revoked'].includes(status)) revokeMember(row.member_id)
      event(id,status,user.id,note,now)
      return view(db.prepare('SELECT * FROM guardian_checks WHERE id=?').get(id))
    })
  }
  function evidence(user,id) {
    const row = db.prepare('SELECT * FROM guardian_checks WHERE id=?').get(id)
    if (!row || !row.bytes) fail(404,'核验材料不存在')
    if (row.owner_id !== user.id) admin(user)
    return row
  }
  return { status,submit,list,review,evidence,needs,verified,requireVerified,markChild,markProfile,birthDate }
}
module.exports = { createGuardians }
