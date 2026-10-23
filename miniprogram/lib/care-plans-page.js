const api = require('./api')
const { workflows, buildWorkflow } = require('./care-workflows')
const labels = { draft: '草稿', scheduled: '待按日期或阶段发送', paused: '已暂停', archived: '已终止', active: '进行中', completed: '已完成', published: '待反馈', waiting_review: '待处理', resolved: '已处理' }
const decorate = plan => ({ ...plan, statusLabel: labels[plan.status], nodes: plan.nodes.map((node, index) => ({ ...node, _key: node.id || node.taskId || `draft-${index}`, statusLabel: labels[node.status] || '待发送' })) })
const key = () => 'plan-' + Date.now() + '-' + Math.random().toString(36).slice(2)
module.exports = {
  addFollowupNode(){if(this.data.planBusy||!this.data.planSelected)return;this.setData({planNodeTaskId:'',planNodeEditor:{title:'',instructions:'',dueDate:new Date(Date.now()+8*3600000).toISOString().slice(0,10),phase:'',autoNormal:false,lossAfterDays:7,followupIntervalDays:3}})},
  editFollowupNode(e){if(this.data.planBusy)return;const row=this.data.planSelected?.nodes.find(item=>item.id===e.currentTarget.dataset.id);if(row)this.setData({planNodeTaskId:row.id,planNodeEditor:{title:row.title,instructions:row.instructions,dueDate:row.dueDate,phase:row.phase||'',autoNormal:row.autoNormal===true,lossAfterDays:row.lossAfterDays||7,followupIntervalDays:row.followupIntervalDays||3}})},
  followupNodeInput(e){if(this.data.planBusy)return;const field=e.currentTarget.dataset.field;if(['title','instructions','dueDate','phase'].includes(field))this.setData({[`planNodeEditor.${field}`]:e.detail.value})},
  saveFollowupNode(){if(this.data.planBusy||!this.data.planNodeEditor||!this.data.planSelected)return;const current=this.planGuard(),row=this.data.planSelected;this.setData({planBusy:true,planError:''});return api.featureRequest('POST',`/v1/care-plans/${encodeURIComponent(row.id)}/manage`,{version:row.version,action:this.data.planNodeTaskId?'update-node':'append',taskId:this.data.planNodeTaskId,node:this.data.planNodeEditor}).then(result=>{if(current())this.setData({planSelected:decorate(result.plan),planNodeEditor:null,planNodeTaskId:''})}).catch(error=>{if(current())this.setData({planError:error.message})}).finally(()=>{if(current())this.setData({planBusy:false})})},
  maintainCarePlan(e) {
    if(this.data.planBusy||this.data.tab!=='clinic'||!this.data.planSelected)return
    const current=this.planGuard(),row=this.data.planSelected
    this.setData({planBusy:true,planError:''})
    return api.featureRequest('POST',`/v1/care-plans/${encodeURIComponent(row.id)}/manage`,{version:row.version,action:e.currentTarget.dataset.action}).then(result=>{if(current())this.setData({planSelected:decorate(result.plan)})}).catch(error=>{if(current())this.setData({planError:error.message})}).finally(()=>{if(current())this.setData({planBusy:false})})
  },
  applyCareWorkflow(e) {
    if (this.data.planBusy || !this.data.planEditor || this.data.tab !== 'clinic') return
    const id = e.currentTarget.dataset.id, workflow = workflows.find(item => item.id === id)
    if (!workflow) return
    this.setData({ planEditor: { ...this.data.planEditor, title: workflow.name + '专属护理流程', requestKey: key(),
      nodes: buildWorkflow(id, this.data.planEditor.anchorDate || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)).map(node => ({ ...node, _key: key() })) } })
  },
  recallOutcomeChange(e) { if (!this.data.followupSaving) this.setData({ 'followupEditor.outcome': ['reached', 'unreachable', 'declined'][Number(e.detail.value)] }) },
  careContactInput(e) { if (!this.data.careBusy) this.setData({ careContactNote: e.detail.value, careContactKey: '' }) },
  recordCareContact(e) {
    if (this.data.careBusy || this.data.tab !== 'clinic' || !this.data.selectedCare) return
    const task = this.data.selectedCare, profile = this.data.profile, outcome = e.currentTarget.dataset.outcome
    const requestKey = this.data.careContactOutcome === outcome && this.data.careContactKey || key(), note = this.data.careContactNote || ''
    const current = () => this.data.profile === profile && this.data.tab === 'clinic' && this.data.page === 'care-review' && this.data.selectedCare?.id === task.id
    this.setData({ careBusy: true, careContactKey: requestKey, careContactOutcome: outcome })
    return api.followupCare(task.id, { outcome, note, requestKey }).then(async () => {
      if (!current()) return
      const result = await api.tasks('clinic')
      if (!current()) return
      this.setData({ selectedCare: result.tasks.find(item => item.id === task.id), careContactNote: '', careContactKey: '' })
      this.refreshRemote(); wx.showToast({ title: '跟进已记录' })
    }).catch(error => { if (current()) this.showError(error) }).finally(() => { if (this.data.profile === profile && this.data.tab === 'clinic') this.setData({ careBusy: false }) })
  },
  showTodayTasks() { if (this.data.tab === 'patient') { this.setData({ page: 'today-tasks' }); return this.refreshRemote() } },
  openTodayTask(e) {
    const { kind, id } = e.currentTarget.dataset
    if (kind === 'care') this.openCareFeedback({ currentTarget: { dataset: { id } } })
    else if (kind === 'recall') this.startRecallBooking({ currentTarget: { dataset: { id } } })
    else this.openHistory({ currentTarget: { dataset: { id } } })
  },
  clearCarePlans() {
    this.planEpoch = (this.planEpoch || 0) + 1
    this.setData({ carePlans: [], planVisible: [], planSelected: null, planEditor: null, planCandidates: [], planLoading: false, planBusy: false, planError: '', planNodeEditor:null, planNodeTaskId:'', planFilter: 'all' })
  },
  planGuard() {
    const epoch = this.planEpoch, profile = this.data.profile, tab = this.data.tab, page = this.data.page
    return () => epoch === this.planEpoch && profile === this.data.profile && tab === this.data.tab && page === this.data.page
  },
  showCarePlans() {
    if (!this.data.authReady || this.data.tab === 'clinic' && !['admin', 'doctor'].includes(this.data.profile?.role)) return
    if (this.data.planBusy) return
    this.clearCarePlans(); this.setData({ page: 'care-plans' }); return this.loadCarePlans()
  },
  loadCarePlans() {
    if (this.data.planLoading || this.data.planBusy) return Promise.resolve()
    const current = this.planGuard()
    this.setData({ planLoading: true, planError: '' })
    return api.carePlans(this.data.tab).then(result => {
      if (!current()) return
      this.setData({ carePlans: result.plans.map(decorate) }); this.filterCarePlanList()
    }).catch(error => { if (current()) this.setData({ planError: error.message, carePlans: [], planVisible: [] }) })
      .finally(() => { if (current()) this.setData({ planLoading: false }) })
  },
  filterCarePlanList() {
    this.setData({ planVisible: this.data.carePlans.filter(plan => (this.data.planFilter === 'all' || plan.status === this.data.planFilter) &&
      (this.data.tab === 'clinic' || this.data.memberFilter === 'all' || (this.data.memberFilter === 'unassigned' ? !plan.memberId : plan.memberId === this.data.memberFilter))) })
  },
  filterCarePlans(e) { this.setData({ planFilter: e.currentTarget.dataset.status }); this.filterCarePlanList() },
  openCarePlan(e) {
    if (this.data.planLoading || this.data.planBusy) return
    const id = e.currentTarget.dataset.id, current = this.planGuard()
    this.setData({ planLoading: true, planError: '', planSelected: null })
    return api.carePlan(id, this.data.tab).then(result => { if (current()) this.setData({ planSelected: decorate(result.plan) }) })
      .catch(error => { if (current()) this.setData({ planError: error.message }) })
      .finally(() => { if (current()) this.setData({ planLoading: false }) })
  },
  newCarePlan(e) {
    if (this.data.tab !== 'clinic' || !['doctor', 'admin'].includes(this.data.profile?.role) || this.data.planBusy) return
    const id = e.currentTarget.dataset.appointmentid
    const visit = this.data.appointments.find(item => item.id === id) || (this.data.selectedHistory?.appointment.id === id ? this.data.selectedHistory.appointment : null)
    if (!visit || visit.status !== '已完成') return
    this.clearCarePlans()
    const completedAt = this.data.selectedHistory?.appointment.id === id ? this.data.selectedHistory.entries.find(entry => entry.title === '接诊完成')?.at : ''
    const anchorDate = visit.completedOn || (completedAt ? new Date(Date.parse(completedAt) + 8 * 3600000).toISOString().slice(0, 10) : visit.date) || new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    this.setData({ page: 'care-plans', planEditor: { appointmentId: id, patient: visit.patient, title: visit.service + '诊后计划', anchorDate, nodes: [], requestKey: key() } })
    this.addCarePlanNode()
    return this.loadCarePlanCandidates(id)
  },
  loadCarePlanCandidates(id) {
    const current = this.planGuard()
    // Refresh candidates so a stale queue cannot hide newly sent tasks.
    return Promise.all([api.tasks('clinic'), api.carePlans('clinic')]).then(([tasks, plans]) => {
      if (!current()) return
      const linked = new Set(plans.plans.filter(plan => plan.status !== 'draft').flatMap(plan => plan.nodes.map(node => node.id)))
      this.setData({ planCandidates: tasks.tasks.filter(task => task.appointmentId === id && ['published', 'waiting_review', 'resolved'].includes(task.status) && !linked.has(task.id)) })
    }).catch(error => { if (current()) this.setData({ planError: error.message }) })
  },
  editCarePlan() {
    if (this.data.planBusy || this.data.tab !== 'clinic' || this.data.planSelected?.status !== 'draft') return
    this.setData({ planEditor: { ...this.data.planSelected, nodes: this.data.planSelected.nodes.map(node => ({ ...node })) }, planSelected: null, planCandidates: [] })
    return this.loadCarePlanCandidates(this.data.planEditor.appointmentId)
  },
  carePlanInput(e) {
    if (this.data.planBusy || !this.data.planEditor) return
    const { field, index } = e.currentTarget.dataset, editor = this.data.planEditor
    if (index === undefined) {
      if (['title', 'anchorDate'].includes(field)) this.setData({ planEditor: { ...editor, [field]: e.detail.value, requestKey: key() } })
    } else if (['title', 'instructions', 'dueDate', 'phase', 'autoNormal', 'lossAfterDays', 'followupIntervalDays'].includes(field)) {
      const nodes = editor.nodes.map((node, i) => i === Number(index) && !node.taskId ? { ...node, [field]: ['lossAfterDays', 'followupIntervalDays'].includes(field) ? Number(e.detail.value) : e.detail.value } : node)
      this.setData({ planEditor: { ...editor, nodes, requestKey: key() } })
    }
  },
  addCarePlanNode() {
    if (this.data.planBusy || !this.data.planEditor || this.data.planEditor.nodes.length >= 20) return
    const dueDate = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    this.setData({ planEditor: { ...this.data.planEditor, requestKey: key(), nodes: [...this.data.planEditor.nodes, { _key: key(), title: '', instructions: '', dueDate }] } })
  },
  addExistingCareNode(e) {
    const task = this.data.planCandidates.find(item => item.id === e.currentTarget.dataset.id)
    if (!task || this.data.planBusy || !this.data.planEditor || this.data.planEditor.nodes.length >= 20 || this.data.planEditor.nodes.some(node => node.taskId === task.id)) return
    this.setData({ planEditor: { ...this.data.planEditor, requestKey: key(), nodes: [...this.data.planEditor.nodes, { _key: task.id, taskId: task.id, title: task.title, instructions: task.instructions, dueDate: task.dueDate }] } })
  },
  changeCarePlanNode(e) {
    if (this.data.planBusy || !this.data.planEditor) return
    const { index, direction } = e.currentTarget.dataset, nodes = [...this.data.planEditor.nodes], i = Number(index)
    if (direction === 'remove') nodes.splice(i, 1)
    else { const target = i + Number(direction); if (target < 0 || target >= nodes.length) return; [nodes[i], nodes[target]] = [nodes[target], nodes[i]] }
    this.setData({ planEditor: { ...this.data.planEditor, requestKey: key(), nodes } })
  },
  saveCarePlan() {
    if (this.data.planBusy || !this.data.planEditor) return
    const current = this.planGuard(), editor = this.data.planEditor
    this.setData({ planBusy: true, planError: '' })
    return api.saveCarePlan(editor).then(result => {
      if (current()) { this.setData({ planEditor: null, planSelected: decorate(result.plan) }); wx.showToast({ title: '计划草稿已保存' }) }
    }).catch(error => { if (current()) this.setData({ planError: error.message }) })
      .finally(() => { if (current()) this.setData({ planBusy: false }) })
  },
  publishCarePlan() {
    if (this.data.planBusy || this.data.planSelected?.status !== 'draft' || this.data.tab !== 'clinic') return
    const current = this.planGuard(), plan = this.data.planSelected
    this.setData({ planBusy: true, planError: '' })
    return api.publishCarePlan(plan.id, plan.version).then(result => {
      if (current()) { this.setData({ planSelected: decorate(result.plan) }); this.refreshRemote(); wx.showToast({ title: '护理计划已发送' }) }
    }).catch(error => { if (current()) this.setData({ planError: error.message }) })
      .finally(() => { if (current()) this.setData({ planBusy: false }) })
  },
  openCarePlanTask(e) {
    const task = this.data.planSelected?.nodes.find(node => node.id === e.currentTarget.dataset.id)
    if (!task || this.data.planBusy) return
    // Detail handlers use the live task list and keep photos/feedback permissions intact.
    const id = task.id, current = this.planGuard()
    return api.tasks(this.data.tab).then(result => {
      if (!current()) return
      this.setData({ tasks: result.tasks.map(node => ({ ...node, statusLabel: labels[node.status] })) })
      if (this.data.tab === 'clinic') this.openCareReview({ currentTarget: { dataset: { id } } })
      else this.openCareFeedback({ currentTarget: { dataset: { id } } })
    }).catch(error => { if (current()) this.setData({ planError: error.message }) })
  }
}
