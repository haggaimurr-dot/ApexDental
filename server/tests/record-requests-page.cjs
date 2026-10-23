const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const api = require('../../miniprogram/lib/api')
const mixin = require('../../miniprogram/lib/record-requests-page')
let definition, toasts = 0
global.Page = value => { definition = value }
global.wx = { showToast: () => { toasts++ } }
require('../../miniprogram/pages/index/index')
function page(tab = 'patient', role = 'patient') {
  const instance = { ...mixin, data: { ...structuredClone(definition.data), tab, profile: { id: 'owner', role }, authReady: true },
    setData(values) { Object.assign(this.data, values) }, showError(error) { this.error = error.message } }
  instance.clearRecordRequests(); return instance
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }
const tap = dataset => ({ currentTarget: { dataset } })
const item = { id: 'request', kind: 'correction', status: 'submitted', version: 1, events: [{ status: 'submitted', createdAt: '2026-10-02T01:00:00.000Z', note: '提交' }] }
async function main() {
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxml'), 'utf8')
  for (const match of wxml.matchAll(/bind(?:tap|input|change)="([A-Za-z_][A-Za-z0-9_]*)"/g)) assert.equal(typeof definition[match[1]], 'function', match[1])
  const instance = page(), old = deferred()
  api.recordRequests = () => old.promise
  const pending = instance.showRecordRequests()
  instance.clearRecordRequests(); instance.data.profile = { id: 'other', role: 'patient' }; instance.data.page = 'home'
  old.resolve({ items: [item], page: 1, hasMore: false }); await pending
  assert.equal(instance.data.requestItems.length, 0)
  api.recordRequests = async () => ({ items: [item], hasMore: false })
  await instance.showRecordRequests(); assert.equal(instance.data.requestItems[0].statusLabel, '待受理')
  assert.equal(instance.data.requestItems[0].events[0].timeLabel, '2026-10-02 09:00 北京时间')
  instance.data.selectedHistory = { appointment: { id: 'visit', patient: '患者', mayManage: false } }
  await instance.startRecordRequest(); assert.equal(instance.data.requestEditor, null)
  instance.data.selectedHistory.appointment.mayManage = true
  await instance.startRecordRequest(); assert.equal(instance.data.requestEditor.appointmentId, 'visit')
  const key = instance.data.requestEditor.requestKey
  instance.recordRequestInput({ ...tap({ field: 'details' }), detail: { value: '更正错字' } })
  assert.notEqual(instance.data.requestEditor.requestKey, key)
  const failure = new Error('网络错误'), sending = deferred(); let calls = 0, submitted
  api.submitRecordRequest = data => { calls++; submitted = structuredClone(data); return sending.promise }
  const submitting = instance.submitRecordRequest(); instance.submitRecordRequest(); assert.equal(calls, 1)
  instance.recordRequestInput({ ...tap({ field: 'details' }), detail: { value: '保存期间更改' } })
  assert.equal(instance.data.requestEditor.details, '更正错字')
  sending.resolve({ request: item }); await submitting
  assert.equal(instance.data.requestEditor, null); assert.equal(instance.data.requestBusy, false); assert.equal(toasts, 1)
  await instance.startRecordRequest()
  api.submitRecordRequest = async () => { throw failure }
  const retryKey = instance.data.requestEditor.requestKey
  await instance.submitRecordRequest(); assert.equal(instance.data.requestEditor.requestKey, retryKey)
  assert.equal(instance.data.requestError, '网络错误'); assert.equal(instance.data.requestBusy, false)
  const switched = deferred(); api.submitRecordRequest = () => switched.promise
  const stale = instance.submitRecordRequest(); instance.clearRecordRequests(); instance.data.page = 'home'
  switched.resolve({}); await stale; assert.equal(toasts, 1); assert.equal(instance.data.requestEditor, null)
  const clinic = page('clinic', 'admin')
  await clinic.showRecordRequests(); clinic.reviewRecordRequest(tap({ id: 'request' }))
  assert.equal(clinic.data.requestReview.id, 'request')
  let changed
  api.updateRecordRequest = async (id, body) => { changed = { id, body }; return { request: item } }
  clinic.data.requestNote = '核验中'; await clinic.updateRecordRequest(tap({ status: 'processing' }))
  assert.deepEqual(changed.body, { status: 'processing', version: 1, note: '核验中', confirmed: false })
  clinic.reviewRecordRequest(tap({ id: 'request' })); api.updateRecordRequest = async () => { throw new Error('申请已更新，请刷新') }
  await clinic.updateRecordRequest(tap({ status: 'processing' })); assert.equal(clinic.data.requestReview.version, 1)
  await clinic.loadRecordRequests(); assert.equal(clinic.data.requestReview, null)
  const desk = page('clinic', 'frontdesk'); await desk.showRecordRequests(); assert.equal(desk.data.page, 'home')
  assert.equal(submitted.details, '更正错字')
  console.log('PASS: WXML handlers, identity isolation, read-only sharing gate, duplicate clicks, retry keys, result rendering and conflict refresh')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
