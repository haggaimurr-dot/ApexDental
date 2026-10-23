const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-record-requests-'))
  const database = path.join(directory, 'check.sqlite'), port = 21000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], { windowsHide: true, stdio: ['ignore','pipe','pipe'],
    env: { ...process.env, APEX_DEMO_AUTH: '1', APEX_PORT: String(port), APEX_DATA_DIR: directory, APEX_DB_PATH: database, APEX_WECHAT_APPID: '', APEX_WECHAT_SECRET: '', APEX_WECHAT_TEMPLATES: '{}' } })
  let output = '', db
  child.stderr.on('data', chunk => { output += chunk }); child.stdout.resume()
  async function request(method, route, token, body, expected = 200) {
    const response = await fetch('http://127.0.0.1:' + port + route, { method, signal: AbortSignal.timeout(4000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result
  }
  try {
    let ready = false
    for (let attempt = 0; attempt < 40; attempt++) { try { await request('GET', '/health'); ready = true; break } catch { await new Promise(resolve => setTimeout(resolve, 100)) } }
    assert.ok(ready, output)
    const login = deviceId => request('POST', '/v1/auth/demo', '', { deviceId })
    const patient = await login('record-request-patient'), other = await login('record-request-other-user'), admin = await login('record-request-admin-user')
    await request('POST', '/v1/staff/claim', admin.token, { code: fs.readFileSync(path.join(directory, 'bootstrap-code.txt'), 'utf8').trim(), displayName: '资料管理员' })
    const desk = await login('record-request-frontdesk'), doctor = await login('record-request-doctor-user')
    for (const [account, role] of [[desk,'frontdesk'], [doctor,'doctor']]) {
      const invite = await request('POST', '/v1/staff/invites', admin.token, { role, ...(role === 'doctor' ? { doctorName: '李医生' } : {}) }, 201)
      await request('POST', '/v1/staff/claim', account.token, { code: invite.code, displayName: '资料测试员工' })
    }
    db = new DatabaseSync(database)
    const stamp = new Date().toISOString()
    db.prepare('INSERT INTO appointments (id,request_key,patient,phone,service,doctor,date,slot,status,source,note,created_at,updated_at,owner_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('record-visit','record-booking','测试患者','13800000000','洁牙护理','李医生','2026-10-05','10:00','已完成','测试','保留原始资料',stamp,stamp,patient.profile.id)
    db.prepare('INSERT INTO family_members VALUES (?,?,?,?,?,?,?,?,?)').run('shared-member', patient.profile.id, '测试患者', '本人', '13800000000', 1, 1, 'member-key', stamp)
    db.prepare('UPDATE appointments SET member_id=? WHERE id=?').run('shared-member', 'record-visit')
    db.prepare('INSERT INTO member_shares VALUES (?,?,?,?,?,?,?,?)').run('share-id', 'shared-member', patient.profile.id, other.profile.id, '只读家人', 1, 'share-hash', stamp)

    const outsider = await login('record-outsider-user')
    const memberRoute = '/v1/members/shared-member/record'
    const summaryRoute = '/v1/appointments/record-visit/summary'
    const summaryBody = { version: 0, findings: '发现龋坏', treatment: '完成充填', nextSteps: '按期复查', structured: { diagnosis: '龋齿', teeth: ['36','11','36'], procedure: '树脂充填', materials: '复合树脂' } }
    await request('PUT', summaryRoute, patient.token, summaryBody, 403)
    await request('PUT', summaryRoute, doctor.token, { ...summaryBody,structured: { teeth: ['99'] } },400)
    const saved = (await request('PUT', summaryRoute,doctor.token,summaryBody)).summary
    assert.deepEqual(saved.structured.teeth,['11','36'])
    assert.equal((await request('PUT',summaryRoute,doctor.token,summaryBody)).summary.version,1)
    await request('PUT',summaryRoute,doctor.token,{ ...summaryBody,structured: { diagnosis: '冲突' } },409)
    // A same-named member and another physician must not be merged or exposed.
    db.prepare('INSERT INTO family_members VALUES (?,?,?,?,?,?,?,?,?)').run('same-name-member',patient.profile.id,'测试患者','子女','13800000000',1,1,'same-name-key',stamp)
    const insertVisit = db.prepare('INSERT INTO appointments (id,request_key,patient,phone,service,doctor,date,slot,status,source,created_at,updated_at,owner_id,member_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    insertVisit.run('second-visit','second-key','测试患者','13800000000','口腔检查','王医生','2026-09-01','09:00','已完成','测试',stamp,stamp,patient.profile.id,'shared-member')
    insertVisit.run('same-name-visit','same-name-visit-key','测试患者','13800000000','口腔检查','李医生','2026-09-02','09:00','已完成','测试',stamp,stamp,patient.profile.id,'same-name-member')
    db.prepare('INSERT INTO events (appointment_id,from_status,to_status,actor,created_at) VALUES (?,?,?,?,?)').run('record-visit','已到店','已完成','doctor','2026-10-02T01:00:00.000Z')
    db.prepare('INSERT INTO events (appointment_id,from_status,to_status,actor,created_at) VALUES (?,?,?,?,?)').run('second-visit','已到店','已完成','doctor','2026-09-01T01:00:00.000Z')
    let record = (await request('GET',memberRoute,patient.token)).record
    assert.equal(record.stats.visits,2); assert.equal(record.stats.completed,2)
    assert.ok(record.entries.every(row => ['record-visit','second-visit'].includes(row.appointmentId)))
    assert.ok(record.entries.some(row => row.text.includes('诊断：龋齿')))
    assert.ok(record.entries.every((row,index) => !index || record.entries[index-1].at >= row.at))
    assert.equal((await request('GET',memberRoute + '?scope=clinic',doctor.token)).record.stats.visits,1)
    await request('GET',memberRoute + '?scope=clinic',desk.token,undefined,403)
    await request('GET',memberRoute + '?scope=clinic',patient.token,undefined,403)
    await request('GET',memberRoute,outsider.token,undefined,403)
    await request('GET',memberRoute + '?scope=invalid',patient.token,undefined,400)
    assert.equal((await request('GET',memberRoute,other.token)).record.member.mayManage,false)
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=','base64')
    async function upload(token,key='archive-key',bytes=png,category='治疗后') {
      const response = await fetch('http://127.0.0.1:' + port + '/v1/appointments/record-visit/record-photos?requestKey=' + key + '&category=' + encodeURIComponent(category) + '&caption=' + encodeURIComponent('36 牙充填后'),{ method: 'POST',headers: { authorization: 'Bearer ' + token },body: bytes })
      return { status: response.status,body: await response.json() }
    }
    assert.equal((await upload(patient.token)).status,403)
    assert.equal((await upload(other.token)).status,403)
    assert.equal((await upload(doctor.token,'bad',Buffer.from('bad'))).status,400)
    assert.equal((await upload(doctor.token,'too-large',Buffer.alloc(3*1024*1024+1))).status,413)
    const uploaded = await upload(doctor.token)
    assert.equal(uploaded.status,201)
    const photo = uploaded.body.photo
    assert.equal((await upload(doctor.token)).body.photo.id,photo.id)
    assert.equal((await upload(doctor.token,'archive-key',png,'治疗前')).status,409)
    assert.equal((await request('GET','/v1/appointments/record-visit/record-photos',other.token)).photos.length,1)
    const photoRoute = '/v1/record-photos/' + photo.id
    async function download(route,token,expected) {
      const response = await fetch('http://127.0.0.1:' + port + route,{headers: { authorization: 'Bearer ' + token }})
      assert.equal(response.status,expected)
      if (expected === 200) { assert.equal(response.headers.get('cache-control'),'no-store'); assert.deepEqual(Buffer.from(await response.arrayBuffer()),png) }
    }
    await download(photoRoute,other.token,200)
    await download(photoRoute,outsider.token,403)
    await download(photoRoute + '?scope=clinic',desk.token,403)
    await request('POST','/v1/member-shares/share-id/revoke',patient.token,{})
    await request('GET',memberRoute,other.token,undefined,403)
    await download(photoRoute,other.token,403)
    db.prepare('UPDATE member_shares SET enabled=1 WHERE id=?').run('share-id')
    // Add all dependent payload types, including draft photos and plan snapshots.
    db.prepare('INSERT INTO care_tasks VALUES (?,?,?,?,?,?,?,?,?,?)').run('care-delete','record-visit','护理','说明','2026-10-05','resolved','care-key',admin.profile.id,stamp,stamp)
    db.prepare('INSERT INTO care_feedback VALUES (?,?,?,?,?,?,?)').run('care-delete','轻微不适',0,0,'恢复良好',0,stamp)
    db.prepare('INSERT INTO care_resolutions VALUES (?,?,?,?)').run('care-delete',admin.profile.id,'继续护理',stamp)
    db.prepare('INSERT INTO care_events (task_id,actor,action,created_at) VALUES (?,?,?,?)').run('care-delete',admin.profile.id,'resolved',stamp)
    for (const [id,attached] of [['recovery-photo',1],['draft-photo',0]]) db.prepare('INSERT INTO care_photos VALUES (?,?,?,?,?,?,?,?,?)').run(id,'care-delete',patient.profile.id,'image/png',png,'digest',id,attached,stamp)
    db.prepare('INSERT INTO care_plans VALUES (?,?,?,?,?,?,?,?,?,?)').run('plan-delete','record-visit','护理计划','[]','published',1,'plan-key',admin.profile.id,stamp,stamp)
    db.prepare('INSERT INTO care_plan_nodes VALUES (?,?,?)').run('plan-delete','care-delete',0)
    db.prepare('INSERT INTO care_plan_events (plan_id,actor,action,version,snapshot,created_at) VALUES (?,?,?,?,?,?)').run('plan-delete',admin.profile.id,'publish',1,'医疗内容',stamp)
    db.prepare('INSERT INTO recall_plans VALUES (?,?,?,?,?,?)').run('record-visit','2026-11-01','复查',1,admin.profile.id,stamp)
    db.prepare('INSERT INTO recall_events (appointment_id,due_date,instructions,version,actor,created_at) VALUES (?,?,?,?,?,?)').run('record-visit','2026-11-01','复查',1,admin.profile.id,stamp)
    db.prepare('INSERT INTO recall_followups (appointment_id,plan_version,note,next_contact_date,actor,request_key,created_at) VALUES (?,?,?,?,?,?,?)').run('record-visit',1,'跟进','2026-11-01',admin.profile.id,'followup-key',stamp)
    db.prepare('INSERT INTO tasks VALUES (?,?,?,?,?,?,?)').run('legacy-delete','record-visit','测试患者','旧护理','说明','已处理',stamp)
    db.prepare('INSERT INTO notification_messages (id,dedupe_key,owner_id,appointment_id,kind,source_id,snapshot,title,body,created_at,expires_at,next_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)').run('message-delete','message-key',patient.profile.id,'record-visit','care','care-delete','医疗快照','护理提醒','医疗说明',stamp,'2099-01-01T00:00:00.000Z',stamp)
    db.prepare('INSERT INTO notification_attempts (message_id,attempted_at,outcome,code,detail) VALUES (?,?,?,?,?)').run('message-delete',stamp,'failed','test','医疗信息')
    record = (await request('GET',memberRoute,patient.token)).record
    assert.equal(record.stats.photos,2); assert.equal(record.recalls.length,1)
    await download('/v1/care-photos/recovery-photo',other.token,200)
    // Corrections change the record in the same transaction as the audit.
    const correction = (await request('POST','/v1/record-requests',patient.token,{ appointmentId: 'record-visit',kind: 'correction',details: '更正诊断',requestKey: 'correction-key' },201)).request
    const correctionRoute = '/v1/record-requests/' + correction.id
    await request('PATCH',correctionRoute,admin.token,{ status: 'processing',version: 1,note: '核验' })
    const completion = { status: 'completed',version: 2,note: '已更正',confirmed: true,correction: { ...summaryBody,version: 1,structured: { ...summaryBody.structured,diagnosis: '牙体缺损' } } }
    db.exec("CREATE TRIGGER fail_request_audit BEFORE INSERT ON record_request_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
    await request('PATCH',correctionRoute,admin.token,completion,500)
    assert.equal(db.prepare('SELECT MAX(version) AS v FROM visit_summaries WHERE appointment_id=?').get('record-visit').v,1)
    db.exec('DROP TRIGGER fail_request_audit')
    await request('PATCH',correctionRoute,admin.token,completion)
    assert.equal((await request('GET','/v1/appointments/record-visit/history',patient.token)).history.summary.structured.diagnosis,'牙体缺损')
    const pending = (await request('POST','/v1/record-requests',patient.token,{ appointmentId: 'record-visit',kind: 'correction',details: '待处理更正',requestKey: 'pending-key' },201)).request
    const deletion = (await request('POST','/v1/record-requests',patient.token,{ appointmentId: 'record-visit',kind: 'deletion',details: '删除医疗内容',requestKey: 'deletion-key' },201)).request
    const deletionRoute = '/v1/record-requests/' + deletion.id
    await request('PATCH',deletionRoute,admin.token,{ status: 'processing',version: 1,note: '核验范围' })
    db.exec("CREATE TRIGGER fail_request_audit BEFORE INSERT ON record_request_events BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END")
    const deletionBody = { status: 'completed',version: 2,note: '已清除本次医疗内容，保留预约和申请审计',confirmed: true }
    await request('PATCH',deletionRoute,admin.token,deletionBody,500)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM record_photos').get().n,1)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM visit_summaries').get().n,2)
    assert.equal(db.prepare('SELECT record_deleted_at FROM appointments WHERE id=?').get('record-visit').record_deleted_at,'')
    db.exec('DROP TRIGGER fail_request_audit')
    await request('PATCH',deletionRoute,doctor.token,deletionBody,403)
    await request('PATCH',deletionRoute,admin.token,{ ...deletionBody,confirmed: false },400)
    await request('PATCH',deletionRoute,admin.token,deletionBody)
    for (const table of ['visit_summaries','record_photos','care_photos','care_tasks','care_feedback','care_resolutions','care_events','care_plans','care_plan_nodes','care_plan_events','recall_plans','recall_events','recall_followups','tasks']) assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n,0,table)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notification_messages WHERE appointment_id='record-visit'").get().n,0)
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM notification_attempts WHERE message_id='message-delete'").get().n,0)
    assert.equal(db.prepare('SELECT status FROM record_requests WHERE id=?').get(pending.id).status,'rejected')
    assert.equal(db.prepare('SELECT note FROM appointments WHERE id=?').get('record-visit').note,'')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM appointments').get().n,3)
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
    assert.equal((await request('GET',memberRoute,patient.token)).record.stats.visits,1)
    assert.equal((await request('GET','/v1/records',patient.token)).records.total,2)
    await request('GET','/v1/appointments/record-visit/history',patient.token,undefined,410)
    await request('GET','/v1/appointments/record-visit/record-photos',patient.token,undefined,410)
    await download(photoRoute,patient.token,404)
    await download('/v1/care-photos/recovery-photo',other.token,404)
    await request('PUT',summaryRoute,admin.token,{ ...summaryBody,version: 0 },410)
    assert.equal((await upload(doctor.token,'resurrect')).status,410)
    await request('POST','/v1/care-tasks',admin.token,{ appointmentId: 'record-visit',title: '新护理',instructions: '说明',dueDate: new Date(Date.now()+8*3600000).toISOString().slice(0,10),requestKey: 'resurrect-care' },410)
    assert.ok(!(await request('GET','/v1/worklist',admin.token)).worklist.items.some(row => row.appointmentId === 'record-visit'))
    const longSummary = { version: 0,findings: '检'.repeat(2000),treatment: '治'.repeat(2000),nextSteps: '后'.repeat(1500),structured: { diagnosis: '诊'.repeat(1000),teeth: ['55'],procedure: '项'.repeat(1000),materials: '材'.repeat(500) } }
    await request('PUT','/v1/appointments/same-name-visit/summary',admin.token,longSummary)
    const legacyClient = { version: 1,findings: '旧客户端修改检查结果',treatment: longSummary.treatment,nextSteps: longSummary.nextSteps }
    assert.equal((await request('PUT','/v1/appointments/same-name-visit/summary',admin.token,legacyClient)).summary.structured.diagnosis,longSummary.structured.diagnosis)
    db.close(); db = new DatabaseSync(database)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM record_photos').get().n,0)
    assert.ok(db.prepare('SELECT record_deleted_at FROM appointments WHERE id=?').get('record-visit').record_deleted_at)
    console.log('PASS: patient identity isolation, structured revisions, cross-visit timeline, archive uploads, authorization/revocation, transactional correction/deletion, no resurrection and persistence')
  } finally {
    if (db) db.close()
    const exited = once(child, 'exit'); child.kill(); await exited
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('apex-record-requests-'))
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
