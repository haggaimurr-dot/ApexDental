const api = require('./api')
const statuses = { submitted: '待受理', processing: '处理中', completed: '已完成', rejected: '未予办理', withdrawn: '已撤回' }
module.exports = {
  clearRecordRequests() {
    this.recordRequestsEpoch = (this.recordRequestsEpoch || 0) + 1
    this.setData({ requestItems: [], requestPage: 0, requestHasMore: false, requestLoading: false,
      requestBusy: false, requestError: '', requestFilter: '', requestEditor: null, requestReview: null, requestNote: '', requestConfirmed: false, requestCorrection: null })
  },
  recordRequestsGuard() {
    const epoch = this.recordRequestsEpoch, profile = this.data.profile, tab = this.data.tab, page = this.data.page
    return () => epoch === this.recordRequestsEpoch && profile === this.data.profile && tab === this.data.tab && page === this.data.page
  },
  showRecordRequests() {
    if (!this.data.authReady) return this.showError(new Error('请先登录'))
    if (this.data.tab === 'clinic' && this.data.profile?.role !== 'admin') return
    this.clearRecordRequests(); this.setData({ page: 'record-requests' }); return this.loadRecordRequests()
  },
  loadRecordRequests(more = false) {
    if (typeof more !== 'boolean') more = false
    if (this.data.page !== 'record-requests' || this.data.requestLoading || more && !this.data.requestHasMore) return Promise.resolve()
    const current = this.recordRequestsGuard(), page = more ? this.data.requestPage + 1 : 1
    this.setData({ requestLoading: true, requestError: '' })
    return api.recordRequests(this.data.tab === 'clinic' ? 'clinic' : 'mine', page, this.data.requestFilter).then(result => {
      if (current()) this.setData({ requestItems: [...(more ? this.data.requestItems : []), ...result.items.map(item => ({ ...item,
        kindLabel: item.kind === 'correction' ? '更正申请' : '删除申请', statusLabel: statuses[item.status],
        events: item.events.map(event => ({ ...event, statusLabel: statuses[event.status], timeLabel: new Date(new Date(event.createdAt).getTime() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ') + ' 北京时间' })) }))],
        requestPage: page, requestHasMore: result.hasMore, ...(!more ? { requestReview: null } : {}) })
    }).catch(error => { if (current()) this.setData({ requestError: error.message }) })
      .finally(() => { if (current()) this.setData({ requestLoading: false }) })
  },
  moreRecordRequests() { return this.loadRecordRequests(true) },
  filterRecordRequests(e) {
    if (this.data.requestLoading || this.data.requestBusy) return
    this.recordRequestsEpoch = (this.recordRequestsEpoch || 0) + 1
    this.setData({ requestFilter: e.currentTarget.dataset.status, requestItems: [], requestReview: null }); return this.loadRecordRequests()
  },
  startRecordRequest() {
    const appointment = this.data.selectedHistory?.appointment
    if (this.data.tab !== 'patient' || !appointment?.mayManage) return
    this.clearRecordRequests()
    this.setData({ page: 'record-requests', requestEditor: { appointmentId: appointment.id, patient: appointment.patient,
      kind: 'correction', details: '', requestKey: 'record-' + Date.now() + '-' + Math.random().toString(36).slice(2) } })
    return this.loadRecordRequests()
  },
  recordRequestInput(e) {
    if (this.data.requestBusy) return
    const field = e.currentTarget.dataset.field
    if (field === 'details' && this.data.requestEditor) {
      this.setData({ requestEditor: { ...this.data.requestEditor, details: e.detail.value,
        requestKey: 'record-' + Date.now() + '-' + Math.random().toString(36).slice(2) } })
    } else if (field === 'note') this.setData({ requestNote: e.detail.value })
    else if (field === 'confirmed') this.setData({ requestConfirmed: e.detail.value })
  },
  recordRequestKind(e) {
    if (this.data.requestBusy || !this.data.requestEditor) return
    this.setData({ requestEditor: { ...this.data.requestEditor, kind: e.currentTarget.dataset.kind,
      requestKey: 'record-' + Date.now() + '-' + Math.random().toString(36).slice(2) } })
  },
  submitRecordRequest() {
    if (this.data.requestBusy || this.data.requestLoading || !this.data.requestEditor) return
    const current = this.recordRequestsGuard()
    this.setData({ requestBusy: true, requestError: '' })
    return api.submitRecordRequest(this.data.requestEditor).then(() => {
      if (current()) { this.setData({ requestEditor: null }); wx.showToast({ title: '申请已提交' }); return this.loadRecordRequests() }
    }).catch(error => { if (current()) this.setData({ requestError: error.message }) })
      .finally(() => { if (current()) this.setData({ requestBusy: false }) })
  },
  reviewRecordRequest(e) {
    if (this.data.requestBusy) return
    const item = this.data.requestItems.find(item => item.id === e.currentTarget.dataset.id)
    if (item) this.setData({ requestReview: item, requestNote: '', requestConfirmed: false, requestEditor: null, requestCorrection: null })
  },
  loadRequestCorrection() {
    const item = this.data.requestReview
    if (this.data.requestBusy || this.data.tab !== 'clinic' || item?.kind !== 'correction') return
    const current = this.recordRequestsGuard()
    this.setData({ requestBusy: true,requestError: '',requestCorrection: null })
    return api.history(item.appointmentId,'clinic').then(result => {
      if (!current() || this.data.requestReview?.id !== item.id) return
      const summary = result.history.summary
      this.setData({ requestCorrection: { version: summary?.version || 0,findings: summary?.findings || '',treatment: summary?.treatment || '',nextSteps: summary?.nextSteps || '',
        diagnosis: summary?.structured?.diagnosis || '',teeth: (summary?.structured?.teeth || []).join(' '),procedure: summary?.structured?.procedure || '',materials: summary?.structured?.materials || '' } })
    }).catch(error => { if (current()) this.setData({ requestError: error.message }) })
      .finally(() => { if (current()) this.setData({ requestBusy: false }) })
  },
  requestCorrectionInput(e) {
    const field = e.currentTarget.dataset.field
    if (!this.data.requestBusy && this.data.requestCorrection && ['findings','treatment','nextSteps','diagnosis','teeth','procedure','materials'].includes(field)) this.setData({ requestCorrection: { ...this.data.requestCorrection,[field]: e.detail.value } })
  },
  updateRecordRequest(e) {
    if (this.data.requestBusy || this.data.requestLoading || !this.data.requestReview) return
    const current = this.recordRequestsGuard(), item = this.data.requestReview, status = e.currentTarget.dataset.status
    const body = { status, version: item.version, note: this.data.requestNote, confirmed: this.data.requestConfirmed }
    if (status === 'completed' && item.kind === 'correction') {
      const correction = this.data.requestCorrection
      if (!correction) return this.setData({ requestError: '请先加载当前小结并填写更正内容' })
      body.correction = { version: correction.version,findings: correction.findings,treatment: correction.treatment,nextSteps: correction.nextSteps,
        structured: { diagnosis: correction.diagnosis,teeth: correction.teeth.trim() ? correction.teeth.trim().split(/[\s,，、]+/) : [],procedure: correction.procedure,materials: correction.materials } }
    }
    this.setData({ requestBusy: true, requestError: '' })
    return api.updateRecordRequest(item.id, body).then(() => {
      if (current()) {
        this.setData({ requestReview: null, requestNote: '', requestConfirmed: false, requestCorrection: null })
        if (status === 'completed') {
          this.clearCarePhotoCache?.()
          this.setData({ selectedHistory: null, selectedCare: null, summaryEditor: null })
          this.refreshRemote?.()
        }
        return this.loadRecordRequests()
      }
    }).catch(error => { if (current()) this.setData({ requestError: error.message }) })
      .finally(() => { if (current()) this.setData({ requestBusy: false }) })
  }
}
