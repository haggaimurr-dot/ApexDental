const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const api = require('../../miniprogram/lib/api')
const mixin = require('../../miniprogram/lib/care-plans-page')
let definition, toasts = 0
global.Page = value => { definition = value }
global.wx = { showToast: () => { toasts++ } }
require('../../miniprogram/pages/index/index')
const tap = dataset => ({ currentTarget: { dataset } })
function page(tab = 'clinic', role = 'doctor') {
  const instance = { ...mixin, data: { ...structuredClone(definition.data), tab, profile: { id: 'owner', role }, authReady: true },
    setData(values) { Object.assign(this.data, values) }, refreshRemote() { this.refreshed = true },
    openCareFeedback(e) { this.opened = e.currentTarget.dataset.id }, openCareReview(e) { this.opened = e.currentTarget.dataset.id } }
  instance.clearCarePlans(); return instance
}
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { resolve, promise } }
const node = { title: '护理节点', instructions: '医生填写', dueDate: '2026-10-03' }
const plan = { id: 'plan', appointmentId: 'visit', title: '计划', patient: '患者', status: 'draft', memberId: 'member', version: 1, nodes: [node], total: 1, done: 0 }
async function main() {
  const wxml = fs.readFileSync(path.join(__dirname, '../../miniprogram/pages/index/index.wxml'), 'utf8')
  for (const match of wxml.matchAll(/bind(?:tap|input|change)="([A-Za-z_][A-Za-z0-9_]*)"/g)) assert.equal(typeof definition[match[1]], 'function', match[1])
  const instance = page(), old = deferred()
  api.carePlans = () => old.promise
  const pending = instance.showCarePlans(); instance.clearCarePlans(); instance.data.tab = 'patient'
  old.resolve({ plans: [plan] }); await pending
  assert.equal(instance.data.carePlans.length, 0)
  api.carePlans = async () => ({ plans: [plan, { ...plan, id: 'active', status: 'active' }] })
  await instance.showCarePlans(); assert.equal(instance.data.planVisible.length, 2)
  instance.data.memberFilter = 'another-member'; instance.filterCarePlanList(); assert.equal(instance.data.planVisible.length, 0)
  instance.data.memberFilter = 'member'; instance.filterCarePlans(tap({ status: 'active' })); assert.equal(instance.data.planVisible.length, 1)
  const clinic = page()
  clinic.data.appointments = [{ id: 'visit', patient: '患者', service: '洁牙', status: '已完成' }]
  api.tasks = async () => ({ tasks: [{ ...node, id: 'existing', appointmentId: 'visit', status: 'published' }, { ...node, id: 'draft-task', appointmentId: 'visit', status: 'draft' }] })
  await clinic.newCarePlan(tap({ appointmentid: 'visit' }))
  assert.equal(clinic.data.planCandidates.length, 1)
  clinic.carePlanInput({ ...tap({ field: 'title', index: 0 }), detail: { value: '第一节点' } })
  clinic.addExistingCareNode(tap({ id: 'existing' })); clinic.addExistingCareNode(tap({ id: 'existing' }))
  assert.equal(clinic.data.planEditor.nodes.length, 2)
  clinic.changeCarePlanNode(tap({ index: 1, direction: '-1' })); assert.equal(clinic.data.planEditor.nodes[0].taskId, 'existing')
  clinic.carePlanInput({ ...tap({ field: 'title', index: 0 }), detail: { value: '禁止改变原任务' } })
  assert.equal(clinic.data.planEditor.nodes[0].title, node.title)
  clinic.changeCarePlanNode(tap({ index: 0, direction: 'remove' })); assert.equal(clinic.data.planEditor.nodes[0].title, '第一节点')
  let saveCalls = 0, firstKey
  api.saveCarePlan = async editor => { saveCalls++; firstKey = editor.requestKey; throw new Error('超时') }
  await clinic.saveCarePlan(); assert.equal(clinic.data.planEditor.requestKey, firstKey); assert.equal(clinic.data.planBusy, false)
  api.saveCarePlan = async editor => { assert.equal(editor.requestKey, firstKey); return { plan } }
  await clinic.saveCarePlan(); assert.equal(clinic.data.planSelected.id, 'plan'); assert.equal(clinic.data.planEditor, null)
  await clinic.editCarePlan(); assert.equal(clinic.data.planCandidates.length, 1)
  clinic.data.planEditor = null; clinic.data.planSelected = plan
  let publishCalls = 0
  const publish = deferred()
  api.publishCarePlan = () => { publishCalls++; return publish.promise }
  const publishing = clinic.publishCarePlan(); clinic.publishCarePlan(); assert.equal(publishCalls, 1)
  publish.resolve({ plan: { ...plan, status: 'active', nodes: [{ ...node, id: 'existing', status: 'published' }] } }); await publishing
  assert.equal(clinic.data.planSelected.status, 'active'); assert.ok(clinic.refreshed)
  await clinic.openCarePlanTask(tap({ id: 'existing' })); assert.equal(clinic.opened, 'existing')
  const stale = deferred(), previousToasts = toasts
  clinic.data.planEditor = { ...plan, requestKey: 'stale-key' }; api.saveCarePlan = () => stale.promise
  const saving = clinic.saveCarePlan(); clinic.clearCarePlans(); clinic.data.profile = { id: 'other', role: 'doctor' }
  stale.resolve({ plan }); await saving; assert.equal(clinic.data.planSelected, null); assert.equal(toasts, previousToasts)
  const desk = page('clinic', 'frontdesk'); desk.showCarePlans(); assert.equal(desk.data.page, 'home')
  // Leaving the page while a detail response is pending cannot repopulate hidden data.
  const detail = deferred(); instance.data.page = 'care-plans'; instance.data.planLoading = false
  api.carePlan = () => detail.promise
  const opening = instance.openCarePlan(tap({ id: 'plan' })); instance.data.page = 'home'
  detail.resolve({ plan }); await opening; assert.equal(instance.data.planSelected, null)
  const { workflows, buildWorkflow } = require('../../miniprogram/lib/care-workflows')
  const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
  assert.equal(workflows.length, 4)
  for (const workflow of workflows) {
    const stages = buildWorkflow(workflow.id, today)
    assert.ok(stages.length >= 3); assert.ok(stages.every(row => !row.autoNormal && row.phase && row.dueDate >= today))
  }
  const dates = buildWorkflow('cleaning', today).map(row => (Date.parse(row.dueDate) - Date.parse(today)) / 86400000)
  assert.deepEqual(dates, [0, 3, 7, 30, 180])
  const editor = page(); editor.data.planEditor = { ...plan, anchorDate: today }
  editor.applyCareWorkflow(tap({ id: 'orthodontics' }))
  assert.equal(editor.data.planEditor.nodes.length, 4); assert.ok(editor.data.planEditor.nodes.some(row => row.phase === '阶段照片'))
  const tasksPage = { ...definition, data: { ...structuredClone(definition.data), tab: 'patient', memberFilter: 'all', storageMode: '未连接' }, setData(values) { Object.assign(this.data, values) } }
  tasksPage.data.tasks = [
    { id: 'due', memberId: 'member', title: '今日护理', dueDate: today, status: 'published', mayManage: true },
    { id: 'done', memberId: 'member', dueDate: today, status: 'resolved' },
    { id: 'review', memberId: 'member', dueDate: today, status: 'waiting_review' },
    { id: 'future', memberId: 'other', dueDate: '2999-01-01', status: 'published' },
    { id: 'overdue', memberId: 'other', dueDate: '2000-01-01', status: 'published', mayManage: false }
  ]
  tasksPage.data.appointments = [{ id: 'visit-today', date: today, status: '已预约', service: '正畸', slot: '10:00', memberId: 'member' }]
  tasksPage.data.recalls = [{ appointmentId: 'recall', dueDate: today, status: 'pending', service: '正畸', memberId: 'member', mayManage: true }]
  tasksPage.refreshDerived()
  assert.equal(tasksPage.data.todayTasks.length, 4); assert.equal(tasksPage.data.todayTotal, 3); assert.equal(tasksPage.data.todayCompleted, 1); assert.equal(tasksPage.data.todayRate, '33.3%')
  tasksPage.data.memberFilter = 'member'; tasksPage.refreshDerived(); assert.equal(tasksPage.data.todayTasks.length, 3)
  tasksPage.data.memberFilter = 'absent'; tasksPage.refreshDerived(); assert.equal(tasksPage.data.todayTasks.length, 0); assert.equal(tasksPage.data.todayRate, '—')
  tasksPage.data.workItems = [{ id: 'lost', followupState: 'lost', group: 'care', patient: '患者', doctor: '医生', title: '失访', description: '', filterDate: today, actionable: false }]
  tasksPage.data.workStatus = 'lost'; tasksPage.filterWorklist(); assert.equal(tasksPage.data.visibleWorkItems.length, 1)
  console.log('PASS: care plan page bindings, filters, editing, grouping, retries, duplicate clicks, task navigation and stale responses')
}
main().catch(error => { console.error(error); process.exitCode = 1 })
