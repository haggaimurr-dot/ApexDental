const api = require('./api')
const time = value => new Date(new Date(value).getTime() + 8 * 3600000).toISOString().slice(0,16).replace('T',' ')
module.exports = {
  clearPatientRecord() {
    this.clearRecordFeatures?.()
    this.patientRecordEpoch = (this.patientRecordEpoch || 0) + 1
    for (const path of this.recordPhotoPaths || []) wx.getFileSystemManager().unlink({ filePath: path,fail: () => {} })
    this.recordPhotoPaths = []
    this.setData({ patientRecord: null, patientRecordLoading: false, patientRecordError: '', recordAlbum: [], recordAlbumVisit: null, recordPhotoBusy: false, recordPhotoCaption: '', recordPhotoCategoryIndex: 0,recordPhotoAngleIndex: 0,recordPhotoTooth: '',recordPhotoDate: new Date(Date.now()+8*3600000).toISOString().slice(0,10),toothRows: [],selectedTooth: '',toothTreatments: [],compareSelected: [],photoComparison: null })
  },
  patientRecordGuard() {
    const epoch = this.patientRecordEpoch, profile = this.data.profile, tab = this.data.tab, page = this.data.page
    return () => this.patientRecordEpoch === epoch && this.data.profile === profile && this.data.tab === tab && this.data.page === page
  },
  openPatientRecord(e) {
    const id = e.currentTarget.dataset.member || e.currentTarget.dataset.id
    if (!id || !this.data.authReady) return
    this.clearPatientRecord(); this.patientRecordMemberId = id
    this.setData({ page: 'patient-record' }); return this.loadPatientRecord()
  },
  loadPatientRecord() {
    if (this.data.page !== 'patient-record') return Promise.resolve()
    const current = this.patientRecordGuard()
    for (const path of this.recordPhotoPaths || []) wx.getFileSystemManager().unlink({filePath:path,fail:()=>{}})
    this.recordPhotoPaths=[]
    this.setData({ patientRecord: null, patientRecordLoading: true, patientRecordError: '',photoComparison:null,compareSelected:[],toothPhotos:[] })
    return api.patientRecord(this.patientRecordMemberId,this.data.tab).then(result => {
      if (current()) {
        this.setData({ patientRecord: { ...result.record, entries: result.record.entries.map(row => ({ ...row,timeLabel: time(row.at) })) },recordAlbum: result.record.photos.map(row => ({ ...row,timeLabel: time(row.createdAt) })) })
        this.buildToothChart?.()
      }
    }).catch(error => { if (current()) this.setData({ patientRecordError: error.message,recordAlbum: [] }) })
      .finally(() => { if (current()) this.setData({ patientRecordLoading: false }) })
  },
  returnFromPatientRecord() { this.clearPatientRecord(); this.showHistory() },
  sharePatientRecord() {
    if (this.data.tab === 'patient' && this.data.patientRecord?.member.mayManage) this.openMemberShares({ currentTarget: { dataset: { id: this.data.patientRecord.member.id } } })
  },
  openRecordAlbum() {
    const appointment = this.data.selectedHistory?.appointment
    if (!appointment) return
    this.clearPatientRecord()
    this.setData({ page: 'record-album',recordAlbumVisit: appointment }); return this.loadRecordAlbum()
  },
  loadRecordAlbum() {
    if (this.data.page !== 'record-album') return Promise.resolve()
    const current = this.patientRecordGuard()
    this.setData({ patientRecordLoading: true,patientRecordError: '',recordAlbum: [] })
    return api.recordPhotos(this.data.recordAlbumVisit.id,this.data.tab).then(result => {
      if (current()) this.setData({ recordAlbum: result.photos.map(row => ({ ...row,timeLabel: time(row.createdAt) })) })
    }).catch(error => { if (current()) this.setData({ patientRecordError: error.message }) })
      .finally(() => { if (current()) this.setData({ patientRecordLoading: false }) })
  },
  returnFromRecordAlbum() {
    const id = this.data.recordAlbumVisit?.id
    this.clearPatientRecord(); this.setData({ page: 'history-detail' }); if (id) this.loadHistory(id)
  },
  recordPhotoInput(e) {
    if (this.data.recordPhotoBusy) return
    const field = e.currentTarget.dataset.field
    if (['recordPhotoCaption','recordPhotoCategoryIndex','recordPhotoAngleIndex','recordPhotoTooth','recordPhotoDate'].includes(field)) this.setData({ [field]: field.endsWith('Index') ? Number(e.detail.value) : e.detail.value })
  },
  async chooseRecordPhoto() {
    if (this.data.recordPhotoBusy || this.data.patientRecordLoading || this.data.tab !== 'clinic' || this.data.recordAlbumVisit?.status !== '已完成') return
    const current = this.patientRecordGuard(), id = this.data.recordAlbumVisit.id
    this.setData({ recordPhotoBusy: true,patientRecordError: '' })
    try {
      const result = await new Promise((resolve,reject) => wx.chooseMedia({ count: 1,mediaType: ['image'],sizeType: ['compressed'],success: resolve,fail: reject }))
      if (!current()) return
      await api.uploadRecordPhoto(id,result.tempFiles[0].tempFilePath,'record-photo-' + Date.now() + '-' + Math.random().toString(36).slice(2),this.data.recordPhotoCategories[this.data.recordPhotoCategoryIndex],this.data.recordPhotoCaption,
        { angle: this.data.recordPhotoAngles[this.data.recordPhotoAngleIndex],tooth: this.data.recordPhotoTooth.trim(),capturedOn: this.data.recordPhotoDate })
      if (current()) { this.setData({ recordPhotoCaption: '' }); await this.loadRecordAlbum() }
    } catch (error) { if (current() && !String(error.errMsg || '').includes('cancel')) this.setData({ patientRecordError: error.message || '照片归档失败' }) }
    finally { if (current()) this.setData({ recordPhotoBusy: false }) }
  },
  async previewRecordPhoto(e) {
    if (this.data.recordPhotoBusy) return
    const photo = this.data.recordAlbum.find(row => row.id === e.currentTarget.dataset.id)
    if (!photo) return
    const current = this.patientRecordGuard()
    this.setData({ recordPhotoBusy: true,patientRecordError: '' })
    try {
      const path = photo.source === 'care' ? await api.downloadCarePhoto(photo.id) : await api.downloadRecordPhoto(photo.id,this.data.tab)
      if (!current()) { wx.getFileSystemManager().unlink({ filePath: path,fail: () => {} }); return }
      this.recordPhotoPaths = [...(this.recordPhotoPaths || []),path]
      wx.previewImage({ current: path,urls: [path] })
    } catch (error) { if (current()) this.setData({ patientRecordError: error.message }) }
    finally { if (current()) this.setData({ recordPhotoBusy: false }) }
  }
}
