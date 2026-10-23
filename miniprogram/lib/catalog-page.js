const api = require('./api')
module.exports = {
  clearCatalogEditor() {
    this.catalogRequestId = (this.catalogRequestId || 0) + 1
    this.publicCatalogRequestId = (this.publicCatalogRequestId || 0) + 1
    this.setData({ catalogAdmin: null, catalogEditor: null, catalogLoading: false, catalogSaving: false, catalogError: '' })
  },
  loadCatalog() {
    const userId = this.data.profile && this.data.profile.id, requestId = (this.publicCatalogRequestId || 0) + 1
    this.publicCatalogRequestId = requestId
    return api.catalog().then(async result => {
      if (this.publicCatalogRequestId !== requestId || !this.data.profile || this.data.profile.id !== userId) return
      const services = result.services.map(row => row.name), names = result.doctors.map(row => row.name)
      const allDoctors = ['全部医生', ...result.doctorNames]
      const update = { clinicInfo: result.clinic, doctorProfiles: result.doctors.map(row => ({ ...row, serviceLabel: row.serviceNames.join('、') })), serviceProfiles: result.services.map(service => ({ ...service, doctors: result.doctors.filter(doctor => !doctor.serviceNames.length || doctor.serviceNames.includes(service.name)) })),
        services, doctors: ['不限医生', ...names], scheduleDoctors: names,
        recordDoctors: allDoctors, workDoctors: allDoctors, statisticsDoctors: allDoctors,
        recordDoctorIndex: Math.max(0, allDoctors.indexOf(this.data.recordDoctors[this.data.recordDoctorIndex])),
        workDoctorIndex: Math.max(0, allDoctors.indexOf(this.data.workDoctors[this.data.workDoctorIndex])),
        statisticsDoctorIndex: Math.max(0, allDoctors.indexOf(this.data.statisticsDoctors[this.data.statisticsDoctorIndex])),
        templateServices: ['通用', ...result.serviceNames], catalogReady: true, catalogPublicError: '' }
      for (const field of ['scheduleDoctor', 'inviteDoctor', 'batchDoctor']) if (!names.includes(this.data[field])) update[field] = names[0] || ''
      if (!this.data.bookingRecall) {
        if (!services.includes(this.data.booking.service)) update['booking.service'] = services[0] || ''
        if (!names.includes(this.data.booking.doctor) && this.data.booking.doctor !== '不限医生') update['booking.doctor'] = '不限医生'
      }
      this.setData(update)
      const faces=await Promise.all((result.avatars||[]).filter(row=>row.media).map(async row=>{try{const file=await api.downloadRecordFile(`/v1/content-media/${encodeURIComponent(row.media.id)}`);if(this.publicCatalogRequestId!==requestId||this.data.profile?.id!==userId){wx.getFileSystemManager().unlink({filePath:file,fail:()=>{}});return null}this.extensionFiles=this.extensionFiles||[];this.extensionFiles.push(file);return {doctorId:row.doctorId,path:file}}catch{return null}}))
      if(this.publicCatalogRequestId===requestId&&this.data.profile?.id===userId)this.setData({doctorProfiles:this.data.doctorProfiles.map(row=>({...row,avatar:faces.find(face=>face?.doctorId===row.id)?.path||''}))})
    }).catch(error => { if (this.publicCatalogRequestId === requestId && this.data.profile && this.data.profile.id === userId) this.setData({ catalogPublicError: error.message }); throw error })
  },
  showDirectory() { this.setData({ page: 'directory' }); this.loadCatalog().catch(error => this.showError(error)) },
  callClinic() { if (this.data.clinicInfo && this.data.clinicInfo.phone) wx.makePhoneCall({ phoneNumber: this.data.clinicInfo.phone }) },
  bookDoctor(e) {
    const name = e.currentTarget.dataset.name, doctor = this.data.doctorProfiles.find(row => row.name === name)
    const requested = e.currentTarget.dataset.service
    const service = doctor && (requested ? this.data.services.find(name => name === requested && (!doctor.serviceNames.length || doctor.serviceNames.includes(name))) : this.data.services.find(name => !doctor.serviceNames.length || doctor.serviceNames.includes(name)))
    if (!service) return this.showError(new Error('该医生暂未提供可预约项目，请联系诊所'))
    this.startBooking({ currentTarget: { dataset: { service } } })
    this.setData({ 'booking.doctor': name, 'booking.slot': '' }); this.refreshDerived()
  },
  showCatalogAdmin() {
    if (!this.data.profile || this.data.profile.role !== 'admin' || this.data.tab !== 'clinic') return
    this.setData({ page: 'catalog-admin', catalogEditor: null }); this.loadCatalogAdmin()
  },
  loadCatalogAdmin() {
    if (!this.data.profile || this.data.profile.role !== 'admin' || this.data.tab !== 'clinic') return Promise.resolve()
    const requestId = (this.catalogRequestId || 0) + 1, userId = this.data.profile.id
    this.catalogRequestId = requestId
    this.setData({ catalogLoading: true, catalogError: '', catalogAdmin: null })
    return api.adminCatalog().then(result => {
      if (this.catalogRequestId === requestId && this.data.profile && this.data.profile.id === userId && this.data.tab === 'clinic') this.setData({ catalogAdmin: result })
    }).catch(error => { if (this.catalogRequestId === requestId) this.setData({ catalogError: error.message }) })
      .finally(() => { if (this.catalogRequestId === requestId) this.setData({ catalogLoading: false }) })
  },
  editCatalog(e) {
    if (!this.data.catalogAdmin || this.data.catalogSaving) return
    const { kind, id } = e.currentTarget.dataset
    if (!['clinic', 'doctors', 'services'].includes(kind)) return
    const existing = kind === 'clinic' ? this.data.catalogAdmin.clinic : this.data.catalogAdmin[kind].find(row => row.id === id)
    if (id && !existing) return
    const editor = existing ? { ...existing } : { name: '', introduction: '', title: '', license: '', specialties: '', serviceNames: [], preparation: '', durationMinutes: 30, enabled: true, version: 0 }
    this.setData({ doctorIdentityChecked:false,doctorQualificationChecked:false,doctorVerificationNote:'',page: 'catalog-edit', catalogKind: kind, catalogEditor: editor, catalogError: '',
      catalogFields: kind === 'clinic' ? [{ key: 'name', label: '诊所名称', max: 60 }, { key: 'phone', label: '联系电话', max: 30 }, { key: 'address', label: '诊所地址', max: 300 }, { key: 'hours', label: '营业时间', max: 300 }]
        : kind === 'doctors' ? [{ key: 'name', label: '医生姓名', max: 60 }, { key: 'title', label: '职称', max: 100 }, { key: 'license', label: '执业信息', max: 100 }, { key: 'specialties', label: '擅长项目', max: 500 }]
          : [{ key: 'name', label: '项目名称', max: 60 }, { key: 'durationMinutes', label: '参考时长（分钟，1–480）', max: 3 }],
      catalogServiceChoices: this.data.catalogAdmin.services.map(row => ({ ...row, checked: (editor.serviceNames || []).includes(row.name) })) })
    this.setData({ catalogFields: this.data.catalogFields.map(field => ({ ...field, value: editor[field.key] })) })
  },
  catalogInput(e) {
    const field = e.currentTarget.dataset.field
    if (this.data.catalogSaving || !this.data.catalogEditor || !['name', 'phone', 'address', 'hours', 'title', 'license', 'specialties', 'introduction', 'preparation', 'durationMinutes', 'enabled'].includes(field)) return
    this.setData({ [`catalogEditor.${field}`]: e.detail.value, catalogFields: this.data.catalogFields.map(item => item.key === field ? { ...item, value: e.detail.value } : item) })
  },
  catalogServicesChange(e) { if (!this.data.catalogSaving) this.setData({ 'catalogEditor.serviceNames': e.detail.value }) },
  saveCatalog() {
    if (this.data.catalogSaving || !this.data.catalogEditor || this.data.tab !== 'clinic' || !this.data.profile || this.data.profile.role !== 'admin') return
    const kind = this.data.catalogKind, entry = { ...this.data.catalogEditor }
    if (kind === 'services') entry.durationMinutes = Number(entry.durationMinutes)
    const userId = this.data.profile.id, requestId = this.catalogRequestId
    this.setData({ catalogSaving: true, catalogError: '' })
    api.saveCatalog(kind, entry).then(() => {
      if (this.catalogRequestId !== requestId || !this.data.profile || this.data.profile.id !== userId || this.data.tab !== 'clinic') return
      wx.showToast({ title: '资料已保存' })
      this.setData({ page: 'catalog-admin', catalogEditor: null })
      return Promise.all([this.loadCatalogAdmin(), this.loadCatalog().catch(error => this.showError(error))])
    }).catch(error => { if (this.catalogRequestId === requestId) this.setData({ catalogError: error.message }) })
      .finally(() => { if (this.data.profile && this.data.profile.id === userId) this.setData({ catalogSaving: false }) })
  },
  cancelCatalogEdit() { if (!this.data.catalogSaving) this.showCatalogAdmin() }
}
