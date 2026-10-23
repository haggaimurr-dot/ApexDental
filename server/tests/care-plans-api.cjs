const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { spawn } = require('node:child_process')
const { once } = require('node:events')
const { DatabaseSync } = require('node:sqlite')
async function main() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'apex-care-plans-')), database = path.join(directory, 'check.sqlite')
  const port = 21000 + Math.floor(Math.random() * 20000)
  const child = spawn(process.execPath, [path.join(__dirname, '..', 'index.js')], { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, APEX_DEMO_AUTH: '1', APEX_PORT: String(port), APEX_DATA_DIR: directory, APEX_DB_PATH: database,
      APEX_WECHAT_APPID: '', APEX_WECHAT_SECRET: '', APEX_WECHAT_TEMPLATES: '{}' } })
  let output = '', db
  child.stderr.on('data', chunk => { output += chunk }); child.stdout.resume()
  async function call(method, route, token, body, expected = 200) {
    const response = await fetch(`http://127.0.0.1:${port}${route}`, { method, signal: AbortSignal.timeout(4000),
      headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
    const result = await response.json(); assert.equal(response.status, expected, JSON.stringify(result)); return result
  }
  try {
    let ready = false
    for (let i = 0; i < 40; i++) { try { await call('GET', '/health'); ready = true; break } catch { await new Promise(resolve => setTimeout(resolve, 100)) } }
    assert.ok(ready, output)
    const login = name => call('POST', '/v1/auth/demo', '', { deviceId: 'care-plans-device-' + name })
    const patient = await login('patient'), family = await login('family'), stranger = await login('stranger'), admin = await login('admin')
    await call('POST', '/v1/staff/claim', admin.token, { code: fs.readFileSync(path.join(directory, 'bootstrap-code.txt'), 'utf8').trim(), displayName: '护理管理员' })
    const doctor = await login('doctor'), otherDoctor = await login('other-doctor'), desk = await login('desk')
    for (const [account, role, doctorName] of [[doctor, 'doctor', '李医生'], [otherDoctor, 'doctor', '周医生'], [desk, 'frontdesk']]) {
      const invite = await call('POST', '/v1/staff/invites', admin.token, { role, ...(doctorName ? { doctorName } : {}) }, 201)
      await call('POST', '/v1/staff/claim', account.token, { code: invite.code, displayName: '测试员工' })
    }
    db = new DatabaseSync(database)
    const stamp = new Date().toISOString(), dueDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    for (const [id, name, status] of [['visit', '李医生', '已完成'], ['other-visit', '周医生', '已完成'], ['unfinished', '李医生', '已到店']]) {
      db.prepare('INSERT INTO appointments (id,request_key,patient,phone,service,doctor,date,slot,status,source,note,created_at,updated_at,owner_id) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)')
        .run(id, id, '测试患者', '13800000000', '洁牙护理', name, dueDate, '10:00', status, '测试', '', stamp, stamp, patient.profile.id)
    }
    db.prepare('INSERT INTO family_members VALUES (?,?,?,?,?,?,?,?,?)').run('member', patient.profile.id, '测试患者', '本人', '13800000000', 1, 1, 'member', stamp)
    db.prepare('UPDATE appointments SET member_id=? WHERE id=?').run('member', 'visit')
    db.prepare('INSERT INTO member_shares VALUES (?,?,?,?,?,?,?,?)').run('share', 'member', patient.profile.id, family.profile.id, '家人', 1, 'hash', stamp)
    const node = { title: '人工护理说明', instructions: '医生填写的护理内容', dueDate }
    const body = { appointmentId: 'visit', title: '多节点计划', nodes: [node, { ...node, title: '第二节点' }], requestKey: 'create-plan' }
    await call('GET', '/v1/care-plans', '', undefined, 401)
    for (const token of [patient.token, family.token, desk.token, otherDoctor.token]) await call('POST', '/v1/care-plans', token, body, 403)
    await call('GET', '/v1/care-plans?scope=clinic', desk.token, undefined, 403)
    for (const invalid of [null, {}, { ...body, title: ' ' }, { ...body, nodes: [] }, { ...body, nodes: Array(21).fill(node) },
      { ...body, nodes: [{ ...node, dueDate: '2026-02-30' }] }, { ...body, nodes: [null] }]) await call('POST', '/v1/care-plans', admin.token, invalid, 400)
    await call('POST', '/v1/care-plans', admin.token, { ...body, appointmentId: 'unfinished' }, 409)
    const plan = (await call('POST', '/v1/care-plans', doctor.token, body, 201)).plan
    assert.equal((await call('POST', '/v1/care-plans', doctor.token, body, 201)).plan.id, plan.id)
    await call('POST', '/v1/care-plans', doctor.token, { ...body, title: '不同内容' }, 409)
    assert.equal((await call('GET', '/v1/care-plans', patient.token)).plans.length, 0)
    await call('GET', '/v1/care-plans/' + plan.id, family.token, undefined, 403)
    await call('GET', `/v1/care-plans/${plan.id}?scope=clinic`, otherDoctor.token, undefined, 403)
    const edited = (await call('PUT', '/v1/care-plans/' + plan.id, doctor.token, { ...body, version: plan.version }, 200)).plan
    await call('PUT', '/v1/care-plans/' + plan.id, doctor.token, { ...body, version: plan.version }, 409)
    const count = () => db.prepare('SELECT COUNT(*) AS n FROM care_tasks').get().n
    const initialCount = count()
    db.exec(`CREATE TRIGGER fail_second_node BEFORE INSERT ON care_plan_nodes WHEN NEW.position=1 BEGIN SELECT RAISE(ABORT,'test rollback'); END;`)
    await call('POST', `/v1/care-plans/${plan.id}/publish`, doctor.token, { version: edited.version }, 500)
    assert.equal(count(), initialCount)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM care_plan_nodes').get().n, 0)
    assert.equal(db.prepare('SELECT status FROM care_plans WHERE id=?').get(plan.id).status, 'draft')
    db.exec('DROP TRIGGER fail_second_node')
    const sent = (await call('POST', `/v1/care-plans/${plan.id}/publish`, doctor.token, { version: edited.version })).plan
    assert.equal(sent.status, 'active'); assert.equal(count(), initialCount + 2)
    await call('POST', `/v1/care-plans/${plan.id}/publish`, doctor.token, { version: edited.version })
    assert.equal(count(), initialCount + 2)
    await call('PUT', '/v1/care-plans/' + plan.id, doctor.token, { ...body, version: sent.version }, 409)
    assert.equal((await call('GET', '/v1/care-plans', patient.token)).plans.length, 1)
    assert.equal((await call('GET', '/v1/care-plans', family.token)).plans[0].id, plan.id)
    const history = (await call('GET', '/v1/appointments/visit/history', patient.token)).history
    assert.equal(history.entries.filter(entry => entry.title === '护理任务已发送').length, 2)
    const worklist = (await call('GET', '/v1/worklist', doctor.token)).worklist
    assert.equal(worklist.items.filter(item => item.group === 'care' && item.state === 'published').length, 2)
    assert.equal((await call('GET', '/v1/care-plans', stranger.token)).plans.length, 0)
    await call('GET', '/v1/care-plans/' + plan.id, stranger.token, undefined, 403)
    const first = sent.nodes[0], feedback = { pain: '轻微不适', bleeding: false, swelling: false, note: '' }
    await call('POST', `/v1/care-tasks/${first.id}/feedback`, family.token, feedback, 403)
    await call('POST', `/v1/care-tasks/${first.id}/feedback`, patient.token, feedback)
    assert.equal((await call('GET', '/v1/care-plans/' + plan.id, patient.token)).plan.attention, 1)
    await call('POST', `/v1/care-tasks/${first.id}/resolve`, doctor.token, { note: '已联系患者' })
    assert.equal((await call('GET', '/v1/care-plans/' + plan.id, patient.token)).plan.done, 1)
    db.prepare('UPDATE care_tasks SET due_date=? WHERE id=?').run('2020-01-01', sent.nodes[1].id)
    assert.equal((await call('GET', '/v1/care-plans/' + plan.id, patient.token)).plan.overdue, 1)
    await call('POST', `/v1/care-tasks/${sent.nodes[1].id}/feedback`, patient.token, { ...feedback, pain: '无疼痛' })
    await call('POST', `/v1/care-tasks/${sent.nodes[1].id}/resolve`, doctor.token, { note: '完成跟进' })
    assert.equal((await call('GET', '/v1/care-plans/' + plan.id, patient.token)).plan.status, 'completed')
    const standalone = (await call('POST', '/v1/care-tasks', doctor.token, { ...node, appointmentId: 'visit', requestKey: 'standalone' }, 201)).task
    const groupedBody = { ...body, nodes: [{ taskId: standalone.id }, node], requestKey: 'group-existing' }
    const grouped = (await call('POST', '/v1/care-plans', doctor.token, groupedBody, 201)).plan
    await call('POST', '/v1/care-plans', doctor.token, { ...body, nodes: [{ taskId: first.id }], requestKey: 'already-grouped' }, 409)
    await call('POST', '/v1/care-plans', doctor.token, { ...body, nodes: [{ taskId: standalone.id }, { taskId: standalone.id }], requestKey: 'duplicate' }, 400)
    await call('POST', '/v1/care-plans', admin.token, { ...groupedBody, appointmentId: 'other-visit', requestKey: 'wrong-visit' }, 400)
    // A competing draft can refer to a task; only one publication can claim it.
    const competing = (await call('POST', '/v1/care-plans', doctor.token, { ...groupedBody, requestKey: 'competing' }, 201)).plan
    const beforeGroup = count()
    const groupSent = (await call('POST', `/v1/care-plans/${grouped.id}/publish`, doctor.token, { version: grouped.version })).plan
    assert.equal(groupSent.nodes[0].id, standalone.id); assert.equal(count(), beforeGroup + 1)
    assert.equal((await call('POST', '/v1/care-plans', doctor.token, groupedBody, 201)).plan.id, grouped.id)
    await call('POST', `/v1/care-plans/${competing.id}/publish`, doctor.token, { version: competing.version }, 409)
    assert.equal(count(), beforeGroup + 1)
    const expiredDraft = (await call('POST', '/v1/care-plans', doctor.token, { ...body, requestKey: 'expired-draft' }, 201)).plan
    db.prepare('UPDATE care_plans SET nodes_json=? WHERE id=?').run(JSON.stringify([{ ...node, dueDate: '2020-01-01' }]), expiredDraft.id)
    await call('POST', `/v1/care-plans/${expiredDraft.id}/publish`, doctor.token, { version: expiredDraft.version }, 400)
    assert.equal(count(), beforeGroup + 1)
    db.prepare('UPDATE member_shares SET enabled=0 WHERE id=?').run('share')
    await call('GET', '/v1/care-plans/' + plan.id, family.token, undefined, 403)
    db.close(); db = new DatabaseSync(database)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM care_plan_events WHERE plan_id=?').get(plan.id).n, 3)
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM care_plan_nodes WHERE plan_id=?').get(plan.id).n, 2)
    // Workflow policies remain opt-in and normal feedback resolves atomically.
    const autoBody = { ...body, requestKey: 'auto-workflow', nodes: [
      { ...node, phase: '恢复观察', autoNormal: true, lossAfterDays: 7, followupIntervalDays: 3 },
      { ...node, title: '后续阶段', phase: '阶段照片', autoNormal: true }
    ] }
    for (const invalid of [{ autoNormal: 'yes' }, { lossAfterDays: 0 }, { followupIntervalDays: 31 }, { phase: 'x'.repeat(81) }]) {
      await call('POST', '/v1/care-plans', doctor.token, { ...autoBody, nodes: [{ ...node, ...invalid }] }, 400)
    }
    const autoDraft = (await call('POST', '/v1/care-plans', doctor.token, autoBody, 201)).plan
    const autoPlan = (await call('POST', `/v1/care-plans/${autoDraft.id}/publish`, doctor.token, { version: autoDraft.version })).plan
    const autoTask = autoPlan.nodes[0], abnormal = autoPlan.nodes[1], normal = { pain: '无疼痛', bleeding: false, swelling: false, note: '' }
    assert.equal(autoTask.autoNormal, true); assert.equal(autoTask.phase, '恢复观察')
    const feedbackRoute = `/v1/care-tasks/${autoTask.id}/feedback`
    db.exec("CREATE TRIGGER fail_auto BEFORE INSERT ON care_resolutions WHEN NEW.staff_id='system' BEGIN SELECT RAISE(ABORT,'auto rollback'); END")
    await call('POST', feedbackRoute, patient.token, normal, 500)
    assert.equal(db.prepare('SELECT status FROM care_tasks WHERE id=?').get(autoTask.id).status, 'published')
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM care_feedback WHERE task_id=?').get(autoTask.id).n, 0)
    db.exec('DROP TRIGGER fail_auto')
    const autoDone = (await call('POST', feedbackRoute, patient.token, normal)).task
    assert.equal(autoDone.status, 'resolved'); assert.ok(autoDone.resolution)
    await call('POST', feedbackRoute, patient.token, normal, 409)
    assert.equal((await call('GET', `/v1/care-plans/${autoPlan.id}`, patient.token)).plan.completionRate, '50.0%')
    db.prepare('INSERT INTO care_photos VALUES (?,?,?,?,?,?,?,?,?)').run('stage-photo', abnormal.id, patient.profile.id, 'image/png', Buffer.from([1]), 'test-photo', 'stage-photo-request', 0, stamp)
    const review = (await call('POST', `/v1/care-tasks/${abnormal.id}/feedback`, patient.token, { ...normal, photos: ['stage-photo'] })).task
    assert.equal(review.status, 'waiting_review'); assert.equal(review.feedback.attention, 1)
    const photoPlan = (await call('GET', `/v1/care-plans/${autoPlan.id}`, patient.token)).plan
    assert.equal(photoPlan.stagePhotos.length, 1); assert.equal(photoPlan.stagePhotos[0].phase, '阶段照片'); assert.equal(photoPlan.stagePhotos[0].taskId, abnormal.id)
    assert.equal((await fetch(`http://127.0.0.1:${port}/v1/care-photos/stage-photo`, { headers: { authorization: 'Bearer ' + stranger.token } })).status, 403)
    const workflowHistory = (await call('GET', '/v1/appointments/visit/history', patient.token)).history
    assert.ok(workflowHistory.entries.some(row => row.title === '正常反馈自动随访'))
    const contactTask = (await call('POST', '/v1/care-tasks', doctor.token, { ...node, appointmentId: 'visit', requestKey: 'contact-task' }, 201)).task
    const overdueDate = new Date(Date.parse(dueDate) - 8 * 86400000).toISOString().slice(0, 10)
    db.prepare('UPDATE care_tasks SET due_date=? WHERE id=?').run(overdueDate, contactTask.id)
    const contactRoute = `/v1/care-tasks/${contactTask.id}/followup`, contact = { outcome: 'unreachable', note: '内部测试记录', requestKey: 'contact-1' }
    for (const token of [patient.token, family.token, desk.token, otherDoctor.token]) await call('POST', contactRoute, token, contact, 403)
    for (const invalid of [null, { ...contact, outcome: 'unknown' }, { ...contact, note: '' }]) await call('POST', contactRoute, doctor.token, invalid, 400)
    const contacted = (await call('POST', contactRoute, doctor.token, contact)).task
    assert.equal(contacted.followupState, 'lost'); assert.ok(contacted.nextContactDate > dueDate)
    await call('POST', contactRoute, doctor.token, contact)
    await call('POST', contactRoute, doctor.token, { ...contact, note: '不同内容' }, 409)
    await call('POST', contactRoute, doctor.token, { ...contact, requestKey: 'contact-2' }, 409)
    const contacts = db.prepare("SELECT * FROM care_events WHERE task_id=? AND action LIKE 'followup:%'").all(contactTask.id)
    assert.equal(contacts.length, 1)
    const deferredWork = (await call('GET', '/v1/worklist', doctor.token)).worklist.items.find(row => row.taskId === contactTask.id)
    assert.equal(deferredWork.deferred, true); assert.equal(deferredWork.actionable, false)
    assert.equal(deferredWork.followupState, 'lost')
    const patientContactTask = (await call('GET', '/v1/care-tasks', patient.token)).tasks.find(row => row.id === contactTask.id)
    assert.equal(patientContactTask.followups, undefined)
    assert.ok(!JSON.stringify((await call('GET', '/v1/appointments/visit/history', patient.token)).history).includes('内部测试记录'))
    assert.ok(JSON.stringify((await call('GET', '/v1/appointments/visit/history?scope=clinic', doctor.token)).history).includes('内部测试记录'))
    await call('POST', `/v1/care-tasks/${contactTask.id}/feedback`, patient.token, normal)
    assert.equal((await call('GET', '/v1/care-tasks', patient.token)).tasks.find(row => row.id === contactTask.id).followupState, 'responded')
    await call('POST', contactRoute, doctor.token, { ...contact, requestKey: 'contact-3' }, 409)
    // Three consecutive failed contacts are independently sufficient, before seven overdue days.
    const early = (await call('POST', '/v1/care-tasks', doctor.token, { ...node, appointmentId: 'visit', requestKey: 'early-contact' }, 201)).task
    db.prepare('UPDATE care_tasks SET due_date=? WHERE id=?').run(new Date(Date.parse(dueDate) - 86400000).toISOString().slice(0, 10), early.id)
    for (let i = 0; i < 3; i++) db.prepare('INSERT INTO care_events (task_id,actor,action,created_at) VALUES (?,?,?,?)').run(early.id, doctor.profile.id, 'followup:' + JSON.stringify({ outcome: 'unreachable', note: '无人接听', nextContactDate: dueDate, requestKey: 'early-' + i }), stamp)
    assert.equal((await call('GET', '/v1/care-tasks', patient.token)).tasks.find(row => row.id === early.id).followupState, 'lost')
    const stats = (await call('GET', `/v1/statistics?from=${overdueDate}&to=${dueDate}`, doctor.token)).statistics
    assert.ok(stats.care.completed >= 1); assert.ok(stats.care.autoResolved >= 1); assert.ok(stats.care.lost >= 1)
    assert.equal(stats.care.completionRate, (stats.care.completed / stats.care.due * 100).toFixed(1) + '%')
    assert.ok(stats.care.byService.some(row => row.service === '洁牙护理'))
    assert.equal((await call('GET', `/v1/statistics?from=${dueDate}&to=${dueDate}`, desk.token)).statistics.care, null)
    // Recall state and countdown use the planned or booked day and clear on rebooking.
    await call('PUT', '/v1/appointments/visit/summary', doctor.token, { version: 0, findings: '测试检查', treatment: '测试处理', nextSteps: '测试复查' })
    const recall = (await call('PUT', '/v1/appointments/visit/recall', doctor.token, { dueDate, instructions: '测试复查', version: 0 })).recall
    assert.equal(recall.countdownDays, 0)
    db.prepare('UPDATE recall_plans SET due_date=? WHERE appointment_id=?').run(overdueDate, 'visit')
    assert.equal((await call('GET', '/v1/recalls', patient.token)).recalls[0].followupState, 'lost')
    const nextContactDate = new Date(Date.parse(dueDate) + 3 * 86400000).toISOString().slice(0, 10)
    const recallBody = { version: recall.version, note: '电话无人接听', nextContactDate, requestKey: 'recall-contact', outcome: 'unreachable' }
    await call('POST', '/v1/appointments/visit/recall-followup', doctor.token, recallBody)
    await call('POST', '/v1/appointments/visit/recall-followup', doctor.token, recallBody)
    await call('POST', '/v1/appointments/visit/recall-followup', doctor.token, { ...recallBody, outcome: 'reached' }, 409)
    assert.equal(db.prepare('SELECT outcome FROM recall_followups WHERE request_key=?').get('recall-contact').outcome, 'unreachable')
    db.prepare('UPDATE appointments SET recall_id=? WHERE id=?').run('visit', 'other-visit')
    const bookedRecall = (await call('GET', '/v1/recalls', patient.token)).recalls[0]
    assert.equal(bookedRecall.followupState, 'responded'); assert.equal(bookedRecall.status, 'completed')
    console.log('PASS: care plans permissions, atomic publish/automatic normal feedback, abnormal/photo review, loss/contact rules, privacy, recall countdown/recovery, complete statistics and persistence')
  } finally {
    if (db) db.close()
    const exited = once(child, 'exit'); child.kill(); await exited
    assert.equal(path.dirname(path.resolve(directory)), path.resolve(os.tmpdir()))
    assert.ok(path.basename(directory).startsWith('apex-care-plans-'))
    fs.rmSync(directory, { recursive: true, force: true })
  }
}
main().catch(error => { console.error(error); process.exitCode = 1 })
