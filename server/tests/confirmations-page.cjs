const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const api = require('../../miniprogram/lib/api')
let definition
 global.Page = value => { definition = value }
 global.wx = { showToast() {} }
require('../../miniprogram/pages/index/index')
const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxml'), 'utf8')
for (const match of wxml.matchAll(/(?:bind|catch)(?:tap|input|change|confirm)="([^"]+)"/g)) {
  const names = match[1].startsWith('{{') ? [...match[1].matchAll(/'([^']+)'/g)].map(item => item[1]) : [match[1]]
  for (const name of names) assert.equal(typeof definition[name], 'function', `Missing WXML event: ${name}`)
}
function page() {
  return { ...definition, data: { ...structuredClone(definition.data), authReady: true, tab: 'clinic', page: 'reschedule',
    profile: { id: 'desk', role: 'frontdesk' }, rescheduleEditor: { id: 'visit', status: '待确认', version: 7 } },
    setData(values) { Object.assign(this.data, values) }, refreshRemote() {}, reloadReschedule() { this.reloaded = true }, showError() {} }
}
async function main() {
  const p = page(); let calls = 0, resolve
  api.changeStatus = (id,status,version,note) => {
    calls++; assert.equal(id,'visit'); assert.equal(status,'已预约'); assert.equal(version,7); assert.equal(note,'电话已确认')
    return new Promise(done => { resolve = done })
  }
  p.data.confirmationNote = '  '; p.submitConfirmation(); assert.equal(calls,0); assert.ok(p.data.confirmationError)
  p.confirmationNoteInput({ detail: { value: ' 电话已确认 ' } })
  const pending = p.submitConfirmation(); p.submitConfirmation(); assert.equal(calls,1)
  p.confirmationNoteInput({ detail: { value: '正在保存时编辑' } }); assert.equal(p.data.confirmationNote,' 电话已确认 ')
  resolve({}); await pending; assert.ok(p.reloaded); assert.equal(p.data.confirmationSaving,false)
  const failed = page(); failed.data.confirmationNote='电话已确认'
  api.changeStatus = async () => { throw new Error('预约已变更，请刷新') }
  await failed.submitConfirmation(); assert.equal(failed.data.confirmationNote,'电话已确认'); assert.ok(failed.data.confirmationError.includes('变更'))
  assert.equal(failed.data.confirmationSaving,false)
  const switched = page(); switched.data.confirmationNote='电话已确认'; switched.rescheduleRequestId=1
  api.changeStatus = () => new Promise(done => { resolve=done })
  const old = switched.submitConfirmation(); switched.clearReschedule(); switched.data.tab='patient'; switched.data.page='home'
  resolve({}); await old; assert.equal(switched.reloaded,undefined); assert.equal(switched.data.rescheduleEditor,null)
  const fromList = page(); let opened
  fromList.data.appointments=[{ id:'visit',status:'待确认',version:7 }]
  fromList.openReschedule = e => { opened=e.currentTarget.dataset.id }
  fromList.updateStatus({ currentTarget: { dataset: { id:'visit',status:'已预约' } } }); assert.equal(opened,'visit')
  opened=null
  fromList.data.workItems=[{ id:'appointment:visit',appointmentId:'visit',appointmentStatus:'待确认',actions:[{status:'已预约'}] }]
  fromList.workStatusAction({ currentTarget: { dataset: { itemid:'appointment:visit',status:'已预约' } } }); assert.equal(opened,'visit')
  console.log('PASS: page handlers, both confirmation entrances, validation, duplicate clicks, failure recovery and stale responses')
}
main().catch(error => { console.error(error); process.exitCode=1 })
