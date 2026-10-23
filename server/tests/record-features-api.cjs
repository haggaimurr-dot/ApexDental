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


    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jP1sAAAAASUVORK5CYII=','base64')
    const pdf=Buffer.from('%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n%%EOF')
    const dicom=Buffer.alloc(140); dicom.write('DICM',128)
    async function upload(route,token,values,bytes=pdf,expected=201){
      const response=await fetch('http://127.0.0.1:'+port+route+'?'+new URLSearchParams(values),{method:'POST',headers:{authorization:'Bearer '+token},body:bytes})
      const result=await response.json();assert.equal(response.status,expected,JSON.stringify(result));return result
    }
    async function download(route,token,expected=200){
      const response=await fetch('http://127.0.0.1:'+port+route,{headers:{authorization:'Bearer '+token}})
      assert.equal(response.status,expected);return Buffer.from(await response.arrayBuffer())
    }
    const insertVisit=db.prepare('INSERT INTO appointments (id,request_key,patient,phone,service,doctor,date,slot,status,source,created_at,updated_at,owner_id,member_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
    insertVisit.run('angle-visit','angle-visit-key','测试患者','13800000000','口腔检查','李医生','2026-09-01','09:00','已完成','测试',stamp,stamp,patient.profile.id,'shared-member')
    const photoValues={category:'治疗后',caption:'同角度',angle:'局部',tooth:'36',capturedOn:'2026-09-01',requestKey:'angle-left'}
    const left=(await upload('/v1/appointments/angle-visit/record-photos',doctor.token,photoValues,png)).photo
    const right=(await upload('/v1/appointments/record-visit/record-photos',doctor.token,{...photoValues,capturedOn:'2026-10-01',requestKey:'angle-right'},png)).photo
    const wrong=(await upload('/v1/appointments/record-visit/record-photos',doctor.token,{...photoValues,tooth:'11',requestKey:'angle-wrong'},png)).photo
    await upload('/v1/appointments/record-visit/record-photos',doctor.token,{...photoValues,tooth:'',requestKey:'no-tooth'},png,400)
    assert.equal((await request('GET','/v1/members/shared-member/photo-comparison?left='+left.id+'&right='+right.id,other.token)).comparison.left.tooth,'36')
    await request('GET','/v1/members/shared-member/photo-comparison?left='+left.id+'&right='+wrong.id,patient.token,undefined,400)
    await request('GET','/v1/members/shared-member/photo-comparison?left='+left.id+'&right='+left.id,patient.token,undefined,400)
    const fileValues={kind:'检查单',name:'检查单.pdf',tooth:'36',requestKey:'attachment-key'}
    await upload('/v1/appointments/record-visit/attachments',other.token,fileValues,pdf,403)
    await upload('/v1/appointments/record-visit/attachments',desk.token,fileValues,pdf,403)
    await upload('/v1/appointments/record-visit/attachments',doctor.token,{...fileValues,requestKey:'invalid-file'},Buffer.from('unsafe html'),400)
    await upload('/v1/appointments/record-visit/attachments',doctor.token,{...fileValues,requestKey:'large-file'},Buffer.alloc(10*1024*1024+1),413)
    const attachment=(await upload('/v1/appointments/record-visit/attachments',doctor.token,fileValues)).attachment
    assert.equal((await upload('/v1/appointments/record-visit/attachments',doctor.token,fileValues)).attachment.id,attachment.id)
    await upload('/v1/appointments/record-visit/attachments',doctor.token,{...fileValues,name:'changed.pdf'},pdf,409)
    const scan=(await upload('/v1/appointments/record-visit/attachments',doctor.token,{kind:'影像',name:'scan.dcm',tooth:'36',requestKey:'scan-key'},dicom)).attachment
    assert.equal(scan.mime,'application/dicom')
    assert.deepEqual(await download('/v1/record-attachments/'+attachment.id,other.token),pdf)
    const outsider=await login('archive-outsider-user')
    await download('/v1/record-attachments/'+attachment.id,outsider.token,403)
    const answers={allergies:'青霉素',medications:'无',conditions:'无',previousReactions:'无',chiefComplaint:'牙齿敏感',bleedingHistory:false,pregnant:null,tobacco:'none'}
    const questionnaireRoute='/v1/members/shared-member/questionnaire'
    await request('PUT',questionnaireRoute,other.token,{version:0,answers,consent:true},403)
    await request('PUT',questionnaireRoute,patient.token,{version:0,answers,consent:false},400)
    assert.equal((await request('PUT',questionnaireRoute,patient.token,{version:0,answers,consent:true})).questionnaire.version,1)
    assert.equal((await request('PUT',questionnaireRoute,patient.token,{version:0,answers,consent:true})).questionnaire.version,1)
    await request('PUT',questionnaireRoute,patient.token,{version:0,answers:{...answers,medications:'新药'},consent:true},409)
    await request('PUT',questionnaireRoute,patient.token,{version:1,answers:{...answers,medications:'新药'},consent:true})
    assert.equal((await request('GET',questionnaireRoute+'?scope=clinic',doctor.token)).versions.length,2)
    await request('GET',questionnaireRoute+'?scope=clinic',desk.token,undefined,403)
    const childMember=(await request('POST','/v1/members',patient.token,{name:'测试儿童',relationship:'子女',phone:'13800000000',enabled:true,requestKey:'guardian-child-key'},201)).member
    insertVisit.run('child-visit','child-visit-key','测试儿童','13800000000','口腔检查','李医生','2026-09-01','11:00','已完成','测试',stamp,stamp,patient.profile.id,childMember.id)
    const guardianRoute='/v1/members/'+childMember.id+'/guardian'
    const guardianValues={name:'测试母亲',relationship:'母亲',phone:'13800000000',birthDate:'2018-01-01',requestKey:'guardian-key'}
    await request('POST','/v1/members/'+childMember.id+'/shares',patient.token,{},409)
    await request('PUT','/v1/members/'+childMember.id+'/questionnaire',patient.token,{version:0,answers,consent:true},409)
    await request('POST','/v1/privacy-requests',patient.token,{kind:'export',memberId:childMember.id,details:'导出儿童资料',requestKey:'unverified-rights'},409)
    await upload(guardianRoute,other.token,guardianValues,pdf,403)
    const check=(await upload(guardianRoute,patient.token,guardianValues)).check
    assert.equal((await upload(guardianRoute,patient.token,guardianValues)).check.id,check.id)
    assert.equal((await request('GET',guardianRoute,patient.token)).verified,false)
    await download('/v1/guardian-checks/'+check.id+'/evidence',other.token,403)
    await download('/v1/guardian-checks/'+check.id+'/evidence',doctor.token,403)
    assert.deepEqual(await download('/v1/guardian-checks/'+check.id+'/evidence',admin.token),pdf)
    await request('GET','/v1/guardian-checks',desk.token,undefined,403)
    const approve={status:'approved',version:1,note:'已核对双方身份及亲属监护关系材料',identityChecked:true,relationshipChecked:true}
    await request('PATCH','/v1/guardian-checks/'+check.id,admin.token,{...approve,relationshipChecked:false},400)
    db.exec("CREATE TRIGGER fail_guardian_audit BEFORE INSERT ON guardian_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
    await request('PATCH','/v1/guardian-checks/'+check.id,admin.token,approve,500)
    assert.equal(db.prepare('SELECT status FROM guardian_checks WHERE id=?').get(check.id).status,'submitted')
    db.exec('DROP TRIGGER fail_guardian_audit')
    await request('PATCH','/v1/guardian-checks/'+check.id,admin.token,approve)
    assert.equal((await request('GET',guardianRoute,patient.token)).verified,true)
    await request('PUT','/v1/members/'+childMember.id+'/questionnaire',patient.token,{version:0,answers,consent:true})
    const invite=(await request('POST','/v1/members/'+childMember.id+'/shares',patient.token,{},201)).invite
    await request('POST','/v1/member-shares/accept',other.token,{code:invite.code,displayName:'只读家人'})
    assert.equal((await request('GET','/v1/members/'+childMember.id+'/record',other.token)).record.member.mayManage,false)
    // Access/export queues are owner-only; completion creates a real portable ZIP.
    const rightsBody={kind:'export',memberId:'shared-member',details:'导出该成员全部可见资料',requestKey:'export-key'}
    await request('POST','/v1/privacy-requests',other.token,rightsBody,403)
    const rights=(await request('POST','/v1/privacy-requests',patient.token,rightsBody,201)).request
    assert.equal((await request('POST','/v1/privacy-requests',patient.token,rightsBody,201)).request.id,rights.id)
    await request('GET','/v1/privacy-requests?scope=clinic',doctor.token,undefined,403)
    const rightsRoute='/v1/privacy-requests/'+rights.id
    await request('PATCH',rightsRoute,admin.token,{status:'processing',version:1,note:'已核验请求身份及范围'})
    const fulfil={status:'completed',version:2,note:'已生成成员资料包',confirmed:true}
    db.exec("CREATE TRIGGER fail_privacy_audit BEFORE INSERT ON privacy_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
    await request('PATCH',rightsRoute,admin.token,fulfil,500)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM privacy_exports').get().n,0)
    db.exec('DROP TRIGGER fail_privacy_audit')
    assert.equal((await request('PATCH',rightsRoute,admin.token,fulfil)).request.downloadable,true)
    await download(rightsRoute+'/download',other.token,403)
    await download(rightsRoute+'/download',admin.token,403)
    const bytes=await download(rightsRoute+'/download',patient.token)
    assert.equal(bytes.readUInt32LE(0),0x04034b50)
    let offset=0;const zipFiles=new Map()
    while(bytes.readUInt32LE(offset)===0x04034b50){const size=bytes.readUInt32LE(offset+18),length=bytes.readUInt16LE(offset+26),extra=bytes.readUInt16LE(offset+28),name=bytes.subarray(offset+30,offset+30+length).toString(),start=offset+30+length+extra;zipFiles.set(name,bytes.subarray(start,start+size));offset=start+size}
    assert.deepEqual(zipFiles.get('attachments/'+attachment.id+'.pdf'),pdf)
    const manifest=JSON.parse(zipFiles.get('records.json'))
    assert.equal(manifest.questionnaires.length,2);assert.equal(manifest.record.stats.visits,2)
    assert.ok(!JSON.stringify(manifest).includes('测试儿童'))
    const logs=await request('GET','/v1/record-access-logs?member=shared-member&action=download',patient.token)
    assert.ok(logs.items.some(row=>row.resourceId===attachment.id && row.outcome===200))
    assert.ok(logs.items.some(row=>row.resourceId===attachment.id && row.outcome===403))
    await request('GET','/v1/record-access-logs?member=shared-member',other.token,undefined,403)
    await request('GET','/v1/record-access-logs?scope=clinic',doctor.token,undefined,403)
    const withdrawn=(await request('POST','/v1/privacy-requests',patient.token,{...rightsBody,kind:'access',requestKey:'access-withdraw'},201)).request
    await request('PATCH','/v1/privacy-requests/'+withdrawn.id,patient.token,{status:'withdrawn',version:1,note:'暂不办理'})
    // Deleting a visit removes its attachments and invalidates older member exports.
    const deletion=(await request('POST','/v1/record-requests',patient.token,{appointmentId:'record-visit',kind:'deletion',details:'删除本次医疗内容',requestKey:'attachment-deletion'},201)).request
    await request('PATCH','/v1/record-requests/'+deletion.id,admin.token,{status:'processing',version:1,note:'已核验'})
    await request('PATCH','/v1/record-requests/'+deletion.id,admin.token,{status:'completed',version:2,note:'已清除含附件的医疗内容',confirmed:true})
    await download('/v1/record-attachments/'+attachment.id,patient.token,404)
    await download(rightsRoute+'/download',patient.token,410)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM record_attachments').get().n,0)
    // Guardian revocation also removes old shared access, including SQL list endpoints.
    await request('PATCH','/v1/guardian-checks/'+check.id,admin.token,{status:'revoked',version:2,note:'关系材料需重新核验'})
    await request('GET','/v1/members/'+childMember.id+'/record',other.token,undefined,403)
    assert.ok(!(await request('GET','/v1/records',other.token)).records.items.some(row=>row.memberId===childMember.id))
    await request('POST','/v1/privacy-requests',patient.token,{kind:'closure',details:'注销我的账号',requestKey:'closure-unverified',confirmed:true},409)
    const replacement=(await upload(guardianRoute,patient.token,{...guardianValues,requestKey:'replacement-check'})).check
    await request('PATCH','/v1/guardian-checks/'+replacement.id,admin.token,approve)
    const young=(await request('POST','/v1/members',patient.token,{name:'其他未成年成员',relationship:'其他家人',phone:'13800000000',birthDate:'2015-01-01',enabled:true,requestKey:'young-profile'},201)).member
    assert.equal(young.guardianRequired,true)
    const changed=(await request('PUT','/v1/members/'+young.id,patient.token,{name:young.name,relationship:'其他家人',phone:'13800000000',birthDate:'1990-01-01',enabled:true,version:young.version})).member
    assert.equal(changed.guardianRequired,true)
    await request('POST','/v1/members/'+young.id+'/shares',patient.token,{},409)
    const adultCheck=(await upload('/v1/members/'+young.id+'/guardian',patient.token,{...guardianValues,birthDate:'1990-01-01',requestKey:'adult-proof'})).check
    await request('PATCH','/v1/guardian-checks/'+adultCheck.id,admin.token,{status:'adult_confirmed',version:1,note:'材料已核对成员成年身份',identityChecked:true})
    assert.equal((await request('GET','/v1/members/'+young.id+'/guardian',patient.token)).required,false)
    const closure=(await request('POST','/v1/privacy-requests',patient.token,{kind:'closure',details:'注销当前账号并清除在线医疗内容',requestKey:'closure-key',confirmed:true},201)).request
    await request('PATCH','/v1/privacy-requests/'+closure.id,admin.token,{status:'processing',version:1,note:'核对注销及预约状态'})
    db.exec("CREATE TRIGGER fail_privacy_audit BEFORE INSERT ON privacy_events BEGIN SELECT RAISE(ABORT,'audit unavailable'); END")
    await request('PATCH','/v1/privacy-requests/'+closure.id,admin.token,fulfil,500)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM account_closures').get().n,0)
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM health_questionnaires').get().n>0)
    await request('GET','/v1/me',patient.token)
    db.exec('DROP TRIGGER fail_privacy_audit')
    await request('PATCH','/v1/privacy-requests/'+closure.id,admin.token,fulfil)
    await request('GET','/v1/me',patient.token,undefined,401)
    await request('POST','/v1/auth/demo','',{deviceId:'record-request-patient'},403)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(patient.profile.id).n,0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM health_questionnaires').get().n,0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM record_photos').get().n,0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM guardian_checks WHERE bytes IS NOT NULL').get().n,0)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM member_shares WHERE enabled=1 AND owner_id=?').get(patient.profile.id).n,0)
    assert.equal(db.prepare('SELECT subject FROM users WHERE id=?').get(patient.profile.id).subject.startsWith('closed:'),true)
    assert.equal(db.prepare('PRAGMA foreign_key_check').all().length,0)
    assert.ok(db.prepare('SELECT COUNT(*) AS n FROM record_access_logs').get().n>0)
    await request('POST','/v1/privacy-requests',admin.token,{kind:'closure',details:'注销管理员',requestKey:'admin-closure',confirmed:true},409)
    console.log('PASS: same-angle comparison, private attachments, questionnaire versions, guardian evidence/review/revocation, portable exports, access logs, deletion invalidation and transactional account closure')
  } finally {
    if (db) db.close()
    const exited = once(child, 'exit'); child.kill(); await exited
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('apex-record-requests-'))
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
