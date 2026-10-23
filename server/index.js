const http = require('node:http')
const fs = require('node:fs')
const path = require('node:path')
const { randomUUID } = require('node:crypto')
const { DatabaseSync } = require('node:sqlite')
const { createCatalog } = require('./catalog')
const { createArticles } = require('./articles')
const { createAuth } = require('./auth')
const { createSchedules, validDate } = require('./schedules')
const { createCare } = require('./care')
const { createCarePlans } = require('./care-plans')
const { createHistory } = require('./history')
const { createVisits } = require('./visits')
const { createRecalls } = require('./recalls')
const { createWorklist } = require('./worklist')
const { createStatistics } = require('./statistics')
const { createRecordSearch } = require('./record-search')
const { createRescheduling } = require('./rescheduling')
const { createConfirmations } = require('./confirmations')
const { createCareTemplates } = require('./care-templates')
const { createMembers } = require('./members')
const { createCarePhotos } = require('./care-photos')
const { createMemberSharing } = require('./member-sharing')
const { createNotifications } = require('./notifications')
const { createRecordRequests } = require('./record-requests')
const { createPatientRecords } = require('./patient-records')
const { createGuardians } = require('./guardians')
const { createRecordTools } = require('./record-tools')
const { createPrivacy } = require('./privacy')

const HOST = process.env.APEX_HOST || '127.0.0.1'
const PORT = Number(process.env.APEX_PORT || 8787)
const DATA_DIR = process.env.APEX_DATA_DIR || path.join(__dirname, 'data')
fs.mkdirSync(DATA_DIR, { recursive: true })
const db = new DatabaseSync(process.env.APEX_DB_PATH || path.join(DATA_DIR, 'apex-demo.sqlite'))
db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;')
db.exec(`
CREATE TABLE IF NOT EXISTS appointments (
  id TEXT PRIMARY KEY, request_key TEXT NOT NULL UNIQUE, patient TEXT NOT NULL,
  phone TEXT NOT NULL, service TEXT NOT NULL, doctor TEXT NOT NULL,
  date TEXT NOT NULL, slot TEXT NOT NULL, status TEXT NOT NULL,
  source TEXT NOT NULL, note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  owner_id TEXT NOT NULL DEFAULT ''
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, appointment_id TEXT NOT NULL UNIQUE,
  patient TEXT NOT NULL, title TEXT NOT NULL, description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT '待处理', created_at TEXT NOT NULL,
  FOREIGN KEY (appointment_id) REFERENCES appointments(id)
);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, appointment_id TEXT NOT NULL,
  from_status TEXT, to_status TEXT NOT NULL, actor TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`)
if (!db.prepare('PRAGMA table_info(appointments)').all().some(row => row.name === 'owner_id')) {
  db.exec("ALTER TABLE appointments ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''")
}
const catalog = createCatalog(db)
const articles = createArticles(db, catalog)
const contentFeatures = require('./content-features').createContentFeatures(db, articles)
const auth = createAuth(db, DATA_DIR, catalog)
const billing=require('./billing').createBilling(db)
const payments=require('./payments').createPayments(db)
const resources = require('./resources').createResources(db,catalog)
const schedules = createSchedules(db, catalog,resources)
const care = createCare(db)
const careTriage=require('./care-triage').createCareTriage(db,care)
const careTemplates = createCareTemplates(db, catalog)
const visits = createVisits(db)
const recalls = createRecalls(db)
const members = createMembers(db)
const sharing = createMemberSharing(db)
const confirmations = createConfirmations(db)
const bookingPolicy = require('./booking-policy').createBookingPolicy(db)
const rescheduling = createRescheduling(db, catalog, confirmations,resources)
care.setSharing(sharing); recalls.setSharing(sharing)
const carePhotos = createCarePhotos(db,sharing)
const carePlans = createCarePlans(db, care, sharing)
const careAutomation=require('./care-automation').createCareAutomation(db,catalog,carePlans)
const history = createHistory(db, visits, recalls,sharing)
const worklist = createWorklist(db, care, recalls)

const DOCTORS = { includes: name => catalog.names('doctors', true).includes(name) }
const statistics = createStatistics(db, DOCTORS)
const recordSearch = createRecordSearch(db, sharing, DOCTORS)
const notifications = createNotifications(db)
const patientRecords = createPatientRecords(db, history, sharing, carePhotos)
const recallSeries=require('./recall-series').createRecallSeries(db,patientRecords,sharing)
const recordRequests = createRecordRequests(db, visits)
const guardians = createGuardians(db,carePhotos)
const identityVerification=require('./identity-verification').createIdentityVerification(db)
sharing.setGuardians(guardians); members.setGuardians(guardians); recordRequests.setGuardians(guardians)
const recordTools = createRecordTools(db,patientRecords,carePhotos,guardians)
const contentMedia = require('./content-media').createContentMedia(db,articles,catalog,carePhotos)
const screening = require('./screening').createScreening(db,catalog,guardians,carePhotos)
const longitudinal = require('./longitudinal').createLongitudinal(db,patientRecords,guardians,require('./document-signing').createDocumentSigner(DATA_DIR))
const privacy = createPrivacy(db,patientRecords,recordTools,guardians,recordRequests)
privacy.purgeExpired()
const systemOperations = require('./system-operations').createSystemOperations(db,DATA_DIR)

const TRANSITIONS = {
  '待确认': ['已预约', '已取消'],
  '已预约': ['已到店', '爽约', '取消申请中', '已取消'],
  '取消申请中': ['已预约', '已取消'],
  '已到店': ['就诊中', '已完成'],
  '就诊中': ['已完成']
}

