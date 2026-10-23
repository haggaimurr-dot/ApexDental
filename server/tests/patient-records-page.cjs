const assert = require('node:assert/strict')
const api = require('../../miniprogram/lib/api')
const mixin = require('../../miniprogram/lib/patient-records-page')
let definition, removed = [], previews = []
global.Page = value => { definition = value }
global.wx = { getFileSystemManager: () => ({ unlink: options => removed.push(options.filePath) }), previewImage: options => previews.push(options) }
require('../../miniprogram/pages/index/index')
const tap = dataset => ({ currentTarget: { dataset } })
function page() {
  return { ...mixin,data: { ...structuredClone(definition.data),profile: { id: 'owner' },authReady: true },setData(values) { Object.assign(this.data,values) },showHistory() { this.data.page = 'history' } }
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve,promise } }
async function main() {
  const instance = page(), pending = deferred()
  api.patientRecord = () => pending.promise
  const loading = instance.openPatientRecord(tap({ id: 'member' }))
  instance.clearPatientRecord(); instance.data.profile = { id: 'other' }; instance.data.page = 'home'
  pending.resolve({ record: { entries: [],photos: [] } }); await loading
  assert.equal(instance.data.patientRecord,null)
  const record = { member: { id: 'member',name: '成员',mayManage: false },stats: { visits: 2 },entries: [{ id: 'event',at: '2026-10-02T01:00:00.000Z' }],photos: [{ id: 'photo',source: 'record',createdAt: '2026-10-02T01:00:00.000Z' }] }
  api.patientRecord = async () => ({ record })
  await instance.openPatientRecord(tap({ id: 'member' }))
  assert.equal(instance.data.patientRecord.entries[0].timeLabel,'2026-10-02 09:00')
  let shared = false
  instance.openMemberShares = () => { shared = true }
  instance.sharePatientRecord(); assert.equal(shared,false)
  instance.data.patientRecord.member.mayManage = true
  instance.sharePatientRecord(); assert.equal(shared,true)
  let downloads = 0
  api.downloadRecordPhoto = async () => { downloads++; return '/tmp/photo-' + downloads }
  await instance.previewRecordPhoto(tap({ id: 'photo' })); await instance.previewRecordPhoto(tap({ id: 'photo' }))
  assert.equal(downloads,2); assert.equal(previews.length,2) // Every preview rechecks server authorization.
  api.downloadRecordPhoto = async () => { throw new Error('无权查看此档案') }
  await instance.previewRecordPhoto(tap({ id: 'photo' })); assert.equal(previews.length,2)
  assert.equal(instance.data.patientRecordError,'无权查看此档案')
  instance.clearPatientRecord(); assert.deepEqual(removed,['/tmp/photo-1','/tmp/photo-2'])
  await instance.openPatientRecord(tap({ id: 'member' }))
  const stale = deferred(); api.downloadRecordPhoto = () => stale.promise
  const viewing = instance.previewRecordPhoto(tap({ id: 'photo' }))
  instance.clearPatientRecord(); instance.data.tab = 'clinic'
  stale.resolve('/tmp/stale-photo'); await viewing
  assert.equal(previews.length,2); assert.ok(removed.includes('/tmp/stale-photo'))
  instance.data.tab = 'patient'; instance.data.recordAlbumVisit = { id: 'visit',status: '已完成' }
  let uploads = 0
  api.uploadRecordPhoto = async () => { uploads++ }
  await instance.chooseRecordPhoto(); assert.equal(uploads,0)
  api.patientRecord = async () => { throw new Error('授权已撤销') }
  await instance.openPatientRecord(tap({ id: 'member' }))
  assert.equal(instance.data.patientRecord,null); assert.equal(instance.data.recordAlbum.length,0)
  console.log('PASS: archive page identity isolation, stale response cleanup, timezone, sharing gates and authorization on every photo preview')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