function json(res, status, payload) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' })
  res.end(JSON.stringify(payload))
}
function fail(status, message) { const error = new Error(message); error.status = status; throw error }
function routeId(value){try{return decodeURIComponent(value)}catch{fail(400,'接口标识无效')}}
function publicAppointment(row) {
  const completed = db.prepare("SELECT created_at FROM events WHERE appointment_id=? AND to_status='已完成' ORDER BY id DESC LIMIT 1").get(row.id)
  return { completedOn: completed ? new Date(Date.parse(completed.created_at) + 8 * 3600000).toISOString().slice(0, 10) : '', id: row.id, patient: row.patient, service: row.service, doctor: row.doctor,
    closureNotice:resources.notice(row.doctor,row.date),date: row.date, slot: row.slot, durationMinutes: row.duration_minutes, status: row.status, version: row.booking_version, source: row.source, recallId: row.recall_id || '', memberId: row.member_id || '', recordDeleted: Boolean(row.record_deleted_at) }
}
function listAppointments(user, scope) {
  let rows
  if (user.isStaff && scope === 'clinic') {
    rows = user.role === 'doctor'
      ? db.prepare('SELECT * FROM appointments WHERE doctor=? ORDER BY created_at DESC').all(user.doctorName)
      : db.prepare('SELECT * FROM appointments ORDER BY created_at DESC').all()
  } else rows = db.prepare(`SELECT a.* FROM appointments a WHERE ${sharing.readableCondition} ORDER BY a.created_at DESC`).all(user.id,user.id)
  return rows.map(row => ({ ...publicAppointment(row),mayManage: row.owner_id === user.id }))
}
function create(body, user) {
  let { name, phone, service, date, slot, note = '' } = body
  let requestedDoctor = body.doctor || '不限医生'
  const key = String(body.requestKey || '')
  if (!key || key.length > 100) fail(400, '缺少有效的请求标识')
  if (typeof name !== 'string' || !name.trim() || name.length > 60 || !/^1\d{10}$/.test(phone || '')) fail(400, '就诊人信息无效')
  if (typeof slot !== 'string' || !validDate(date)) fail(400, '预约项目或时间无效')
  if (typeof note !== 'string' || note.length > 500) fail(400, '备注过长')
  db.exec('BEGIN IMMEDIATE')
  try {
    const existing = db.prepare('SELECT * FROM appointments WHERE request_key=?').get(key)
    if (existing) {
      if (existing.owner_id !== user.id) fail(409, '请求标识已被使用')
      db.exec('COMMIT'); return publicAppointment(existing)
    }
    let recallId = body.recallId || ''
    const recallNodeId=body.recallNodeId||''
    if(typeof recallNodeId!=='string'||recallNodeId.length>100)fail(400,'复查节点标识无效')
    let memberId = body.memberId || ''
    if (typeof memberId !== 'string' || memberId.length > 100) fail(400, '成员标识无效')
    if (typeof recallId !== 'string' || recallId.length > 100) fail(400, '复查安排标识无效')
    if (recallId || recallNodeId) {
      const plan = recallNodeId ? recallSeries.context(user,recallNodeId,body.recallVersion) : recalls.bookingContext(user, recallId, body.recallVersion)
      if(recallNodeId)recallId=plan.appointment_id
      name = plan.patient; service = plan.service; requestedDoctor = plan.doctor
      if (memberId && memberId !== plan.member_id) fail(409, '复查必须沿用原就诊成员，请先归属原记录')
      memberId = plan.member_id || ''
    }
    if (memberId) {
      const member = members.owned(user,memberId,true)
      if (!recallId) name = member.name
    }
    const duplicate = memberId
      ? db.prepare("SELECT id FROM appointments WHERE member_id=? AND owner_id=? AND date=? AND slot=? AND status<>'已取消'").get(memberId,user.id,date,slot)
      : db.prepare("SELECT id FROM appointments WHERE patient=? AND phone=? AND date=? AND slot=? AND status<>'已取消'").get(name.trim(),phone,date,slot)
    if (duplicate) fail(409, '同一就诊人已有该时段预约')
    if (!catalog.names('services').includes(service) || requestedDoctor !== '不限医生' && !catalog.permits(requestedDoctor, service)) fail(409, '医生或服务已停用，或该医生不提供此项目，请重新选择或联系诊所')
    if(require('./booking-capacity').patientConflict(db,{member_id:memberId,owner_id:user.id,patient:name.trim(),phone},date,slot,require('./booking-capacity').duration(catalog,service))) fail(409,'同一就诊人已有重叠时段预约')
    const free = schedules.availableDoctors(date, slot, service)
    const doctor = requestedDoctor === '不限医生' ? free[0] : requestedDoctor
    if (!doctor || !free.includes(doctor)) fail(409, '该时段未开放或已约满，请重新选择')
    const originArticle=body.originArticle || ''
    if(typeof originArticle!=='string'||originArticle.length>100)fail(400,'来源文章无效')
    if(originArticle)articles.detail(user,originArticle)
    const screeningId=body.screeningId||''
    if(typeof screeningId!=='string'||screeningId.length>100)fail(400,'初筛来源无效')
    if(screeningId&&!db.prepare("SELECT 1 FROM screening_cases WHERE id=? AND owner_id=? AND status='reviewed'").get(screeningId,user.id))fail(403,'初筛须由本人管理且已完成医生复核')
    const source=['首页','科普','医生主页','项目资料','初筛复核'].includes(body.source)?body.source:'小程序'
    const id = `AD-${randomUUID()}`
    const timestamp = new Date().toISOString()
    db.prepare('INSERT INTO appointments (id,request_key,patient,phone,service,doctor,date,slot,status,source,note,created_at,updated_at,owner_id,recall_id,member_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id, key, name.trim(), phone, service, doctor, date, slot, '待确认', recallId ? '复查预约' : source, note.trim(), timestamp, timestamp, user.id, recallId, memberId
    )
    db.prepare('UPDATE appointments SET recall_node_id=?,screening_case_id=? WHERE id=?').run(recallNodeId,screeningId,id)
    resources.reserve(id,service)
    db.prepare('UPDATE appointments SET duration_minutes=?,origin_article=? WHERE id=?').run(require('./booking-capacity').duration(catalog,service),originArticle,id)
    db.prepare('INSERT INTO events (appointment_id,from_status,to_status,actor,created_at) VALUES (?,?,?,?,?)').run(id, null, '待确认', 'patient', timestamp)
    db.exec('COMMIT')
    return publicAppointment(db.prepare('SELECT * FROM appointments WHERE id=?').get(id))
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
function changeStatus(id, next, user, version, communicationNote, cancellationReason, scope) {
  db.exec('BEGIN IMMEDIATE')
  try {
    const current = db.prepare('SELECT * FROM appointments WHERE id=?').get(id)
    if (!current) fail(404, '预约不存在')
    if (!(TRANSITIONS[current.status] || []).includes(next)) fail(409, '当前预约状态不允许此操作')
    const actingPatient=(scope || (user.isStaff?'clinic':'mine'))==='mine'
    if(scope!==undefined&&!['mine','clinic'].includes(scope))fail(400,'操作范围无效')
    if(scope==='clinic'&&!user.isStaff)fail(403,'无权执行诊所操作')
    if (actingPatient) {
      if (current.owner_id !== user.id) fail(403, '无权操作此预约')
      if (next === '已取消' || next === '取消申请中') bookingPolicy.deadline(current,'cancel')
      if (!((current.status === '待确认' && next === '已取消') || (current.status === '已预约' && next === '取消申请中'))) fail(403, '患者无权执行该操作')
    } else if (user.role === 'doctor') {
      if (current.doctor !== user.doctorName || !['就诊中','已完成'].includes(next)) fail(403, '仅可完成本人接诊的预约')
    } else if (user.role === 'frontdesk' && next === '已完成') {
      fail(403, '完成接诊需由医生或管理员操作')
    }
    const timestamp = new Date().toISOString()
    if (!Number.isSafeInteger(version) || current.booking_version !== version) fail(409, '预约已变更，请刷新并核实新时间后操作')
    if (next === '爽约' && Date.parse(`${current.date}T${current.slot}:00+08:00`) >= Date.now()) fail(409, '预约时间尚未到，不能标记爽约')
    if (['已取消','取消申请中'].includes(next) && cancellationReason !== undefined && (typeof cancellationReason !== 'string' || !cancellationReason.trim() || cancellationReason.length > 500)) fail(400, '取消原因需为1–500字')
    if (current.status === '待确认' && next === '已预约') confirmations.save(current, user, communicationNote, timestamp)
    db.prepare('UPDATE appointments SET status=?,updated_at=?,booking_version=booking_version+1 WHERE id=?').run(next, timestamp, id)
    db.prepare('INSERT INTO events (appointment_id,from_status,to_status,actor,created_at) VALUES (?,?,?,?,?)').run(id, current.status, next, user.id, timestamp)
    if (next === '已到店') bookingPolicy.enqueue(id)
    if (['就诊中','已完成'].includes(next)) db.prepare("UPDATE waiting_queue SET status='done',updated_at=? WHERE appointment_id=?").run(timestamp,id)
    if (cancellationReason) db.prepare("INSERT INTO booking_rule_events(actor,payload,created_at) VALUES(?,?,?)").run(user.id,JSON.stringify({appointmentId:id,kind:'cancellation',reason:cancellationReason}),timestamp)
    if (next === '已完成') { if(!careAutomation.generate(user,current)) care.draft(current,user);recallSeries.complete(current,user) }
    db.exec('COMMIT')
    return publicAppointment(db.prepare('SELECT * FROM appointments WHERE id=?').get(id))
  } catch (error) { db.exec('ROLLBACK'); throw error }
}
async function readBody(req, limit = 16384) {
  const chunks = []; let bytes = 0
  for await (const chunk of req) {
    chunks.push(chunk); bytes += chunk.length
    if (bytes > limit) fail(413, '请求内容过大')
  }
  const body = Buffer.concat(chunks).toString('utf8')
  try { return JSON.parse(body || '{}') } catch { fail(400, '请求格式无效') }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, `http://${HOST}:${PORT}`)
    if (req.method === 'GET' && url.pathname === '/health') return json(res, 200, { ok: true, mode: process.env.APEX_DEMO_AUTH==='1'?'local-demo':'clinic' })
    if (req.method === 'POST' && url.pathname === '/v1/auth/demo') {
      if (process.env.APEX_DEMO_AUTH !== '1') fail(404, '接口不存在')
      const body = await readBody(req)
      if (!/^[A-Za-z0-9_-]{16,100}$/.test(body.deviceId || '')) fail(400, '演示身份无效')
      return json(res, 200, auth.login(`demo:${body.deviceId}`))
    }
    if (req.method === 'POST' && url.pathname === '/v1/auth/wechat') {
      const body = await readBody(req)
      if (!process.env.APEX_WECHAT_APPID || !process.env.APEX_WECHAT_SECRET) fail(503, '微信登录尚未配置')
      if (typeof body.code !== 'string' || !body.code || body.code.length > 256) fail(400, '微信登录凭证无效')
      const params = new URLSearchParams({ appid: process.env.APEX_WECHAT_APPID, secret: process.env.APEX_WECHAT_SECRET,
        js_code: body.code, grant_type: 'authorization_code' })
      const response = await fetch(`https://api.weixin.qq.com/sns/jscode2session?${params}`, { signal: AbortSignal.timeout(5000) })
      const result = await response.json()
      if (!response.ok || result.errcode || !result.openid) fail(401, '微信登录失败，请重试')
      return json(res, 200, auth.login(`wx:${result.openid}`))
    }
    if (req.method === 'GET' && url.pathname === '/v1/availability') {
      const date = url.searchParams.get('date')
      const doctor = url.searchParams.get('doctor') || '不限医生'
      const service = url.searchParams.get('service') || ''
      if (!validDate(date) || doctor !== '不限医生' && !catalog.names('doctors', true).includes(doctor)) fail(400, '日期或医生无效')
      return json(res, 200, { slots: schedules.availability(date, doctor, service) })
    }
    if(req.method==='POST' && url.pathname==='/v1/payment-callback') {const result=payments.callback(req.headers,await readBody(req));systemOperations.audit({id:'payment-provider',role:'system'},{pathname:url.pathname,method:req.method},200);return json(res,200,result)}
    const user = auth.authenticate(req)
    const writeHead = res.writeHead.bind(res)
    res.writeHead = (status,...args) => {
      try { recordTools.audit(user,{ pathname: url.pathname,method: req.method },status); systemOperations.audit(user,{ pathname:url.pathname,method:req.method },status) } catch (error) { console.error('档案访问日志写入失败:',error.message) }
      return writeHead(status,...args)
    }
    if (req.method === 'GET' && url.pathname === '/v1/record-access-logs') return json(res,200,recordTools.logs(user,url.searchParams))
    if (req.method === 'GET' && url.pathname === '/v1/guardian-checks') return json(res,200,guardians.list(user,url.searchParams))
    if (req.method === 'GET' && url.pathname === '/v1/privacy-requests') { privacy.purgeExpired()
const systemOperations = require('./system-operations').createSystemOperations(db,DATA_DIR); return json(res,200,privacy.list(user,url.searchParams)) }
    if (req.method === 'POST' && url.pathname === '/v1/privacy-requests') return json(res,201,{ request: privacy.submit(user,await readBody(req)) })
    const privacyPath = url.pathname.match(/^\/v1\/privacy-requests\/([^/]+)(\/download)?$/)
    if (privacyPath && req.method === 'PATCH' && !privacyPath[2]) {const result=privacy.update(user,privacyPath[1],await readBody(req));try{systemOperations.purge()}catch(error){systemOperations.alert('backup-cleanup','资料清理已提交，备份清理仍需处理')}return json(res,200,{request:result})}
    if (privacyPath && req.method === 'GET' && privacyPath[2]) {
      const file = privacy.download(user,privacyPath[1],Number(url.searchParams.get('part')||1))
      res.writeHead(200,{ 'Content-Type': 'application/zip','Cache-Control': 'no-store','X-Content-Type-Options': 'nosniff','Content-Disposition': `attachment; filename="apex-records-${privacyPath[1]}.zip"`,'Content-Length': file.bytes.length })
      return res.end(Buffer.from(file.bytes))
    }
    const guardianMemberPath = url.pathname.match(/^\/v1\/members\/([^/]+)\/guardian$/)
    if (guardianMemberPath && req.method === 'GET') return json(res,200,guardians.status(user,guardianMemberPath[1]))
    if (guardianMemberPath && req.method === 'POST') return json(res,201,{ check: await guardians.submit(user,guardianMemberPath[1],url.searchParams,req) })
    const identityConsentPath=url.pathname.match(/^\/v1\/guardian-checks\/([^/]+)\/external-consent$/)
    if(identityConsentPath && req.method==='POST')return json(res,200,identityVerification.consent(user,identityConsentPath[1],await readBody(req)))
    const externalIdentityPath=url.pathname.match(/^\/v1\/guardian-checks\/([^/]+)\/external-verification$/)
    if(externalIdentityPath && req.method==='POST')return json(res,200,await identityVerification.query(user,externalIdentityPath[1],await readBody(req)))
    const guardianPath = url.pathname.match(/^\/v1\/guardian-checks\/([^/]+)(\/evidence)?$/)
    if (guardianPath && req.method === 'PATCH' && !guardianPath[2]) return json(res,200,{ check: guardians.review(user,guardianPath[1],await readBody(req)) })
    if (guardianPath && req.method === 'GET' && guardianPath[2]) {
      const file = guardians.evidence(user,guardianPath[1])
      res.writeHead(200,{ 'Content-Type': file.mime,'Cache-Control': 'no-store','X-Content-Type-Options': 'nosniff','Content-Length': file.bytes.length })
      return res.end(Buffer.from(file.bytes))
    }
    const questionnairePath = url.pathname.match(/^\/v1\/members\/([^/]+)\/questionnaire$/)
    if (questionnairePath && req.method === 'GET') return json(res,200,{ versions: recordTools.questionnaire(user,questionnairePath[1],url.searchParams.get('scope') || 'mine') })
    if (questionnairePath && req.method === 'PUT') return json(res,200,{ questionnaire: recordTools.saveQuestionnaire(user,questionnairePath[1],await readBody(req,65536)) })
    const registrationPath=url.pathname.match(/^\/v1\/members\/([^/]+)\/photo-registration$/)
    if(registrationPath && req.method==='GET'){const scope=url.searchParams.get('scope')||'mine',left=url.searchParams.get('left'),right=url.searchParams.get('right');patientRecords.compare(user,registrationPath[1],left,right,scope);const result=await require('./imaging').registerImages(Buffer.from(patientRecords.read(user,left,scope).bytes),Buffer.from(patientRecords.read(user,right,scope).bytes));return json(res,200,{registration:result})}
    const dicomPreviewPath=url.pathname.match(/^\/v1\/record-attachments\/([^/]+)\/preview$/)
    if(dicomPreviewPath && req.method==='GET'){const file=recordTools.read(user,dicomPreviewPath[1],url.searchParams.get('scope')||'mine');if(file.mime!=='application/dicom')fail(400,'此附件不是DICOM');const result=await require('./imaging').renderDicom(Buffer.from(file.bytes),url.searchParams);res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'no-store','X-DICOM-Frames':result.frames});return res.end(result.bytes)}
    const comparisonPath = url.pathname.match(/^\/v1\/members\/([^/]+)\/photo-comparison$/)
    if (comparisonPath && req.method === 'GET') return json(res,200,{ comparison: patientRecords.compare(user,comparisonPath[1],url.searchParams.get('left'),url.searchParams.get('right'),url.searchParams.get('scope') || 'mine') })
    const attachmentVisitPath = url.pathname.match(/^\/v1\/appointments\/([^/]+)\/attachments$/)
    if (attachmentVisitPath && req.method === 'GET') return json(res,200,{ attachments: recordTools.attachments(user,attachmentVisitPath[1],url.searchParams.get('scope') || 'mine') })
    if (attachmentVisitPath && req.method === 'POST') return json(res,201,{ attachment: await recordTools.upload(user,attachmentVisitPath[1],url.searchParams,req) })
    const attachmentPath = url.pathname.match(/^\/v1\/record-attachments\/([^/]+)$/)
    if (attachmentPath && req.method === 'GET') {
      const file = recordTools.read(user,attachmentPath[1],url.searchParams.get('scope') || 'mine')
      res.writeHead(200,{ 'Content-Type': file.mime,'Cache-Control': 'no-store','X-Content-Type-Options': 'nosniff','Content-Length': file.bytes.length })
      return res.end(Buffer.from(file.bytes))
    }
    if (req.method === 'GET' && url.pathname === '/v1/record-requests') return json(res, 200, recordRequests.list(user, url.searchParams))
    const patientRecordPath = url.pathname.match(/^\/v1\/members\/([^/]+)\/record$/)
    if (req.method === 'GET' && patientRecordPath) return json(res,200,{ record: patientRecords.overview(user,patientRecordPath[1],url.searchParams.get('scope') || 'mine') })
    const recordPhotosPath = url.pathname.match(/^\/v1\/appointments\/([^/]+)\/record-photos$/)
    if (req.method === 'GET' && recordPhotosPath) return json(res,200,{ photos: patientRecords.photos(user,recordPhotosPath[1],url.searchParams.get('scope') || 'mine') })
    if (req.method === 'POST' && recordPhotosPath) return json(res,201,{ photo: await patientRecords.upload(user,recordPhotosPath[1],url.searchParams,req) })
    const recordPhotoPath = url.pathname.match(/^\/v1\/record-photos\/([^/]+)$/)
    if (req.method === 'GET' && recordPhotoPath) {
      const photo = patientRecords.read(user,recordPhotoPath[1],url.searchParams.get('scope') || 'mine')
      res.writeHead(200,{ 'Content-Type': photo.mime,'Cache-Control': 'no-store','X-Content-Type-Options': 'nosniff','Content-Length': photo.bytes.length })
      return res.end(Buffer.from(photo.bytes))
    }
    if (req.method === 'POST' && url.pathname === '/v1/record-requests') return json(res, 201, { request: recordRequests.submit(user, await readBody(req)) })
    const recordRequestPath = url.pathname.match(/^\/v1\/record-requests\/([^/]+)$/)
    if (req.method === 'PATCH' && recordRequestPath) { const result=recordRequests.update(user,recordRequestPath[1],await readBody(req,65536));try{systemOperations.purge()}catch(error){systemOperations.alert('backup-cleanup','资料删除已提交，备份清理仍需处理');console.error('备份清理失败',error.message)}return json(res,200,{request:result}) }
    if (req.method === 'GET' && url.pathname === '/v1/notifications/settings') return json(res,200,notifications.settings(user))
    if (req.method === 'POST' && url.pathname === '/v1/notifications/subscriptions') return json(res,200,notifications.subscribe(user,await readBody(req)))
    if (req.method === 'GET' && url.pathname === '/v1/notifications') return json(res,200,notifications.list(user,url.searchParams))
    if (req.method === 'GET' && url.pathname === '/v1/admin/notifications') return json(res,200,notifications.list(user,url.searchParams,true))
    const notificationPath = url.pathname.match(/^\/v1\/(admin\/)?notifications\/([^/]+)\/(read|retry)$/)
    if (notificationPath && req.method === 'POST') {
      if (notificationPath[1] && notificationPath[3] === 'retry') return json(res,200,notifications.retry(user,notificationPath[2]))
      if (!notificationPath[1] && notificationPath[3] === 'read') return json(res,200,notifications.read(user,notificationPath[2]))
    }
    const invoicesPath=url.pathname.match(/^\/v1\/appointments\/([^/]+)\/invoices$/)
    if(invoicesPath && req.method==='GET')return json(res,200,payments.list(user,invoicesPath[1],url.searchParams.get('scope')||'mine'))
    if(invoicesPath && req.method==='POST')return json(res,201,payments.invoice(user,invoicesPath[1],await readBody(req)))
    const paymentIntentPath=url.pathname.match(/^\/v1\/invoices\/([^/]+)\/pay$/)
    if(paymentIntentPath && req.method==='POST')return json(res,200,await payments.intent(user,paymentIntentPath[1],await readBody(req)))
    const triagePath=url.pathname.match(/^\/v1\/care-tasks\/([^/]+)\/triage$/)
    if(triagePath && req.method==='POST')return json(res,200,{triage:careTriage.save(user,triagePath[1],await readBody(req))})
    const recallSeriesPath=url.pathname.match(/^\/v1\/appointments\/([^/]+)\/recall-series$/)
    if(recallSeriesPath && req.method==='GET')return json(res,200,{items:recallSeries.list(user,url.searchParams.get('scope')||'mine',recallSeriesPath[1])})
    if(recallSeriesPath && req.method==='POST')return json(res,200,recallSeries.save(user,recallSeriesPath[1],await readBody(req)))
    if(req.method==='GET' && url.pathname==='/v1/admin/screening-statistics')return json(res,200,screening.statistics(user))
    const billingPath=url.pathname.match(/^\/v1\/appointments\/([^/]+)\/billing$/)
    if(billingPath && req.method==='GET')return json(res,200,billing.list(user,billingPath[1],url.searchParams.get('scope')||'mine'))
    if(billingPath && req.method==='POST')return json(res,200,billing.save(user,billingPath[1],await readBody(req)))
    if(req.method==='GET' && url.pathname==='/v1/admin/billing-statistics')return json(res,200,billing.statistics(user,url.searchParams))
    const templateReviewPath=url.pathname.match(/^\/v1\/care-templates\/([^/]+)\/review$/)
    if(templateReviewPath && req.method==='POST')return json(res,200,{template:careTemplates.review(user,templateReviewPath[1],await readBody(req))})
    if(req.method==='GET' && url.pathname==='/v1/care-recipes')return json(res,200,careAutomation.list(user))
    if(req.method==='POST' && url.pathname==='/v1/care-recipes')return json(res,200,careAutomation.save(user,await readBody(req,131072)))
    const recipeReviewPath=url.pathname.match(/^\/v1\/care-recipes\/([^/]+)\/review$/)
    if(recipeReviewPath && req.method==='POST')return json(res,200,careAutomation.review(user,recipeReviewPath[1],await readBody(req)))
    if(req.method==='GET' && url.pathname==='/v1/admin/resources')return json(res,200,resources.list(user))
    if(req.method==='POST' && url.pathname==='/v1/admin/resources')return json(res,200,resources.save(user,await readBody(req)))
    if(req.method==='POST' && url.pathname==='/v1/admin/resource-services')return json(res,200,resources.link(user,await readBody(req)))
    if(req.method==='POST' && url.pathname==='/v1/admin/closures')return json(res,200,resources.close(user,await readBody(req)))
    const mediaUploadPath=url.pathname.match(/^\/v1\/admin\/content-media\/(article|avatar)\/([^/]+)$/)
    if(mediaUploadPath && req.method==='POST')return json(res,201,await contentMedia.upload(user,mediaUploadPath[1],routeId(mediaUploadPath[2]),url.searchParams,req))
    const mediaPath=url.pathname.match(/^\/v1\/content-media\/([^/]+)$/)
    if(mediaPath && req.method==='GET'){const file=contentMedia.read(user,mediaPath[1]);res.writeHead(200,{'Content-Type':file.mime,'Cache-Control':'no-store'});return res.end(Buffer.from(file.bytes))}
    if(req.method==='GET' && url.pathname==='/v1/screenings')return json(res,200,screening.list(user,url.searchParams.get('scope')==='clinic'))
    if(req.method==='POST' && url.pathname==='/v1/screenings')return json(res,201,{screening:screening.start(user,await readBody(req))})
    const screeningPath=url.pathname.match(/^\/v1\/screenings\/([^/]+)(?:\/(photos|submit|review))?$/)
    if(screeningPath && req.method==='GET' && !screeningPath[2])return json(res,200,{screening:screening.detail(user,screeningPath[1],url.searchParams.get('scope')==='clinic')})
    if(screeningPath && req.method==='POST'){const id=screeningPath[1];if(screeningPath[2]==='photos')return json(res,201,{screening:await screening.upload(user,id,url.searchParams.get('angle'),req)});if(screeningPath[2]==='submit')return json(res,200,{screening:await screening.submit(user,id,await readBody(req))});if(screeningPath[2]==='review')return json(res,200,{screening:screening.review(user,id,await readBody(req))})}
    const screeningImagePath=url.pathname.match(/^\/v1\/screening-images\/([^/]+)$/)
    if(screeningImagePath && req.method==='GET'){const file=screening.image(user,screeningImagePath[1],url.searchParams.get('scope')==='clinic');res.writeHead(200,{'Content-Type':file.mime,'Cache-Control':'no-store'});return res.end(Buffer.from(file.bytes))}
    if(req.method==='GET' && url.pathname==='/v1/admin/system')return json(res,200,systemOperations.status(user))
    if(req.method==='GET' && url.pathname==='/v1/admin/audit')return json(res,200,systemOperations.logs(user,url.searchParams))
    if(req.method==='POST' && url.pathname==='/v1/admin/backups')return json(res,201,await systemOperations.take(user))
    const backupPath=url.pathname.match(/^\/v1\/admin\/backups\/([^/]+)\/verify$/)
    if(backupPath && req.method==='POST')return json(res,200,systemOperations.verify(user,backupPath[1]))
    if(req.method==='GET' && url.pathname==='/v1/daily-habits')return json(res,200,longitudinal.habits(user))
    if(req.method==='POST' && url.pathname==='/v1/daily-habits')return json(res,200,longitudinal.checkHabit(user,await readBody(req)))
    if(req.method==='GET' && url.pathname==='/v1/privacy-document')return json(res,200,longitudinal.document(user))
    if(req.method==='POST' && url.pathname==='/v1/privacy-consent')return json(res,200,longitudinal.consent(user,await readBody(req)))
    if(req.method==='POST' && url.pathname==='/v1/admin/privacy-document')return json(res,200,longitudinal.publishDocument(user,await readBody(req,131072)))
    const longitudinalPath=url.pathname.match(/^\/v1\/appointments\/([^/]+)\/(treatment-stages|tooth-states|summary-acknowledgment)$/)
    if(longitudinalPath && req.method==='GET')return json(res,200,longitudinal.list(user,longitudinalPath[1],url.searchParams.get('scope')||'mine'))
    if(longitudinalPath && req.method==='POST'){const body=await readBody(req);return json(res,200,longitudinalPath[2]==='treatment-stages'?longitudinal.saveStage(user,longitudinalPath[1],body):longitudinalPath[2]==='tooth-states'?longitudinal.saveTooth(user,longitudinalPath[1],body):longitudinal.acknowledge(user,longitudinalPath[1],body))}
    if (req.method === 'GET' && url.pathname === '/v1/booking-rules') return json(res,200,bookingPolicy.rules())
    if (req.method === 'PUT' && url.pathname === '/v1/admin/booking-rules') return json(res,200,bookingPolicy.save(user,await readBody(req)))
    if (req.method === 'GET' && url.pathname === '/v1/reschedule-requests') return json(res,200,{items:bookingPolicy.list(user,url.searchParams.get('scope'))})
    const requestPath=url.pathname.match(/^\/v1\/reschedule-requests\/([^/]+)$/)
    if(requestPath && req.method==='POST') return json(res,200,bookingPolicy.review(user,requestPath[1],await readBody(req),rescheduling))
    const rescheduleRequestPath=url.pathname.match(/^\/v1\/appointments\/([^/]+)\/reschedule-request$/)
    if(rescheduleRequestPath && req.method==='POST')return json(res,201,{request:bookingPolicy.submit(user,rescheduleRequestPath[1],await readBody(req))})
    const checkInPath=url.pathname.match(/^\/v1\/appointments\/([^/]+)\/check-in$/)
    if(checkInPath && req.method==='POST')return json(res,200,bookingPolicy.checkIn(user,checkInPath[1],(await readBody(req)).version))
    if(req.method==='GET' && url.pathname==='/v1/waiting-queue')return json(res,200,bookingPolicy.queue(user,url.searchParams.get('scope')))
    const queuePath=url.pathname.match(/^\/v1\/waiting-queue\/([^/]+)$/)
    if(queuePath && req.method==='POST')return json(res,200,bookingPolicy.call(user,queuePath[1],await readBody(req)))
    if (req.method === 'GET' && url.pathname === '/v1/reading-library') return json(res,200,contentFeatures.library(user,url.searchParams))
    if (req.method === 'GET' && url.pathname === '/v1/content-recommendations') return json(res,200,contentFeatures.recommend(user,url.searchParams))
    if (req.method === 'GET' && url.pathname === '/v1/admin/content-statistics') return json(res,200,contentFeatures.stats(user))
    const activityPath = url.pathname.match(/^\/v1\/articles\/([^/]+)\/(activity|favorite)$/)
    if (activityPath && req.method === 'GET' && activityPath[2] === 'favorite') return json(res,200,contentFeatures.state(user,activityPath[1]))
    if (activityPath && req.method === 'POST') return json(res,200,activityPath[2] === 'favorite' ? contentFeatures.favorite(user,activityPath[1],await readBody(req)) : contentFeatures.activity(user,activityPath[1],await readBody(req)))
    if (req.method === 'GET' && url.pathname === '/v1/content-reviews') return json(res,200,articles.reviewList(user,url.searchParams))
    const reviewPath = url.pathname.match(/^\/v1\/content-reviews\/([^/]+)$/)
    if (reviewPath && req.method === 'GET') return json(res,200,{ article: articles.reviewDetail(user,reviewPath[1]) })
    if (reviewPath && req.method === 'POST') return json(res,200,{ article: articles.review(user,reviewPath[1],await readBody(req)) })
    if(req.method==='GET' && url.pathname==='/v1/doctor/articles')return json(res,200,articles.doctorList(user,url.searchParams))
    if(req.method==='POST' && url.pathname==='/v1/doctor/articles')return json(res,201,{article:articles.doctorSave(user,await readBody(req,131072))})
    const doctorArticlePath=url.pathname.match(/^\/v1\/doctor\/articles\/([^/]+)$/)
    if(doctorArticlePath && req.method==='GET')return json(res,200,{article:articles.doctorDetail(user,doctorArticlePath[1])})
    if(doctorArticlePath && req.method==='PUT')return json(res,200,{article:articles.doctorSave(user,await readBody(req,131072),doctorArticlePath[1])})
    if (req.method === 'GET' && url.pathname === '/v1/articles') return json(res,200,articles.list(user,url.searchParams))
    if (req.method === 'GET' && url.pathname === '/v1/admin/articles') return json(res,200,articles.list(user,url.searchParams,true))
    if (req.method === 'POST' && url.pathname === '/v1/admin/articles') return json(res,201,{ article: articles.save(user,await readBody(req,131072)) })
    const articlePath = url.pathname.match(/^\/v1\/(admin\/)?articles\/([^/]+)(\/status)?$/)
    if (articlePath && req.method === 'GET' && !articlePath[3]) return json(res,200,{ article: articles.detail(user,articlePath[2],!!articlePath[1]) })
    if (articlePath && articlePath[1] && req.method === 'PUT' && !articlePath[3]) return json(res,200,{ article: articles.save(user,await readBody(req,131072),articlePath[2]) })
    if (articlePath && articlePath[1] && req.method === 'POST' && articlePath[3]) return json(res,200,{ article: articles.changeStatus(user,articlePath[2],await readBody(req)) })
    const articleCategoryPath = url.pathname.match(/^\/v1\/admin\/article-categories(?:\/([^/]+))?$/)
    if (articleCategoryPath && (req.method === 'PUT' && articleCategoryPath[1] || req.method === 'POST' && !articleCategoryPath[1])) return json(res,200,{ category: articles.saveCategory(user,await readBody(req),articleCategoryPath[1]) })
    if (req.method === 'GET' && url.pathname === '/v1/catalog') return json(res,200,{...catalog.list(user), avatars:catalog.entries('doctors').map(row=>({doctorId:row.id,media:contentMedia.list('avatar',row.id)[0]||null}))})
    if (req.method === 'GET' && url.pathname === '/v1/admin/catalog') return json(res,200,catalog.list(user,true))
    const doctorVerifyPath=url.pathname.match(/^\/v1\/admin\/catalog\/doctors\/([^/]+)\/verify$/)
    if(doctorVerifyPath && req.method==='POST')return json(res,200,catalog.verify(user,routeId(doctorVerifyPath[1]),await readBody(req)))
    const catalogPath = url.pathname.match(/^\/v1\/admin\/catalog\/(clinic|doctors|services)(?:\/([^/]+))?$/)
    if (catalogPath && ((catalogPath[1] === 'clinic' || catalogPath[2]) && req.method === 'PUT' || catalogPath[1] !== 'clinic' && !catalogPath[2] && req.method === 'POST')) return json(res,200,{ entry: catalog.save(user,catalogPath[1],await readBody(req),catalogPath[2] ? decodeURIComponent(catalogPath[2]) : undefined) })
    if (req.method === 'POST' && url.pathname === '/v1/member-shares/preview') return json(res,200,{ preview: sharing.preview(user,(await readBody(req)).code) })
    if (req.method === 'POST' && url.pathname === '/v1/member-shares/accept') return json(res,200,sharing.accept(user,await readBody(req)))
    const shareMemberPath = url.pathname.match(/^\/v1\/members\/([^/]+)\/shares$/)
    if (shareMemberPath && req.method === 'GET') return json(res,200,sharing.list(user,shareMemberPath[1]))
    if (shareMemberPath && req.method === 'POST') return json(res,201,{ invite: sharing.invite(user,shareMemberPath[1]) })
    const revokeSharePath = url.pathname.match(/^\/v1\/(member-shares|member-share-invites)\/([^/]+)\/revoke$/)
    if (revokeSharePath && req.method === 'POST') return json(res,200,sharing.revoke(user,revokeSharePath[2],revokeSharePath[1] === 'member-share-invites'))
    const taskPhotosPath = url.pathname.match(/^\/v1\/care-tasks\/([^/]+)\/photos$/)
    if (taskPhotosPath && req.method === 'GET') return json(res,200,{ photos: carePhotos.list(user,taskPhotosPath[1]) })
    if (taskPhotosPath && req.method === 'POST') return json(res,201,{ photo: await carePhotos.upload(user,taskPhotosPath[1],url.searchParams.get('requestKey'),req) })
    const photoPath = url.pathname.match(/^\/v1\/care-photos\/([^/]+)$/)
    if (photoPath && req.method === 'DELETE') return json(res,200,carePhotos.remove(user,photoPath[1]))
    if (photoPath && req.method === 'GET') {
      const photo = carePhotos.read(user,photoPath[1])
      res.writeHead(200,{ 'Content-Type': photo.mime,'Cache-Control': 'no-store','X-Content-Type-Options': 'nosniff','Content-Length': photo.bytes.length })
      return res.end(Buffer.from(photo.bytes))
    }
    if (req.method === 'POST' && url.pathname === '/v1/admin/schedules/batch-preview') return json(res,200,{ preview: schedules.previewBatch(user,await readBody(req)) })
    if (req.method === 'POST' && url.pathname === '/v1/admin/schedules/batch-commit') return json(res,200,{ result: schedules.commitBatch(user,await readBody(req)) })
    if (req.method === 'GET' && url.pathname === '/v1/members') return json(res,200,{ members: members.list(user) })
    if (req.method === 'POST' && url.pathname === '/v1/members') return json(res,201,{ member: members.save(user,await readBody(req)) })
    const memberPath = url.pathname.match(/^\/v1\/members\/([^/]+)$/)
    if (req.method === 'PUT' && memberPath) return json(res,200,{ member: members.save(user,await readBody(req),memberPath[1]) })
    const assignmentPath = url.pathname.match(/^\/v1\/appointments\/([^/]+)\/member$/)
    if (req.method === 'PUT' && assignmentPath) return json(res,200,members.assign(user,assignmentPath[1],(await readBody(req)).memberId))
    if (req.method === 'GET' && url.pathname === '/v1/care-templates') return json(res, 200, { templates: careTemplates.list(user, url.searchParams.get('includeDisabled') === '1') })
    if (req.method === 'POST' && url.pathname === '/v1/care-templates') return json(res, 201, { template: careTemplates.save(user, await readBody(req)) })
    const templatePath = url.pathname.match(/^\/v1\/care-templates\/([^/]+)$/)
    if (req.method === 'PUT' && templatePath) return json(res, 200, { template: careTemplates.save(user, await readBody(req), templatePath[1]) })
    if (req.method === 'GET' && url.pathname === '/v1/worklist') return json(res, 200, { worklist: worklist.list(user) })
    if (req.method === 'GET' && url.pathname === '/v1/statistics') return json(res, 200, { statistics: statistics.summary(user, url.searchParams) })
    if (req.method === 'GET' && url.pathname === '/v1/records') return json(res, 200, { records: recordSearch.list(user, url.searchParams) })
    const followupPath = url.pathname.match(/^\/v1\/appointments\/([^/]+)\/recall-followup$/)
    if (req.method === 'POST' && followupPath) return json(res, 200, recalls.saveFollowup(user, followupPath[1], await readBody(req)))
    if (url.pathname === '/v1/admin/schedules') {
      auth.requireAdmin(user)
      if (req.method === 'GET') {
        const date = url.searchParams.get('date'), doctor = url.searchParams.get('doctor')
        if (!validDate(date) || !DOCTORS.includes(doctor)) fail(400, '日期或医生无效')
        return json(res, 200, { schedule: schedules.day(doctor, date) })
      }
      if (req.method === 'PUT') return json(res, 200, { schedule: schedules.save(user, await readBody(req)) })
    }
    if (req.method === 'GET' && url.pathname === '/v1/me') return json(res, 200, { profile: user })
    if (req.method === 'POST' && url.pathname === '/v1/staff/claim') {
      const body = await readBody(req)
      return json(res, 200, { profile: auth.claim(user, body.code, body.displayName) })
    }
    if (req.method === 'GET' && url.pathname === '/v1/staff') return json(res, 200, { staff: auth.listStaff(user) })
    const staffPath = url.pathname.match(/^\/v1\/staff\/([^/]+)\/disable$/)
    if (req.method === 'POST' && staffPath) return json(res, 200, auth.disableStaff(user, staffPath[1]))
    if (req.method === 'POST' && url.pathname === '/v1/staff/invites') {
      const body = await readBody(req)
      return json(res, 201, auth.createInvite(user, body.role, body.doctorName))
    }
    if (req.method === 'GET' && url.pathname === '/v1/appointments') {
      if (url.searchParams.get('scope') === 'clinic') auth.requireStaff(user)
      return json(res, 200, { appointments: listAppointments(user, url.searchParams.get('scope')) })
    }
    const historyPath = url.pathname.match(/^\/v1\/appointments\/([^/]+)\/history$/)
    const reschedulePath = url.pathname.match(/^\/v1\/appointments\/([^/]+)\/reschedule$/)
    if (reschedulePath && req.method === 'GET') return json(res, 200, { appointment: rescheduling.get(user, reschedulePath[1], url.searchParams.get('scope') || 'mine') })
    if (reschedulePath && req.method === 'POST') { const body=await readBody(req); const row=db.prepare('SELECT * FROM appointments WHERE id=?').get(reschedulePath[1]); if(row && (body.scope || 'mine') === 'mine') bookingPolicy.deadline(row,'reschedule'); return json(res,200,rescheduling.save(user,reschedulePath[1],body)) }
    if (req.method === 'GET' && historyPath) return json(res, 200, { history: history.detail(user, historyPath[1], url.searchParams.get('scope')) })
    const summaryPath = url.pathname.match(/^\/v1\/appointments\/([^/]+)\/summary$/)
    if (req.method === 'PUT' && summaryPath) return json(res, 200, { summary: visits.save(user, summaryPath[1], await readBody(req, 65536)) })
    if (req.method === 'GET' && url.pathname === '/v1/recalls') return json(res, 200, { recalls: [...recalls.list(user, url.searchParams.get('scope')),...recallSeries.list(user,url.searchParams.get('scope'))] })
    const recallPath = url.pathname.match(/^\/v1\/appointments\/([^/]+)\/recall$/)
    if (req.method === 'PUT' && recallPath) return json(res, 200, { recall: recalls.save(user, recallPath[1], await readBody(req)) })
    if (req.method === 'GET' && url.pathname === '/v1/care-plans') return json(res, 200, { plans: carePlans.list(user, url.searchParams.get('scope')) })
    if (req.method === 'POST' && url.pathname === '/v1/care-plans') return json(res, 201, { plan: carePlans.save(user, await readBody(req)) })
    const planManagePath=url.pathname.match(/^\/v1\/care-plans\/([^/]+)\/manage$/)
    if(planManagePath && req.method==='POST')return json(res,200,{plan:carePlans.manage(user,planManagePath[1],await readBody(req))})
    const planPath = url.pathname.match(/^\/v1\/care-plans\/([^/]+)(\/publish)?$/)
    if (planPath && req.method === 'GET' && !planPath[2]) return json(res, 200, { plan: carePlans.detail(user, planPath[1], url.searchParams.get('scope')) })
    if (planPath && req.method === 'PUT' && !planPath[2]) return json(res, 200, { plan: carePlans.save(user, await readBody(req), planPath[1]) })
    if (planPath && req.method === 'POST' && planPath[2]) return json(res, 200, { plan: carePlans.publish(user, planPath[1], await readBody(req)) })
    if (req.method === 'GET' && url.pathname === '/v1/care-tasks') return json(res, 200, { tasks: care.list(user, url.searchParams.get('scope')) })
    if (req.method === 'POST' && url.pathname === '/v1/care-tasks') return json(res, 201, { task: care.publish(user, await readBody(req), null, careTemplates) })
    const carePath = url.pathname.match(/^\/v1\/care-tasks\/([^/]+)\/(publish|feedback|resolve|followup)$/)
    if (req.method === 'POST' && carePath) {
      const body = await readBody(req)
      const result = carePath[2] === 'publish' ? care.publish(user, body, carePath[1], careTemplates)
        : carePath[2] === 'feedback' ? care.feedback(user, carePath[1], body) : carePath[2] === 'followup' ? care.followup(user, carePath[1], body) : care.resolve(user, carePath[1], body)
      return json(res, 200, { task: result })
    }
    if (req.method === 'POST' && url.pathname === '/v1/appointments') return json(res, 201, { appointment: create(await readBody(req), user) })
    const appointmentPath = url.pathname.match(/^\/v1\/appointments\/([^/]+)\/status$/)
    if (req.method === 'PATCH' && appointmentPath) {
      const body = await readBody(req)
      return json(res, 200, { appointment: changeStatus(appointmentPath[1], body.status, user, body.version, body.communicationNote, body.cancellationReason, body.scope) })
    }
    fail(404, '接口不存在')
  } catch (error) {
    if (!error.status) console.error(error)
    json(res, error.status || 500, { error: error.status ? error.message : '服务暂时不可用' })
  }
})
server.listen(PORT, HOST, () => console.log(`ApexDental local demo API: http://${HOST}:${PORT}`))
const notificationTimer = setInterval(() => { try {bookingPolicy.expire();careAutomation.release()} catch(error){console.error('预约超时处理失败',error.message)}; notifications.tick().catch(error => console.error('提醒队列处理失败', error.message)) }, 60000)
notificationTimer.unref()
notifications.tick().catch(error => console.error('提醒队列初始化失败', error.message))
try {careAutomation.release()}catch(error){console.error('护理节点释放失败',error.message)}
const backupTimer=setInterval(()=>systemOperations.tick().catch(error=>console.error('自动备份失败',error.message)),3600000);backupTimer.unref()
systemOperations.tick().catch(error=>console.error('自动备份失败',error.message))
server.on('close', () => {clearInterval(notificationTimer);clearInterval(backupTimer);systemOperations.close()})
