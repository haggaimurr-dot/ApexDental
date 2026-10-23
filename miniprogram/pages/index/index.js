const appointmentRules = require('../../lib/appointments')
const api = require('../../lib/api')
const TOKEN_KEY = 'apexDentalSessionV1'
const DEVICE_KEY = 'apexDentalDemoDeviceV1'
const services = []
const doctors = ['不限医生']
const careLabels = { scheduled:'待发送',paused:'已暂停',draft: '待编写', published: '待反馈', waiting_review: '待处理', resolved: '已处理' }
function careView(task) { return { ...task, statusLabel: task.followupState === 'lost' ? '失访待跟进' : careLabels[task.status] || task.status } }
function recallView(plan) {
  return { ...plan, id:plan.nodeId||plan.appointmentId,statusLabel: plan.status === 'completed' ? '复查已完成' : plan.status === 'booked' ? '已提交预约' : plan.followupState === 'lost' ? '失访待跟进' : plan.overdue ? '已过建议日期' : '待预约复查' }
}
function historyTime(value) {
  const date = new Date(new Date(value).getTime() + 8 * 60 * 60 * 1000)
  return Number.isFinite(date.getTime()) ? date.toISOString().slice(0, 16).replace('T', ' ') : '时间未记录'
}

Page({
  ...require('../../lib/extensions-page'),
  ...require('../../lib/care-plans-page'),
  ...require('../../lib/articles-page'),
  ...require('../../lib/catalog-page'),
  ...require('../../lib/notifications-page'),
  ...require('../../lib/record-requests-page'),
  ...require('../../lib/patient-records-page'),
  ...require('../../lib/record-features-page'),
  data: {
    articleMedia:[],articleFavorite:false,articleMetaFields:[{key:'definition',label:'定义'},{key:'manifestations',label:'表现'},{key:'causes',label:'常见原因'},{key:'consultation',label:'就诊沟通提示'},{key:'examination',label:'检查说明'},{key:'treatment',label:'治疗说明'},{key:'preparation',label:'治疗前准备'},{key:'aftercare',label:'治疗后注意事项'}],articleKindChoices:['普通文章','疾病百科','项目百科'],
    isDemo:true,extSection:'',extTitle:'',extLoading:false,extBusy:false,extError:'',extEditor:{},extItems:[],extResult:null,extSelected:null,extHasMore:false,extPage:0,extPrivacyAccepted:false,extStageMode:'',extScreeningEditing:false,
    extAngles:[{id:'front',name:'正面'},{id:'upper',name:'上牙列'},{id:'lower',name:'下牙列'},{id:'left',name:'左侧'},{id:'right',name:'右侧'}],
    extRuleFields:[{key:'recallAheadDays',label:'复查提前提醒天数（0为到期提醒，最长30天）'},{key:'reminderHour',label:'护理/复查提醒起始时间（北京时间，0–23点）'},{key:'visitDayHours',label:'较早就诊提醒窗口（小时）'},{key:'visitSoonHours',label:'临近就诊提醒窗口（小时）'},{key:'cancelHours',label:'患者取消截止（提前小时，0表示不限制）'},{key:'rescheduleHours',label:'患者改期截止（提前小时，0表示不限制）'},{key:'confirmationMinutes',label:'待确认超时释放（分钟，0表示关闭）'},{key:'checkInBeforeMinutes',label:'可提前签到（分钟）'},{key:'checkInAfterMinutes',label:'可延后签到（分钟）'},{key:'waitingMinutes',label:'每位候诊估算时间（分钟）'}],
    extStageStatuses:[{id:'planned',name:'计划中'},{id:'active',name:'进行中'},{id:'completed',name:'已完成'},{id:'paused',name:'暂停'}],
    extToothStatuses:[{id:'observed',name:'检查记录'},{id:'treated',name:'已治疗'},{id:'missing',name:'缺牙记录'},{id:'monitoring',name:'观察中'}],extSurfaces:[{id:'whole',name:'整牙'},{id:'mesial',name:'近中面'},{id:'distal',name:'远中面'},{id:'buccal',name:'颊面'},{id:'lingual',name:'舌面'},{id:'occlusal',name:'咬合面'}],selectedDoctor:null,doctorArticles:[],
    careWorkflows: require('../../lib/care-workflows').workflows, todayTasks: [], todayCompleted: 0, todayTotal: 0, todayRate: '—', todayLoading: false, todayError: '',
    careContactNote: '', careContactKey: '',
    dentition:'adult',toothRows:[],selectedTooth:'',toothTreatments:[],toothPhotos:[],compareSelected:[],photoComparison:null,compareZoom:1,
    recordPhotoAngles:['未标注','正面','左侧','右侧','上颌咬合','下颌咬合','局部'],recordPhotoAngleIndex:0,recordPhotoTooth:'',recordPhotoDate:'',
    featureLoading:false,featureBusy:false,featureError:'',featureMemberId:'',featureVisit:null,attachments:[],attachmentKinds:['检查单','影像','其他'],attachmentKindIndex:0,attachmentTooth:'',
    healthVersions:[],healthEditor:null,healthConsent:false,healthMayEdit:false,healthDirty:false,
    healthQuestionFields:[{key:'chiefComplaint',label:'本次关注的问题'},{key:'allergies',label:'已知过敏（药物、材料等）'},{key:'medications',label:'正在使用的药物'},{key:'conditions',label:'已知疾病与既往健康情况'},{key:'previousReactions',label:'以往治疗或麻醉后异常反应'}],
    tobaccoOptions:[{value:'none',label:'从不吸烟'},{value:'current',label:'目前吸烟'},{value:'former',label:'已戒烟'},{value:'unknown',label:'不清楚 / 不便回答'}],
    guardianRelationships:['父亲','母亲','其他监护人'],guardianState:null,guardianItems:[],guardianPage:0,guardianHasMore:false,guardianReview:null,guardianEditor:{name:'',relationship:'母亲',phone:'',birthDate:''},guardianNote:'',guardianIdentityChecked:false,guardianRelationshipChecked:false,
    privacyItems:[],privacyEditor:null,privacyReview:null,privacyNote:'',privacyConfirmed:false,privacyPage:0,privacyHasMore:false,
    accessLogItems:[],accessLogPage:0,accessLogHasMore:false,accessLogAction:'',
    patientRecord: null, patientRecordLoading: false, patientRecordError: '', recordAlbum: [], recordAlbumVisit: null,
    recordPhotoBusy: false, recordPhotoCaption: '', recordPhotoCategoryIndex: 0, recordPhotoCategories: ['检查','治疗前','治疗后','影像','其他'], requestCorrection: null,
    carePlans: [], planVisible: [], planSelected: null, planEditor: null, planCandidates: [],
    planLoading: false, planBusy: false, planError: '', planFilter: 'all',
    requestItems: [], requestPage: 0, requestHasMore: false, requestLoading: false, requestBusy: false,
    requestError: '', requestFilter: '', requestEditor: null, requestReview: null, requestNote: '', requestConfirmed: false,
    tab: 'patient', page: 'home', step: 1,
    notificationItems: [], notificationPage: 0, notificationTotal: 0, notificationUnread: 0, notificationHasMore: false,
    notificationLoading: false, notificationBusy: false, notificationError: '', notificationSettings: null, notificationFilter: '',
    homeArticles: [], homeArticlesLoading: false, homeArticlesError: '', articleItems: [], articleCategories: [], articleQuery: '', articleCategory: '', articleTotal: 0,
    articlePage: 0, articleHasMore: false, articleLoading: false, articleError: '', selectedArticle: null, articleEditor: null, articleSaving: false, categoryEditor: null,
    articleCategoryIndex: 0, articleServiceIndex: 0, articleServiceChoices: [],
    articlePopulationChoices: require('../../lib/article-populations'), articlePopulation: '', articleDoctor: '', articleService: '',
    articleSymptomChoices: require('../../lib/article-symptoms'), articleSymptom: '', articleSymptomName: '', articleEditorSymptoms: [],
    clinicInfo: null, doctorProfiles: [], serviceProfiles: [], catalogReady: false, catalogPublicError: '',
    catalogAdmin: null, catalogEditor: null, catalogKind: '', catalogFields: [], catalogServiceChoices: [], catalogLoading: false, catalogSaving: false, catalogError: '',
    services, doctors, dates: [], slots: [],
    booking: { service: '', doctor: doctors[0], date: '', slot: '', name: '', phone: '', note: '' },
    consent: false, appointments: [], tasks: [], pendingCount: 0, arrivedCount: 0,
    storageMode: '未连接', roleLabel: '患者', busy: false, profile: null,
    authReady: false, claimCode: '', claimName: '', inviteRole: 'frontdesk', inviteDoctor: '',
    issuedInvite: null, staffMembers: [], bookingDateIndex: 0, availabilityLoading: false,
    scheduleDoctors: [], scheduleDateIndex: 0, scheduleDoctor: '',
    scheduleStart: '09:00', scheduleEnd: '12:00', scheduleCapacity: 1, scheduleEnabled: true,
    scheduleVersion: null, scheduleSlots: [], scheduleLoading: false, scheduleSaving: false,
    batchSource: null, batchDoctor: '', batchMode: 'open', batchDates: [], batchSelectedCount: 0,
    batchPreview: null, batchPreviewing: false, batchSaving: false, batchError: '', batchResult: null,
    carePendingCount: 0, careEditor: {}, selectedCare: null, careBusy: false,
    historyRecords: [], completedCount: 0, selectedHistory: null, historyLoading: false, historyError: '',
    recordName: '', recordFrom: '', recordTo: '', recordDoctorIndex: 0, recordDoctors: ['全部医生', ...[]],
    recordItems: [], recordTotal: 0, recordPage: 0, recordHasMore: false, recordLoading: false, recordError: '', recordDirty: false, historyFromSearch: false,
    confirmationNote: '', confirmationSaving: false, confirmationError: '',
    rescheduleEditor: null, rescheduleDates: [], rescheduleDateIndex: 0, rescheduleSlot: '', rescheduleReason: '',
    rescheduleSlots: [], rescheduleLoading: false, rescheduleAvailabilityLoading: false, rescheduleSaving: false, rescheduleError: '', rescheduleSlotError: '',
    summaryEditor: null, summarySaving: false,
    recalls: [], recallPendingCount: 0, recallEditor: null, recallSaving: false, bookingRecall: null,
    workItems: [], visibleWorkItems: [], workCounts: { all: 0, appointment: 0, care: 0, recall: 0, attention: 0 },
    workLoading: false, workError: '', workFilter: 'all', workSearch: '', workUpdatedAt: '', workBusy: false,
    workStatus: 'actionable', workDoctorIndex: 0, workDoctors: ['全部医生', ...[]],
    workFrom: '', workTo: '', workDateError: '', workToday: '', workStatusCounts: {}, workGroupCounts: {},
    followupEditor: null, followupSaving: false, followupStartDate: '',
    templates: [], careTemplateChoices: [], templateLoading: false, templateError: '', templateSaving: false,
    templateEditor: null, templateServices: ['通用', ...services], templateServiceIndex: 0,
    members: [], memberChoices: [{ id: '', label: '请选择就诊成员' }], memberFilter: 'all',
    memberEditor: null, memberSaving: false, memberRelations: ['本人', '子女', '父母', '配偶', '其他家人'], memberRelationIndex: 0,
    bookingMemberId: '', bookingMemberIndex: 0, patientAppointments: [], patientTasks: [], patientRecalls: [],
    memberAssignment: null, assignmentMemberIndex: 0, assignmentBusy: false,
    shareMember: null, shareList: [], shareInvites: [], shareIssued: null, shareBusy: false, shareLoading: false, shareError: '',
    shareCode: '', shareName: '', sharePreview: null,
    statistics: null, statisticsLoading: false, statisticsError: '', statisticsPreset: '7',
    statisticsFrom: '', statisticsTo: '', statisticsDoctorIndex: 0, statisticsDoctors: ['全部医生', ...[]],
    careFeedback: { pain: '无疼痛', bleeding: false, swelling: false, note: '' },
    carePhotos: [], photosLoading: false, photoBusy: false, photosError: '',
    painOptions: ['无疼痛', '轻微不适', '明显疼痛'], careResolutionNote: '',
    careToday: new Date(Date.now() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10)
  },
  onShareAppMessage() {
    const row=this.data.page==='article-detail'&&this.data.selectedArticle
    if(row)api.featureRequest('POST',`/v1/articles/${encodeURIComponent(row.id)}/activity`,{kind:'share',source:'wechat-share'}).catch(()=>{})
    return {title:row?row.title:'ApexDental 口腔健康',path:row?`/pages/index/index?article=${encodeURIComponent(row.id)}`:'/pages/index/index'}
  },
  onLoad(options = {}) {
    this.pendingSharedArticle=options.article||''
    this.pendingNotification = !!options.notification
    const dates = appointmentRules.bookableDates()
    this.setData({ dates, 'booking.date': dates[0].key })
    this.refreshDerived()
    this.checkConnection(false)
  },
  onShow() {
    if(this.data.authReady && this.data.page==='record-attachments') this.loadAttachments()
    if(this.data.authReady && this.data.page==='health-questionnaire' && !this.data.featureBusy && !this.data.healthDirty) this.loadQuestionnaire()
    if(this.data.authReady && this.data.page==='guardian-check' && !this.data.featureBusy) this.loadGuardianCheck()
    if(this.data.authReady && this.data.page==='guardian-admin' && !this.data.featureBusy && !this.data.guardianReview) this.loadGuardianAdmin()
    if(this.data.authReady && this.data.page==='privacy-requests' && !this.data.featureBusy && !this.data.privacyReview && !this.data.privacyEditor) this.loadPrivacyRequests()
    if(this.data.authReady && this.data.page==='record-logs') this.loadRecordLogs()
    if (this.data.authReady && this.data.page === 'patient-record') this.loadPatientRecord()
    if (this.data.authReady && this.data.page === 'record-album') this.loadRecordAlbum()
    if (this.data.authReady && this.data.page === 'record-requests') this.loadRecordRequests()
    if (this.data.authReady && ['notifications', 'notification-admin'].includes(this.data.page)) this.loadNotifications()
    if (this.data.authReady) this.loadCatalog().catch(error => this.showError(error)).then(() => this.refreshRemote())
  },
  onUnload() {
    this.clearExtensions()
    this.clearRecordRequests()
    this.clearCarePlans()
    this.clearNotifications()
    this.clearArticles()
    this.clearCatalogEditor()
    this.clearReschedule()
    this.recordRequestId = (this.recordRequestId || 0) + 1
    this.statisticsRequestId = (this.statisticsRequestId || 0) + 1
    this.clearCarePhotoCache()
  },
  clearCarePhotoCache() {
    this.clearPatientRecord()
    this.photoRequestId = (this.photoRequestId || 0) + 1
    for (const path of this.photoCachePaths || []) wx.getFileSystemManager().unlink({ filePath: path,fail: () => {} })
    this.photoCachePaths = []
    this.setData({ carePhotos: [],photosError: '',photosLoading: false })
  },
  checkConnection(notify = true) {
    api.health().then(result => {
      if (!['local-demo','clinic'].includes(result.mode)) throw new Error('连接到未知服务')
      this.setData({ storageMode: result.mode==='local-demo'?'本机演示服务':'诊所服务',isDemo:result.mode==='local-demo' })
      return this.login()
    }).then(() => {
      if (notify) wx.showToast({ title: '已连接诊所服务' })
    }).catch(error => { if (notify) this.showError(error) })
  },
  login() {
    const existing = wx.getStorageSync(TOKEN_KEY)
    if (existing) {
      api.setToken(existing)
      return api.me().then(result => this.loggedIn(result.profile))
        .catch(() => { api.setToken(''); wx.removeStorageSync(TOKEN_KEY); return this.newLogin() })
    }
    return this.newLogin()
  },
  newLogin() {
    return new Promise(resolve => wx.login({ success: result => resolve(result.code || ''), fail: () => resolve('') }))
      .then(code => code ? api.loginWechat(code).catch(() => this.demoLogin()) : this.demoLogin())
      .then(result => {
        api.setToken(result.token)
        wx.setStorageSync(TOKEN_KEY, result.token)
        return this.loggedIn(result.profile)
      })
  },
  demoLogin() {
    let deviceId = wx.getStorageSync(DEVICE_KEY)
    if (!deviceId) {
      deviceId = `demo-${Date.now()}-${Math.random().toString(36).slice(2)}`
      wx.setStorageSync(DEVICE_KEY, deviceId)
    }
    return api.loginDemo(deviceId)
  },
  loggedIn(profile) {
    this.remoteRefreshId = (this.remoteRefreshId || 0) + 1
    if (['extensions','doctor-profile','patient-record','record-album','record-attachments','health-questionnaire','guardian-check','guardian-admin','privacy-requests','record-logs'].includes(this.data.page)) this.setData({ page: 'home' })
    this.clearExtensions()
    this.clearRecordRequests()
    this.clearCarePlans()
    if (this.data.page === 'record-requests') this.setData({ page: 'home' })
    this.clearNotifications()
    if (['notifications', 'notification-admin'].includes(this.data.page)) this.setData({ page: 'home' })
    this.clearArticles()
    if (this.data.page.indexOf('article') === 0) this.setData({ page: 'home' })
    this.clearCatalogEditor()
    this.setData({ clinicInfo: null, doctorProfiles: [], serviceProfiles: [], services: [], catalogReady: false })
    this.clearWorkFilters()
    this.clearReschedule()
    this.clearRecordSearch()
    this.statisticsRequestId = (this.statisticsRequestId || 0) + 1
    this.clearCarePhotoCache()
    this.historyRequestId = (this.historyRequestId || 0) + 1
    this.workRequestId = (this.workRequestId || 0) + 1
    this.templateRequestId = (this.templateRequestId || 0) + 1
    this.batchRequestId = (this.batchRequestId || 0) + 1
    const labels = { patient: '患者', frontdesk: '前台', doctor: '医生', admin: '管理员' }
    this.setData({ profile, roleLabel: labels[profile.role] || '患者', authReady: true,
      todayTasks: [], todayCompleted: 0, todayTotal: 0, todayRate: '—', todayLoading: false, todayError: '', careBusy: false, careContactNote: '', careContactKey: '', careContactOutcome: '',
      statistics: null, statisticsLoading: false, statisticsError: '',
      ...(['history', 'reschedule', 'catalog-admin', 'catalog-edit', 'directory'].includes(this.data.page) ? { page: 'home' } : {}),
      selectedHistory: null, historyError: '', historyLoading: false, summaryEditor: null, recallEditor: null, selectedCare: null,
      recalls: [], recallPendingCount: 0, bookingRecall: null,
      workItems: [], visibleWorkItems: [], workCounts: { all: 0, appointment: 0, care: 0, recall: 0, attention: 0 }, followupEditor: null,
      workFilter: 'all', workSearch: '', workError: '', workUpdatedAt: '', workLoading: false,
      templates: [], careTemplateChoices: [], templateEditor: null, templateError: '', templateLoading: false,
      members: [], memberChoices: [{ id: '', label: '请选择就诊成员' }], memberFilter: 'all', bookingMemberId: '', memberEditor: null, memberAssignment: null,
      shareMember: null,shareList: [],shareInvites: [],shareIssued: null,shareCode: '',shareName: '',sharePreview: null,
      batchSource: null,batchPreview: null,batchResult: null,batchPreviewing: false,batchError: '',
      ...(['care-plans', 'history-detail', 'summary-edit', 'recall-edit', 'recall-followup', 'care-edit', 'care-review', 'care-detail', 'care-templates', 'template-edit', 'members', 'member-edit', 'member-assign', 'member-shares', 'share-accept', 'schedule-batch'].includes(this.data.page) ? { page: 'home' } : {}),
      ...(!profile.isStaff ? { tab: 'patient', page: 'home', appointments: [], tasks: [], historyRecords: [], staffMembers: [], issuedInvite: null } : {}) })
    if (profile.role === 'admin') this.loadStaff()
    return this.loadCatalog().catch(error => this.showError(error)).then(() => this.refreshRemote()).then(() => {
      if(this.pendingSharedArticle){const id=this.pendingSharedArticle;this.pendingSharedArticle='';this.setData({tab:'patient'});return this.openArticle({currentTarget:{dataset:{id}}})}
      if (this.pendingNotification) { this.pendingNotification = false; this.setData({ tab: 'patient' }); this.refreshRemote(); return this.showNotifications() }
    })
  },
  refreshRemote() {
    if (!this.data.authReady) return Promise.resolve()
    const tab = this.data.tab, refreshId = (this.remoteRefreshId || 0) + 1
    const originalMemberFilter = this.data.memberFilter
    this.remoteRefreshId = refreshId
    const isClinic = this.data.tab === 'clinic' && this.data.profile && this.data.profile.isStaff
    if (!isClinic) this.loadHomeArticles()
    if (this.data.page === 'articles' || this.data.page === 'articles-admin') this.loadArticles()
    if (this.data.page === 'article-detail') this.loadArticleDetail()
    if (isClinic) this.loadWorklist()
    if (isClinic && this.data.page === 'statistics') this.loadStatistics()
    if (this.data.page === 'history' && !this.data.recordDirty) this.loadRecordSearch()
    if (!isClinic && this.data.page === 'today-tasks') this.setData({ todayLoading: true, todayError: '' })
    const mayFollowUp = isClinic && ['admin', 'doctor'].includes(this.data.profile.role)
    return Promise.all([api.appointments(isClinic ? 'clinic' : 'mine'), mayFollowUp || !isClinic ? api.tasks(isClinic ? 'clinic' : 'mine') : Promise.resolve({ tasks: [] }),
      mayFollowUp || !isClinic ? api.recalls(isClinic ? 'clinic' : 'mine') : Promise.resolve({ recalls: [] }),
      !isClinic ? api.members() : Promise.resolve({ members: [] })]).then(([appointmentData, taskData, recallData, memberData]) => {
      if (this.remoteRefreshId !== refreshId || this.data.tab !== tab) return
      const tasks = taskData.tasks.map(careView)
      const recalls = recallData.recalls.map(recallView)
      const members = memberData.members.map(member => ({ ...member, label: `${member.name} · ${member.relationship}${member.enabled ? '' : '（已停用）'}` }))
      const memberChoices = [{ id: '', label: '请选择就诊成员' }, ...members.filter(member => member.enabled && member.mayManage)]
      this.setData({ appointments: appointmentData.appointments, tasks, recalls, members, memberChoices,
        memberFilter: ['all', 'unassigned'].includes(this.data.memberFilter) || members.some(member => member.id === this.data.memberFilter) ? this.data.memberFilter : 'all',
        recallPendingCount: recalls.filter(plan => plan.status === 'pending').length,
        carePendingCount: tasks.filter(task => task.status !== 'resolved').length })
      if (!isClinic && this.data.bookingMemberId) {
        const index = memberChoices.findIndex(member => member.id === this.data.bookingMemberId)
        if (index < 0) this.setBookingMember('')
        else this.setData({ bookingMemberIndex: index, ...(!this.data.bookingRecall ? { 'booking.name': memberChoices[index].name } : {}) })
      }
      this.refreshDerived()
      if (this.data.page === 'today-tasks') this.setData({ todayLoading: false })
      if (this.data.page === 'history' && !this.data.recordDirty && this.data.memberFilter !== originalMemberFilter) this.loadRecordSearch()
      if (this.data.page === 'history-detail' && this.data.selectedHistory) this.loadHistory(this.data.selectedHistory.appointment.id)
      if (this.data.page === 'care-detail' && this.data.selectedCare && !this.data.photoBusy && !this.data.careBusy) {
        const task = tasks.find(task => task.id === this.data.selectedCare.id)
        if (task) { this.setData({ selectedCare: task }); this.loadCarePhotos() }
        else { this.clearCarePhotoCache(); this.setData({ selectedCare: null,page: 'care' }) }
      }
      return true
    }).catch(error => {
      if (this.remoteRefreshId !== refreshId || this.data.tab !== tab) return false
      if (this.data.page === 'today-tasks') this.setData({ todayLoading: false, todayError: error.message, todayTasks: [], todayTotal: 0, todayCompleted: 0, todayRate: '—' })
      this.showError(error); return false
    })
  },
  showError(error) { wx.showToast({ title: error.message || '操作失败', icon: 'none' }) },
  showStatistics() {
    if (!(this.data.profile && this.data.profile.isStaff)) return
    this.setData({ page: 'statistics', statisticsDoctorIndex: 0 })
    this.statisticsPresetChange({ currentTarget: { dataset: { days: '7' } } })
  },
  statisticsPresetChange(e) {
    const days = Number(e.currentTarget.dataset.days)
    if (![1, 7, 30].includes(days)) return
    const now = new Date(Date.now() + 8 * 3600000), to = now.toISOString().slice(0, 10)
    const from = new Date(Date.parse(`${to}T00:00:00Z`) - (days - 1) * 86400000).toISOString().slice(0, 10)
    this.setData({ statisticsPreset: String(days), statisticsFrom: from, statisticsTo: to })
    this.loadStatistics()
  },
  statisticsDateChange(e) {
    const field = e.currentTarget.dataset.field
    if (!['statisticsFrom', 'statisticsTo'].includes(field)) return
    this.setData({ [field]: e.detail.value, statisticsPreset: 'custom' })
    this.loadStatistics()
  },
  statisticsDoctorChange(e) {
    this.setData({ statisticsDoctorIndex: Number(e.detail.value) })
    this.loadStatistics()
  },
  loadStatistics() {
    const profile = this.data.profile
    if (!profile || !profile.isStaff || this.data.tab !== 'clinic' || this.data.page !== 'statistics') return
    const requestId = (this.statisticsRequestId || 0) + 1
    this.statisticsRequestId = requestId
    const from = this.data.statisticsFrom, to = this.data.statisticsTo
    const doctor = profile.role === 'doctor' ? profile.doctorName : this.data.statisticsDoctorIndex ? this.data.statisticsDoctors[this.data.statisticsDoctorIndex] : ''
    this.setData({ statistics: null, statisticsLoading: true, statisticsError: '' })
    const current = () => this.statisticsRequestId === requestId && this.data.tab === 'clinic' && this.data.page === 'statistics' && this.data.profile === profile
    return api.statistics(from, to, doctor).then(result => {
      if (!current()) return
      const statistics = result.statistics
      const bars = rows => {
        const max = Math.max(1, ...rows.map(row => row.count))
        return rows.map(row => ({ ...row, width: Math.round(row.count / max * 100) }))
      }
      const max = Math.max(1, ...statistics.trend.map(row => Math.max(row.planned, row.arrived, row.completed)))
      this.setData({ statistics: { ...statistics, updatedAt: historyTime(statistics.generatedAt),
        services: bars(statistics.services), doctors: bars(statistics.doctors),
        trend: statistics.trend.map(row => ({ ...row, label: row.date.slice(5), plannedWidth: Math.round(row.planned / max * 100),
          arrivedWidth: Math.round(row.arrived / max * 100), completedWidth: Math.round(row.completed / max * 100) })) } })
    }).catch(error => { if (current()) this.setData({ statisticsError: error.message || '统计加载失败' }) })
      .finally(() => { if (current()) this.setData({ statisticsLoading: false }) })
  },
  refreshDerived() {
    this.setData({ careToday: new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10) })
    const { appointments } = this.data
    let booking = this.data.booking
    const doctors = ['不限医生', ...this.data.doctorProfiles.filter(row => !row.serviceNames.length || row.serviceNames.includes(booking.service)).map(row => row.name)]
    if (!this.data.bookingRecall && !doctors.includes(booking.doctor)) {
      this.setData({ 'booking.doctor': '不限医生', 'booking.slot': '' })
      booking = this.data.booking
    }
    this.setData({ doctors })
    const filter = this.data.memberFilter, match = item => filter === 'all' || (filter === 'unassigned' ? !item.memberId : item.memberId === filter)
    const records = this.data.tab === 'patient' ? appointments.filter(match) : appointments
    const tasks = this.data.tasks.filter(match), recalls = this.data.recalls.filter(match)
    this.setData({
      pendingCount: appointments.filter(item => item.status === '待确认').length,
      arrivedCount: appointments.filter(item => ['已到店', '已完成'].includes(item.status)).length,
      completedCount: records.filter(item => item.status === '已完成').length,
      todayTasks: this.data.tab === 'patient' ? [
        ...tasks.filter(task => task.status === 'published' && task.dueDate <= this.data.careToday).map(task => ({ id: task.id, kind: 'care', title: task.title, patient: task.patient, date: task.dueDate, label: task.dueDate < this.data.careToday ? '逾期补交反馈' : '今日反馈', mayManage: task.mayManage })),
        ...records.filter(row => ['待确认', '已预约', '取消申请中', '已到店'].includes(row.status) && row.date === this.data.careToday).map(row => ({ id: row.id, kind: 'visit', title: row.service + ' · ' + row.slot, patient: row.patient, date: row.date, label: row.status, mayManage: row.mayManage })),
        ...recalls.filter(row => row.status === 'pending' && row.dueDate <= this.data.careToday).map(row => ({ id: row.appointmentId, kind: 'recall', title: row.service + '复查预约', patient: row.patient, date: row.dueDate, label: row.overdue ? '复查已逾期' : '今日建议复查', mayManage: row.mayManage }))
      ] : [],
      todayCompleted: tasks.filter(task => task.dueDate === this.data.careToday && task.status === 'resolved').length,
      todayTotal: tasks.filter(task => task.dueDate === this.data.careToday).length,
      todayRate: tasks.some(task => task.dueDate === this.data.careToday) ? (tasks.filter(task => task.dueDate === this.data.careToday && task.status === 'resolved').length / tasks.filter(task => task.dueDate === this.data.careToday).length * 100).toFixed(1) + '%' : '—',
      patientAppointments: records, patientTasks: tasks, patientRecalls: recalls,
      ...(this.data.tab === 'patient' ? { carePendingCount: tasks.filter(task => task.status !== 'resolved').length, recallPendingCount: recalls.filter(plan => plan.status === 'pending').length } : {}),
      historyRecords: records.slice().sort((a, b) => `${b.date} ${b.slot}`.localeCompare(`${a.date} ${a.slot}`))
    })
    if (this.data.storageMode === '本机服务' && booking.date) {
      const date = booking.date, doctor = booking.doctor, service = booking.service
      this.setData({ slots: [], availabilityLoading: true })
      api.availability(date, doctor, service).then(result => {
        if (this.data.booking.date !== date || this.data.booking.doctor !== doctor || this.data.booking.service !== service) return
        const selected = result.slots.find(slot => slot.time === this.data.booking.slot && !slot.disabled)
        this.setData({ slots: result.slots, availabilityLoading: false, 'booking.slot': selected ? selected.time : '' })
      }).catch(error => {
        if (this.data.booking.date === date && this.data.booking.doctor === doctor && this.data.booking.service === service) this.setData({ availabilityLoading: false, slots: [], 'booking.slot': '' })
        this.showError(error)
      })
    }
  },
  setTab(e) {
    this.clearExtensions()
    this.clearRecordRequests()
    this.clearCarePlans()
    this.clearNotifications()
    this.clearArticles()
    this.clearCatalogEditor()
    this.clearWorkFilters()
    this.clearReschedule()
    this.clearRecordSearch()
    this.statisticsRequestId = (this.statisticsRequestId || 0) + 1
    this.setData({ statistics: null, statisticsError: '', statisticsLoading: false })
    const tab = e.currentTarget.dataset.tab
    if (tab === 'clinic' && !(this.data.profile && this.data.profile.isStaff)) return wx.showToast({ title: '请先完成员工授权', icon: 'none' })
    this.clearCarePhotoCache()
    this.historyRequestId = (this.historyRequestId || 0) + 1
    this.workRequestId = (this.workRequestId || 0) + 1
    this.templateRequestId = (this.templateRequestId || 0) + 1
    this.batchRequestId = (this.batchRequestId || 0) + 1
    this.setData({ batchSource: null,batchPreview: null,batchResult: null,batchError: '',batchPreviewing: false })
    this.setData({ templates: [], careTemplateChoices: [], templateEditor: null, templateError: '', templateLoading: false })
    this.setData({ members: [], memberChoices: [{ id: '', label: '请选择就诊成员' }], memberFilter: 'all', memberEditor: null, memberAssignment: null, patientAppointments: [], patientTasks: [], patientRecalls: [], bookingMemberId: '' })
    this.setData({ shareMember: null,shareList: [],shareInvites: [],shareIssued: null,shareCode: '',shareName: '',sharePreview: null })
    this.setData({ workItems: [], visibleWorkItems: [], workCounts: { all: 0, appointment: 0, care: 0, recall: 0, attention: 0 }, workFilter: 'all', workSearch: '', workError: '', workLoading: false, workUpdatedAt: '', followupEditor: null })
    this.setData({ todayTasks: [], todayCompleted: 0, todayTotal: 0, todayRate: '—', todayLoading: false, todayError: '', careBusy: false, careContactNote: '', careContactKey: '', careContactOutcome: '', tab, page: 'home', issuedInvite: null, appointments: [], tasks: [], historyRecords: [], completedCount: 0, carePendingCount: 0, selectedCare: null, selectedHistory: null, historyError: '', summaryEditor: null, recalls: [], recallPendingCount: 0, recallEditor: null, bookingRecall: null })
    if (this.data.storageMode === '本机服务') this.refreshRemote()
    if (tab === 'clinic' && this.data.profile.role === 'admin') this.loadStaff()
  },
  showClaim() { this.setData({ page: 'staff-claim', claimCode: '', claimName: '' }) },
  claimInput(e) { this.setData({ claimCode: e.detail.value }) },
  claimNameInput(e) { this.setData({ claimName: e.detail.value }) },
  claimStaff() {
    if (!this.data.authReady) return this.showError(new Error('请先连接本机服务'))
    api.claimStaff(this.data.claimCode, this.data.claimName).then(result => {
      const labels = { frontdesk: '前台', doctor: '医生', admin: '管理员' }
      this.setData({ profile: result.profile, roleLabel: labels[result.profile.role], tab: 'clinic', page: 'home', claimCode: '', claimName: '' })
      this.refreshRemote()
      if (result.profile.role === 'admin') this.loadStaff()
      wx.showToast({ title: '员工身份已开通' })
    }).catch(error => this.showError(error))
  },
  selectInviteRole(e) { this.setData({ inviteRole: e.currentTarget.dataset.role }) },
  selectInviteDoctor(e) { this.setData({ inviteDoctor: e.currentTarget.dataset.doctor }) },
  createInvite() {
    api.createInvite(this.data.inviteRole, this.data.inviteDoctor).then(result => {
      this.setData({ issuedInvite: result })
    }).catch(error => this.showError(error))
  },
  loadStaff() {
    api.staff().then(result => this.setData({ staffMembers: result.staff }))
      .catch(error => this.showError(error))
  },
  disableStaff(e) {
    const id = e.currentTarget.dataset.id
    wx.showModal({ title: '停用员工身份', content: '停用后该员工立即无法访问诊所工作台。',
      success: result => {
        if (!result.confirm) return
        api.disableStaff(id).then(() => { this.loadStaff(); wx.showToast({ title: '已停用' }) })
          .catch(error => this.showError(error))
      }
    })
  },
  openSchedules() {
    if (!this.data.profile || this.data.profile.role !== 'admin') return
    if (!this.data.scheduleDoctor) return this.showError(new Error('请先新增或启用医生资料'))
    this.setData({ page: 'schedules', issuedInvite: null, dates: appointmentRules.bookableDates(), scheduleDateIndex: 0 })
    this.loadSchedule()
  },
  loadSchedule() {
    const doctor = this.data.scheduleDoctor, date = this.data.dates[this.data.scheduleDateIndex].key
    this.setData({ scheduleLoading: true, scheduleVersion: null, scheduleSlots: [] })
    api.schedule(date, doctor).then(result => {
      if (this.data.scheduleDoctor !== doctor || this.data.dates[this.data.scheduleDateIndex].key !== date) return
      const slots = result.schedule.slots
      let end = '12:00'
      if (slots.length) {
        const [h, m] = slots[slots.length - 1].slot.split(':').map(Number)
        const total = h * 60 + m + 30
        end = `${String(Math.floor(total / 60)).padStart(2, '0')}:${String(total % 60).padStart(2, '0')}`
      }
      this.setData({ scheduleVersion: result.schedule.version, scheduleSlots: slots, scheduleLoading: false,
        scheduleStart: slots.length ? slots[0].slot : '09:00', scheduleEnd: end,
        scheduleCapacity: slots.length ? slots[0].capacity : 1, scheduleEnabled: slots.length ? !!slots[0].enabled : true })
    }).catch(error => {
      if (this.data.scheduleDoctor === doctor && this.data.dates[this.data.scheduleDateIndex].key === date) this.setData({ scheduleLoading: false })
      this.showError(error)
    })
  },
  scheduleDoctorChange(e) {
    if (this.data.scheduleSaving) return
    this.setData({ scheduleDoctor: e.currentTarget.dataset.doctor })
    this.loadSchedule()
  },
  scheduleDateChange(e) {
    if (this.data.scheduleSaving) return
    this.setData({ scheduleDateIndex: Number(e.detail.value) })
    this.loadSchedule()
  },
  scheduleTimeChange(e) { this.setData({ [e.currentTarget.dataset.field]: e.detail.value }) },
  scheduleCapacityChange(e) { this.setData({ scheduleCapacity: Number(e.detail.value) }) },
  scheduleEnabledChange(e) { this.setData({ scheduleEnabled: e.detail.value }) },
  saveSchedule() {
    if (this.data.scheduleSaving || this.data.scheduleLoading || this.data.scheduleVersion === null) return
    const data = this.data
    const body = { doctor: data.scheduleDoctor, date: data.dates[data.scheduleDateIndex].key,
      start: data.scheduleStart, end: data.scheduleEnd, capacity: data.scheduleCapacity,
      enabled: data.scheduleEnabled, version: data.scheduleVersion }
    this.setData({ scheduleSaving: true })
    api.saveSchedule(body).then(result => {
      this.setData({ scheduleSlots: result.schedule.slots, scheduleVersion: result.schedule.version })
      this.refreshDerived()
      wx.showToast({ title: '排班已保存' })
    }).catch(error => this.showError(error)).finally(() => this.setData({ scheduleSaving: false }))
  },
  openScheduleBatch() {
    if (!this.data.profile || this.data.profile.role !== 'admin' || this.data.scheduleLoading || this.data.scheduleSaving || this.data.scheduleVersion === null || !this.data.scheduleSlots.length || this.data.batchSaving) return
    const source = { doctor: this.data.scheduleDoctor,date: this.data.dates[this.data.scheduleDateIndex].key,
      version: this.data.scheduleVersion,slots: this.data.scheduleSlots.map(slot => ({ ...slot })) }
    this.batchRequestId = (this.batchRequestId || 0) + 1
    const dates = appointmentRules.bookableDates().map(date => ({ ...date,selected: false,disabled: date.key === source.date }))
    this.setData({ page: 'schedule-batch',batchSource: source,batchDoctor: source.doctor,batchMode: 'open',batchDates: dates,
      batchSelectedCount: 0,batchPreview: null,batchError: '',batchResult: null,batchPreviewing: false })
  },
  invalidateBatchPreview() {
    this.batchRequestId = (this.batchRequestId || 0) + 1
    this.setData({ batchPreview: null,batchError: '',batchResult: null })
  },
  batchDoctorChange(e) {
    if (this.data.batchSaving || this.data.batchPreviewing) return
    const doctor = e.currentTarget.dataset.doctor
    const dates = this.data.batchDates.map(date => {
      const disabled = doctor === this.data.batchSource.doctor && date.key === this.data.batchSource.date
      return { ...date,disabled,selected: disabled ? false : date.selected }
    })
    this.invalidateBatchPreview()
    this.setData({ batchDoctor: doctor,batchDates: dates,batchSelectedCount: dates.filter(date => date.selected).length })
  },
  batchModeChange(e) {
    if (this.data.batchSaving || this.data.batchPreviewing) return
    this.invalidateBatchPreview(); this.setData({ batchMode: e.currentTarget.dataset.mode })
  },
  batchDateToggle(e) {
    if (this.data.batchSaving || this.data.batchPreviewing) return
    const key = e.currentTarget.dataset.date
    const dates = this.data.batchDates.map(date => date.key === key && !date.disabled ? { ...date,selected: !date.selected } : date)
    this.invalidateBatchPreview()
    this.setData({ batchDates: dates,batchSelectedCount: dates.filter(date => date.selected).length })
  },
  batchQuickSelect(e) {
    if (this.data.batchSaving || this.data.batchPreviewing) return
    const mode = e.currentTarget.dataset.mode, weekday = new Date(`${this.data.batchSource.date}T00:00:00Z`).getUTCDay()
    const dates = this.data.batchDates.map((date,index) => ({ ...date,selected: !date.disabled &&
      (mode === 'all' || mode === 'week' && index < 7 || mode === 'weekday' && new Date(`${date.key}T00:00:00Z`).getUTCDay() === weekday) }))
    this.invalidateBatchPreview()
    this.setData({ batchDates: dates,batchSelectedCount: dates.filter(date => date.selected).length })
  },
  previewScheduleBatch() {
    if (this.data.batchSaving || this.data.batchPreviewing || !this.data.batchSource || !this.data.batchSelectedCount) return
    const source = this.data.batchSource, requestId = (this.batchRequestId || 0) + 1, userId = this.data.profile.id
    this.batchRequestId = requestId
    this.setData({ batchPreviewing: true,batchError: '',batchPreview: null,batchResult: null })
    api.previewScheduleBatch({ sourceDoctor: source.doctor,sourceDate: source.date,sourceVersion: source.version,mode: this.data.batchMode,
      targets: this.data.batchDates.filter(date => date.selected).map(date => ({ doctor: this.data.batchDoctor,date: date.key })) }).then(result => {
      if (this.batchRequestId !== requestId || this.data.tab !== 'clinic' || this.data.page !== 'schedule-batch' || this.data.profile.id !== userId) return
      this.setData({ batchPreview: { ...result.preview,expiresLabel: historyTime(result.preview.expiresAt),
        remaining: result.preview.targets.reduce((total,target) => total + target.remaining,0) } })
    }).catch(error => {
      if (this.batchRequestId === requestId && this.data.page === 'schedule-batch' && this.data.tab === 'clinic') this.setData({ batchError: error.message })
    }).finally(() => { if (this.batchRequestId === requestId) this.setData({ batchPreviewing: false }) })
  },
  commitScheduleBatch() {
    const preview = this.data.batchPreview
    if (this.data.batchSaving || this.data.batchPreviewing || !preview || !preview.canCommit) return
    const userId = this.data.profile.id
    wx.showModal({ title: '确认批量配置排班',content: `${this.data.batchDoctor} · ${preview.targets.length} 个日期\n${preview.mode === 'open' ? '复制并开放全部来源时段' : '复制并保留来源开放状态'}。已有目标排班将被替换，预约记录保留。`,success: result => {
      if (!result.confirm || this.data.batchSaving || this.data.tab !== 'clinic' || this.data.page !== 'schedule-batch' || !this.data.batchPreview || this.data.batchPreview.id !== preview.id) return
      this.setData({ batchSaving: true,batchError: '' })
      api.commitScheduleBatch(preview.id).then(result => {
        if (this.data.tab !== 'clinic' || this.data.page !== 'schedule-batch' || this.data.profile.id !== userId) return
        this.setData({ batchResult: result.result,batchPreview: null })
        wx.showToast({ title: '批量排班已保存' })
      }).catch(error => {
        if (this.data.page === 'schedule-batch' && this.data.tab === 'clinic') this.setData({ batchError: error.message })
      }).finally(() => this.setData({ batchSaving: false }))
    } })
  },
  returnToSchedules() {
    if (this.data.batchSaving) return
    this.batchRequestId = (this.batchRequestId || 0) + 1
    const currentDate = this.data.dates[this.data.scheduleDateIndex].key, dates = appointmentRules.bookableDates()
    const index = dates.findIndex(date => date.key === currentDate)
    this.setData({ page: 'schedules',dates,scheduleDateIndex: index >= 0 ? index : 0,batchPreview: null,batchSource: null,batchPreviewing: false,batchError: '' })
    this.loadSchedule()
  },
  bookingDateChange(e) {
    const index = Number(e.detail.value)
    this.setData({ bookingDateIndex: index, 'booking.date': this.data.dates[index].key, 'booking.slot': '' })
    this.refreshDerived()
  },
  startBooking(e) {
    if (!this.data.catalogReady || !this.data.services.length) return this.showError(new Error('暂无可预约项目，请查看诊所资料或重新连接'))
    const bookingSource=this.data.page==='article-detail'?'科普':this.data.page==='doctor-profile'?'医生主页':this.data.page==='directory'?'项目资料':this.data.page==='extensions'&&this.data.extSection==='screening'?'初筛复核':'首页'
    const originArticle=bookingSource==='科普'?this.data.selectedArticle?.id||'':''
    const service = e.currentTarget.dataset.service || this.data.services[0]
    if (!this.data.services.includes(service)) return this.showError(new Error('该项目已停用，请重新选择'))
    this.requestKey = null
    this.setData({ page: 'booking', step: 1, 'booking.source':bookingSource,'booking.originArticle':originArticle, 'booking.service': service, 'booking.doctor': '不限医生', 'booking.slot': '', consent: false, bookingRecall: null })
    const member = this.data.members.find(member => member.id === this.data.memberFilter && member.enabled && member.mayManage)
      || this.data.members.find(member => member.relationship === '本人' && member.enabled && member.mayManage)
    this.setBookingMember(member ? member.id : '')
    this.refreshDerived()
  },
  goHome() { if (this.data.articleSaving) return; this.setData({ page: 'home', step: 1 }); if (this.data.tab === 'patient') this.loadHomeArticles() },
  showAppointments() { this.setData({ page: 'appointments' }) },
  memberFilterChange(e) {
    this.setData({ memberFilter: e.currentTarget.dataset.id }); this.refreshDerived()
    if (this.data.page === 'care-plans') this.filterCarePlanList()
    if (this.data.page === 'history') this.loadRecordSearch()
  },
  showMembers() {
    this.memberReturnPage = this.data.page === 'booking' ? 'booking' : 'home'
    this.setData({ page: 'members',shareIssued: null }); this.refreshRemote()
  },
  returnFromMembers() { this.setData({ page: this.memberReturnPage === 'booking' ? 'booking' : 'home' }) },
  editMember(e) {
    if (this.data.memberSaving) return
    const id = e.currentTarget.dataset.id, member = this.data.members.find(member => member.id === id)
    if (id && (!member || !member.mayManage)) return
    this.memberRequestKey = `member-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const relationship = member ? member.relationship : this.data.members.some(row => row.relationship === '本人' && row.enabled && row.mayManage) ? '其他家人' : '本人'
    this.setData({ page: 'member-edit', memberEditor: member ? { ...member } : { id: '', name: '', phone: '',birthDate:'', relationship, enabled: true, version: 0 }, memberRelationIndex: this.data.memberRelations.indexOf(relationship) })
  },
  memberInput(e) { if (!this.data.memberSaving) this.setData({ [`memberEditor.${e.currentTarget.dataset.field}`]: e.detail.value }) },
  memberRelationChange(e) {
    const index = Number(e.detail.value)
    if (!this.data.memberSaving) this.setData({ memberRelationIndex: index, 'memberEditor.relationship': this.data.memberRelations[index] })
  },
  cancelMemberEdit() { this.setData({ page: 'members', memberEditor: null }) },
  saveMember() {
    if (this.data.memberSaving || !this.data.memberEditor || this.data.tab !== 'patient') return
    const editor = { ...this.data.memberEditor }, userId = this.data.profile.id
    this.setData({ memberSaving: true })
    api.saveMember(editor.id, { name: editor.name, phone: editor.phone,birthDate:editor.birthDate || '', relationship: editor.relationship, enabled: editor.enabled, version: editor.version, requestKey: this.memberRequestKey }).then(result => {
      if (this.data.tab !== 'patient' || this.data.profile.id !== userId || this.data.page !== 'member-edit' || !this.data.memberEditor || this.data.memberEditor.id !== editor.id) return
      this.setData({ page: 'members', memberEditor: null })
      return this.refreshRemote().then(refreshed => {
        if (refreshed && this.memberReturnPage === 'booking' && result.member.enabled) this.setBookingMember(result.member.id)
        wx.showToast({ title: '成员资料已保存' })
      })
    }).catch(error => this.showError(error)).finally(() => this.setData({ memberSaving: false }))
  },
  viewMemberRecords(e) { return this.openPatientRecord(e) },
  setBookingMember(id) {
    const member = this.data.members.find(member => member.id === id && member.enabled && member.mayManage)
    const index = member ? this.data.memberChoices.findIndex(choice => choice.id === id) : 0
    this.requestKey = null
    this.setData({ bookingMemberId: member ? member.id : '', bookingMemberIndex: index >= 0 ? index : 0, consent: false,
      'booking.name': member ? member.name : '', 'booking.phone': member ? member.phone : '' })
  },
  bookingMemberChange(e) {
    if (this.data.bookingRecall || this.data.busy) return
    const member = this.data.memberChoices[Number(e.detail.value)]
    this.setBookingMember(member ? member.id : '')
  },
  openMemberShares(e) {
    const member = this.data.members.find(member => member.id === e.currentTarget.dataset.id)
    if (!member || !member.mayManage) return
    this.setData({ page: 'member-shares',shareMember: member,shareIssued: null,shareList: [],shareInvites: [],shareError: '' })
    this.loadMemberShares()
  },
  loadMemberShares() {
    if (!this.data.shareMember || this.data.tab !== 'patient') return Promise.resolve()
    const id = this.data.shareMember.id, userId = this.data.profile.id
    this.setData({ shareLoading: true,shareError: '' })
    return api.memberShares(id).then(result => {
      if (this.data.tab !== 'patient' || this.data.page !== 'member-shares' || this.data.profile.id !== userId || !this.data.shareMember || this.data.shareMember.id !== id) return
      this.setData({ shareList: result.shares,shareInvites: result.invites.map(invite => ({ ...invite,expiresLabel: historyTime(invite.expiresAt) })) })
    }).catch(error => { if (this.data.page === 'member-shares') this.setData({ shareError: error.message }) })
      .finally(() => this.setData({ shareLoading: false }))
  },
  issueMemberShare() {
    if (this.data.shareBusy || !this.data.shareMember) return
    const id = this.data.shareMember.id, userId = this.data.profile.id
    this.setData({ shareBusy: true })
    api.inviteMemberShare(id).then(result => {
      if (this.data.tab !== 'patient' || this.data.page !== 'member-shares' || this.data.profile.id !== userId || !this.data.shareMember || this.data.shareMember.id !== id) return
      this.setData({ shareIssued: { ...result.invite,expiresLabel: historyTime(result.invite.expiresAt) } }); this.loadMemberShares()
    }).catch(error => this.showError(error)).finally(() => this.setData({ shareBusy: false }))
  },
  copyMemberShareCode() {
    if (this.data.shareIssued) wx.setClipboardData({ data: this.data.shareIssued.code })
  },
  revokeMemberShare(e) {
    if (this.data.shareBusy) return
    const { id,invite } = e.currentTarget.dataset, isInvite = invite === true || invite === 'true'
    wx.showModal({ title: isInvite ? '撤销邀请' : '撤销成员授权',content: isInvite ? '该授权码将无法被接受。' : '该账号将不能继续查看此成员的记录。已查看或自行保存的内容无法收回。',success: result => {
      if (!result.confirm || this.data.shareBusy || this.data.page !== 'member-shares') return
      this.setData({ shareBusy: true })
      api.revokeMemberShare(id,isInvite).then(() => {
        if (this.data.shareIssued && this.data.shareIssued.id === id) this.setData({ shareIssued: null })
        this.loadMemberShares(); wx.showToast({ title: '授权已撤销' })
      }).catch(error => { this.showError(error); this.loadMemberShares() }).finally(() => this.setData({ shareBusy: false }))
    } })
  },
  showAcceptMemberShare() { this.setData({ page: 'share-accept',shareCode: '',shareName: '',sharePreview: null }) },
  shareCodeInput(e) { this.setData({ shareCode: e.detail.value,sharePreview: null }) },
  shareNameInput(e) { this.setData({ shareName: e.detail.value }) },
  previewMemberShare() {
    if (this.data.shareBusy) return
    const code = this.data.shareCode, userId = this.data.profile.id
    this.setData({ shareBusy: true,sharePreview: null })
    api.previewMemberShare(code).then(result => {
      if (this.data.tab === 'patient' && this.data.page === 'share-accept' && this.data.shareCode === code && this.data.profile.id === userId) this.setData({ sharePreview: { ...result.preview,code } })
    }).catch(error => this.showError(error)).finally(() => this.setData({ shareBusy: false }))
  },
  acceptMemberShare() {
    if (this.data.shareBusy || !this.data.sharePreview || this.data.sharePreview.code !== this.data.shareCode) return
    const userId = this.data.profile.id, code = this.data.shareCode
    this.setData({ shareBusy: true })
    api.acceptMemberShare(code,this.data.shareName).then(result => {
      if (this.data.tab !== 'patient' || this.data.page !== 'share-accept' || this.data.profile.id !== userId) return
      this.clearCarePhotoCache()
      this.setData({ page: 'history',memberFilter: result.memberId,sharePreview: null,shareCode: '' })
      this.refreshRemote(); wx.showToast({ title: '已接受只读授权' })
    }).catch(error => this.showError(error)).finally(() => this.setData({ shareBusy: false }))
  },
  openMemberAssignment() {
    const history = this.data.selectedHistory
    if (this.data.tab !== 'patient' || !history || history.appointment.memberId) return
    this.setData({ page: 'member-assign', assignmentMemberIndex: 0, memberAssignment: { appointmentId: history.appointment.id, patient: history.appointment.patient } })
  },
  assignmentMemberChange(e) { if (!this.data.assignmentBusy) this.setData({ assignmentMemberIndex: Number(e.detail.value) }) },
  returnFromAssignment() {
    const id = this.data.memberAssignment && this.data.memberAssignment.appointmentId
    this.setData({ page: 'history-detail', memberAssignment: null }); if (id) this.loadHistory(id)
  },
  assignMember() {
    if (this.data.assignmentBusy || !this.data.memberAssignment) return
    const member = this.data.memberChoices[this.data.assignmentMemberIndex], appointmentId = this.data.memberAssignment.appointmentId, userId = this.data.profile.id
    if (!member || !member.id) return this.showError(new Error('请选择归属成员'))
    wx.showModal({ title: '确认记录归属', content: `将“${this.data.memberAssignment.patient}”的本次就诊及关联复查记录归入“${member.label}”。确认后不能重新分配，请核对就诊人。`, success: result => {
      if (!result.confirm || this.data.assignmentBusy || this.data.tab !== 'patient' || this.data.page !== 'member-assign' || !this.data.memberAssignment || this.data.memberAssignment.appointmentId !== appointmentId) return
      this.setData({ assignmentBusy: true })
      api.assignMember(appointmentId,member.id).then(() => {
        if (this.data.tab !== 'patient' || this.data.page !== 'member-assign' || this.data.profile.id !== userId || !this.data.memberAssignment || this.data.memberAssignment.appointmentId !== appointmentId) return
        this.setData({ memberFilter: member.id }); this.returnFromAssignment(); this.refreshRemote()
        wx.showToast({ title: '记录已归属' })
      }).catch(error => this.showError(error)).finally(() => this.setData({ assignmentBusy: false }))
    } })
  },
  showWorklist(e) {
    if (this.data.tab !== 'clinic' || !this.data.profile || !this.data.profile.isStaff) return
    const status = e && e.currentTarget && e.currentTarget.dataset.status
    if (['overdue', 'waiting_feedback', 'waiting_review'].includes(status)) {
      this.clearWorkFilters(); this.setData({ workStatus: status })
    }
    this.setData({ page: 'worklist' }); this.loadWorklist()
  },
  loadWorklist() {
    if (this.data.tab !== 'clinic' || !this.data.profile || !this.data.profile.isStaff) return Promise.resolve(false)
    const userId = this.data.profile.id, requestId = (this.workRequestId || 0) + 1
    this.workRequestId = requestId
    this.setData({ workLoading: true, workError: '' })
    return api.worklist().then(result => {
      if (this.workRequestId !== requestId || this.data.tab !== 'clinic' || this.data.profile.id !== userId) return false
      this.setData({ workItems: result.worklist.items, workCounts: result.worklist.counts, workToday: result.worklist.date, workUpdatedAt: historyTime(result.worklist.generatedAt) })
      this.filterWorklist(); return true
    }).catch(error => {
      if (this.workRequestId !== requestId || this.data.tab !== 'clinic' || this.data.profile.id !== userId) return false
      this.setData({ workItems: [], visibleWorkItems: [], workCounts: { all: 0, appointment: 0, care: 0, recall: 0, attention: 0 }, workError: error.message || '待办加载失败' })
      this.filterWorklist()
      return false
    }).finally(() => { if (this.workRequestId === requestId) this.setData({ workLoading: false }) })
  },
  filterWorklist() {
    const query = this.data.workSearch.trim().toLowerCase(), filter = this.data.workFilter
    const { workFrom: from, workTo: to, workStatus: status } = this.data
    const doctor = this.data.workDoctorIndex ? this.data.workDoctors[this.data.workDoctorIndex] : ''
    const error = from && to && from > to ? '开始日期不能晚于结束日期，请调整或重置筛选。' : ''
    const base = error ? [] : this.data.workItems.filter(item => (!doctor || item.doctor === doctor) &&
      (!from || item.filterDate >= from) && (!to || item.filterDate <= to) &&
      (!query || `${item.patient} ${item.doctor} ${item.title} ${item.description}`.toLowerCase().includes(query)))
    const inGroup = item => filter === 'all' || filter === 'attention' && item.priority === 0 || item.group === filter
    const inStatus = (item, value) => value === 'all' || value === 'actionable' && item.actionable || value === 'overdue' && item.overdue ||
      value === 'waiting_feedback' && item.group === 'care' && item.state === 'published' ||
      value === 'photos' && item.hasPhotos && item.state==='waiting_review' ||
      value === 'waiting_review' && item.group === 'care' && item.state === 'waiting_review' ||
      value === 'draft' && item.group === 'care' && item.state === 'draft' ||
      value === 'lost' && item.followupState === 'lost' || value === 'recall_pending' && item.group === 'recall' || value === 'deferred' && item.deferred ||
      value === 'today' && item.filterDate === this.data.workToday
    const statusCounts = {}
    for (const value of ['all', 'actionable', 'overdue', 'waiting_feedback', 'waiting_review', 'draft', 'recall_pending', 'deferred', 'today', 'lost', 'photos']) {
      statusCounts[value] = base.filter(item => inGroup(item) && inStatus(item, value)).length
    }
    const stage = base.filter(item => inStatus(item, status)), groups = { all: stage.length, appointment: 0, care: 0, recall: 0, attention: 0 }
    for (const item of stage) { groups[item.group]++; if (item.priority === 0) groups.attention++ }
    this.setData({ visibleWorkItems: stage.filter(inGroup), workStatusCounts: statusCounts, workGroupCounts: groups, workDateError: error })
  },
  clearWorkFilters() {
    this.setData({ workFilter: 'all', workSearch: '', workStatus: 'actionable', workDoctorIndex: 0,
      workFrom: '', workTo: '', workDateError: '', workStatusCounts: {}, workGroupCounts: {} })
  },
  resetWorkFilters() { this.clearWorkFilters(); this.filterWorklist() },
  workStatusChange(e) { this.setData({ workStatus: e.currentTarget.dataset.status }); this.filterWorklist() },
  workDoctorChange(e) { this.setData({ workDoctorIndex: Number(e.detail.value) }); this.filterWorklist() },
  workDateChange(e) {
    const field = e.currentTarget.dataset.field
    if (!['workFrom', 'workTo'].includes(field)) return
    this.setData({ [field]: e.detail.value }); this.filterWorklist()
  },
  workFilterChange(e) { this.setData({ workFilter: e.currentTarget.dataset.filter }); this.filterWorklist() },
  workSearchInput(e) { this.setData({ workSearch: e.detail.value }); this.filterWorklist() },
  callWorkPatient(e) {
    const item = this.data.workItems.find(row => row.id === e.currentTarget.dataset.itemid)
    if (this.data.tab !== 'clinic' || !item || !/^1\d{10}$/.test(item.phone || '')) return
    wx.makePhoneCall({ phoneNumber: item.phone })
  },
  workStatusAction(e) {
    if (this.data.workBusy) return
    const { itemid, status } = e.currentTarget.dataset
    const item = this.data.workItems.find(row => row.id === itemid)
    if (!item || !item.actions.some(action => action.status === status)) return
    if (item.appointmentStatus === '待确认' && status === '已预约') return this.openReschedule({ currentTarget: { dataset: { id: item.appointmentId } } })
    const apply = () => {
      this.setData({ workBusy: true })
      api.changeStatus(item.appointmentId, status, item.version).then(() => { wx.showToast({ title: '已处理' }); return this.refreshRemote() })
        .catch(error => { this.showError(error); this.loadWorklist() }).finally(() => this.setData({ workBusy: false }))
    }
    if (status === '已取消' || status === '已完成') return wx.showModal({ title: status === '已完成' ? '完成接诊' : '取消预约',
      content: `${item.patient} · ${item.doctor}\n${item.description}\n确认${status === '已完成' ? '已完成本次接诊' : '取消此预约并释放号源'}？`, success: result => { if (result.confirm && !this.data.workBusy) apply() } })
    apply()
  },
  openWorkItem(e) {
    const item = this.data.workItems.find(row => row.id === e.currentTarget.dataset.itemid)
    if (!item || this.data.workBusy) return
    if (item.group === 'appointment' && ['admin', 'frontdesk'].includes(this.data.profile.role) && item.action === 'status') return this.openReschedule({ currentTarget: { dataset: { id: item.appointmentId } } })
    if (item.action === 'history' || item.action === 'status') return this.openHistory({ currentTarget: { dataset: { id: item.appointmentId } } })
    if (item.action === 'recall-followup') {
      const tomorrow = new Date(Date.now() + 8 * 3600000 + 86400000).toISOString().slice(0, 10)
      this.followupRequestKey = `followup-${Date.now()}-${Math.random().toString(36).slice(2)}`
      this.setData({ page: 'recall-followup', followupStartDate: tomorrow, followupEditor: {
        appointmentId: item.appointmentId, version: item.recallVersion, patient: item.patient, doctor: item.doctor,
        note: '', outcome: 'reached', nextContactDate: tomorrow, previous: item.followup } })
      return
    }
    this.refreshRemote().then(refreshed => {
      if (!refreshed || this.data.tab !== 'clinic' || this.data.page !== 'worklist') return
      const task = this.data.tasks.find(task => task.id === item.taskId)
      if (!task || task.status === 'resolved') return this.showError(new Error('事项已更新，请重新查看待办'))
      if (task.status === 'draft') this.openCareEditor({ currentTarget: { dataset: { taskid: task.id } } })
      else this.openCareReview({ currentTarget: { dataset: { id: task.id } } })
    })
  },
  followupInput(e) { if (!this.data.followupSaving) this.setData({ [`followupEditor.${e.currentTarget.dataset.field}`]: e.detail.value }) },
  saveRecallFollowup() {
    if (this.data.followupSaving || !this.data.followupEditor || this.data.tab !== 'clinic') return
    const editor = { ...this.data.followupEditor }, userId = this.data.profile.id
    this.setData({ followupSaving: true })
    api.followupRecall(editor.appointmentId, { version: editor.version, note: editor.note, outcome: editor.outcome, nextContactDate: editor.nextContactDate, requestKey: this.followupRequestKey }).then(() => {
      if (this.data.tab !== 'clinic' || this.data.profile.id !== userId || this.data.page !== 'recall-followup' || !this.data.followupEditor || this.data.followupEditor.appointmentId !== editor.appointmentId) return
      this.setData({ page: 'worklist', followupEditor: null }); this.loadWorklist()
      wx.showToast({ title: '跟进已记录' })
    }).catch(error => this.showError(error)).finally(() => this.setData({ followupSaving: false }))
  },
  clearRecordSearch() {
    this.recordRequestId = (this.recordRequestId || 0) + 1
    this.setData({ recordName: '', recordFrom: '', recordTo: '', recordDoctorIndex: 0,
      recordItems: [], recordTotal: 0, recordPage: 0, recordHasMore: false, recordLoading: false, recordError: '', recordDirty: false, historyFromSearch: false })
  },
  showHistory() {
    if (this.data.tab === 'clinic' && (!this.data.profile || !['admin', 'doctor'].includes(this.data.profile.role))) return
    this.setData({ page: 'history', selectedHistory: null, historyError: '', historyFromSearch: false })
    if (this.data.tab === 'patient') this.refreshRemote()
    else this.loadRecordSearch()
  },
  recordFilterChange(e) {
    const field = e.currentTarget.dataset.field
    if (!['recordName', 'recordFrom', 'recordTo', 'recordDoctorIndex'].includes(field)) return
    this.recordRequestId = (this.recordRequestId || 0) + 1
    this.setData({ [field]: field === 'recordDoctorIndex' ? Number(e.detail.value) : e.detail.value,
      recordItems: [], recordTotal: 0, recordHasMore: false, recordPage: 0, recordDirty: true, recordLoading: false, recordError: '' })
  },
  resetRecordFilters() { this.clearRecordSearch(); this.loadRecordSearch() },
  searchRecords() { this.loadRecordSearch() },
  moreRecords() { if (this.data.recordHasMore && !this.data.recordLoading && !this.data.recordDirty) this.loadRecordSearch(true) },
  loadRecordSearch(append = false) {
    const profile = this.data.profile, tab = this.data.tab
    if (!profile || !this.data.authReady || this.data.page !== 'history') return
    if (tab === 'clinic' && !['admin', 'doctor'].includes(profile.role)) return
    if (append && this.data.recordLoading) return
    const page = append ? this.data.recordPage + 1 : 1, requestId = (this.recordRequestId || 0) + 1
    this.recordRequestId = requestId
    const filters = { scope: tab === 'clinic' ? 'clinic' : 'mine', name: this.data.recordName.trim(),
      from: this.data.recordFrom, to: this.data.recordTo, page,
      doctor: tab === 'clinic' && profile.role === 'doctor' ? profile.doctorName : this.data.recordDoctorIndex ? this.data.recordDoctors[this.data.recordDoctorIndex] : '',
      member: tab === 'patient' ? this.data.memberFilter : 'all' }
    this.setData({ recordLoading: true, recordError: '', recordDirty: false,
      ...(!append ? { recordItems: [], recordTotal: 0, recordPage: 0, recordHasMore: false } : {}) })
    const current = () => this.recordRequestId === requestId && this.data.profile === profile && this.data.tab === tab && this.data.page === 'history'
    return api.records(filters).then(result => {
      if (!current()) return
      const records = result.records, existing = append ? this.data.recordItems : []
      const ids = new Set(existing.map(item => item.id))
      this.setData({ recordItems: [...existing, ...records.items.filter(item => !ids.has(item.id))], recordTotal: records.total,
        recordPage: records.page, recordHasMore: records.hasMore })
    }).catch(error => { if (current()) this.setData({ recordError: error.message || '记录检索失败' }) })
      .finally(() => { if (current()) this.setData({ recordLoading: false }) })
  },
  returnFromHistory() {
    if (this.data.historyFromSearch || this.data.tab === 'patient') this.showHistory()
    else this.goHome()
  },
  openHistory(e) {
    if (!this.data.authReady) return this.showError(new Error('请先连接本机服务'))
    if (this.data.page !== 'history-detail') this.setData({ historyFromSearch: this.data.page === 'history' })
    this.setData({ page: 'history-detail', selectedHistory: null, historyError: '' })
    this.loadHistory(e.currentTarget.dataset.id)
  },
  loadHistory(id) {
    const tab = this.data.tab, requestId = (this.historyRequestId || 0) + 1
    this.historyRequestId = requestId
    this.historyAppointmentId = id
    this.setData({ historyLoading: true, historyError: '' })
    api.history(id, tab === 'clinic' ? 'clinic' : 'mine').then(result => {
      if (this.historyRequestId !== requestId || this.data.tab !== tab || this.data.page !== 'history-detail') return
      this.setData({ selectedHistory: { ...result.history, recall: result.history.recall ? recallView(result.history.recall) : null, entries: result.history.entries.map(entry => ({ ...entry, timeLabel: historyTime(entry.at) })) } })
    }).catch(error => {
      if (this.historyRequestId !== requestId || this.data.tab !== tab || this.data.page !== 'history-detail') return
      this.setData({ selectedHistory: null, historyError: error.message || '档案加载失败' })
    }).finally(() => {
      if (this.historyRequestId === requestId && this.data.tab === tab) this.setData({ historyLoading: false })
    })
  },
  retryHistory() { if (this.historyAppointmentId) this.loadHistory(this.historyAppointmentId) },
  editVisitSummary() {
    const history = this.data.selectedHistory
    if (this.data.tab !== 'clinic' || !this.data.profile || !['doctor', 'admin'].includes(this.data.profile.role) || !history || history.appointment.status !== '已完成') return
    const summary = history.summary
    this.setData({ page: 'summary-edit', summaryEditor: {
      appointmentId: history.appointment.id, patient: history.appointment.patient, doctor: history.appointment.doctor,
      version: summary ? summary.version : 0, findings: summary ? summary.findings : '',
      treatment: summary ? summary.treatment : '', nextSteps: summary ? summary.nextSteps : '',
      diagnosis: summary?.structured?.diagnosis || '', teeth: (summary?.structured?.teeth || []).join(' '), procedure: summary?.structured?.procedure || '', materials: summary?.structured?.materials || ''
    } })
  },
  summaryInput(e) {
    if (!this.data.summarySaving) this.setData({ [`summaryEditor.${e.currentTarget.dataset.field}`]: e.detail.value })
  },
  returnToVisit() {
    const id = this.data.recallEditor ? this.data.recallEditor.appointmentId : this.data.summaryEditor ? this.data.summaryEditor.appointmentId : this.historyAppointmentId
    this.setData({ page: 'history-detail', summaryEditor: null, recallEditor: null })
    if (id) this.loadHistory(id)
  },
  saveVisitSummary() {
    if (this.data.summarySaving || !this.data.summaryEditor || this.data.tab !== 'clinic') return
    const editor = { ...this.data.summaryEditor }, userId = this.data.profile.id
    if (![editor.findings, editor.treatment, editor.nextSteps].every(value => typeof value === 'string' && value.trim())) return this.showError(new Error('请填写检查结果、处置说明和后续安排'))
    this.setData({ summarySaving: true })
    api.saveVisitSummary(editor.appointmentId, { version: editor.version, findings: editor.findings, treatment: editor.treatment, nextSteps: editor.nextSteps,
      structured: { diagnosis: editor.diagnosis,teeth: editor.teeth.trim() ? editor.teeth.trim().split(/[\s,，、]+/) : [],procedure: editor.procedure,materials: editor.materials } }).then(() => {
      if (this.data.tab !== 'clinic' || this.data.profile.id !== userId || this.data.page !== 'summary-edit' || !this.data.summaryEditor || this.data.summaryEditor.appointmentId !== editor.appointmentId) return
      this.setData({ page: 'history-detail', summaryEditor: null })
      this.loadHistory(editor.appointmentId)
      wx.showToast({ title: '小结已保存' })
    }).catch(error => this.showError(error)).finally(() => this.setData({ summarySaving: false }))
  },
  historyCareAction(e) {
    const { taskid } = e.currentTarget.dataset
    const tab = this.data.tab
    this.refreshRemote().then(refreshed => {
      if (!refreshed) return
      if (this.data.tab !== tab || this.data.page !== 'history-detail') return
      const task = this.data.tasks.find(item => item.id === taskid)
      if (!task) return this.showError(new Error('任务已更新，请返回后重试'))
      if (this.data.tab === 'patient') this.openCareFeedback({ currentTarget: { dataset: { id: taskid } } })
      else if (task.status === 'draft') this.openCareEditor({ currentTarget: { dataset: { taskid } } })
      else this.openCareReview({ currentTarget: { dataset: { id: taskid } } })
    })
  },
  showRecalls() { this.setData({ page: 'recalls' }); this.refreshRemote() },
  editRecall() {
    const history = this.data.selectedHistory
    if (this.data.tab !== 'clinic' || !history || !history.summary || history.appointment.status !== '已完成') return
    const plan = history.recall
    if (plan && plan.status !== 'pending') return this.showError(new Error('请先处理现有复查预约'))
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    this.setData({ page: 'recall-edit', careToday: today, recallEditor: { appointmentId: history.appointment.id,
      patient: history.appointment.patient, doctor: history.appointment.doctor, version: plan ? plan.version : 0,
      dueDate: plan && plan.dueDate >= today ? plan.dueDate : today,
      instructions: plan ? plan.instructions : history.summary.nextSteps } })
  },
  recallInput(e) { if (!this.data.recallSaving) this.setData({ [`recallEditor.${e.currentTarget.dataset.field}`]: e.detail.value }) },
  saveRecall() {
    if (this.data.recallSaving || !this.data.recallEditor) return
    const editor = { ...this.data.recallEditor }, userId = this.data.profile.id
    this.setData({ recallSaving: true })
    api.saveRecall(editor.appointmentId, { dueDate: editor.dueDate, instructions: editor.instructions, version: editor.version }).then(() => {
      if (this.data.tab !== 'clinic' || this.data.profile.id !== userId || this.data.page !== 'recall-edit' || !this.data.recallEditor || this.data.recallEditor.appointmentId !== editor.appointmentId) return
      this.setData({ page: 'history-detail', recallEditor: null })
      this.loadHistory(editor.appointmentId); this.refreshRemote()
      wx.showToast({ title: '复查安排已发送' })
    }).catch(error => this.showError(error)).finally(() => this.setData({ recallSaving: false }))
  },
  startRecallBooking(e) {
    if (this.data.tab !== 'patient' || !this.data.authReady) return
    const id = e.currentTarget.dataset.id
    const historyPlan = this.data.selectedHistory && this.data.selectedHistory.recall
    const plan = historyPlan && historyPlan.appointmentId === id ? historyPlan : this.data.recalls.find(item => (item.nodeId || item.appointmentId) === id)
    if (!plan || plan.appointmentId !== id || plan.status !== 'pending') return this.showError(new Error('请刷新复查安排后重试'))
    if (!plan.mayManage) return this.showError(new Error('该成员为只读授权，请联系档案管理人预约'))
    const member = this.data.members.find(member => member.id === plan.memberId && member.enabled)
    if (!member) {
      this.openHistory({ currentTarget: { dataset: { id } } })
      return this.showError(new Error(plan.memberId ? '请先在家庭成员页恢复该成员' : '请先将原就诊记录归属到家庭成员'))
    }
    const dates = appointmentRules.bookableDates(), index = dates.findIndex(date => date.key === plan.dueDate)
    this.requestKey = null
    this.setData({ page: 'booking', step: 1, dates, bookingDateIndex: index >= 0 ? index : 0, consent: false,
      bookingRecall: plan, booking: { service: plan.service, doctor: plan.doctor, date: dates[index >= 0 ? index : 0].key,
        slot: '', name: plan.patient, phone: member.phone, note: '' }, bookingMemberId: member.id,
        bookingMemberIndex: this.data.memberChoices.findIndex(choice => choice.id === member.id) })
    this.refreshDerived()
  },
  pick(e) {
    const { field, value } = e.currentTarget.dataset
    if (this.data.bookingRecall && ['service', 'doctor'].includes(field)) return
    const update = { [`booking.${field}`]: value }
    if (['date', 'doctor', 'service'].includes(field)) update['booking.slot'] = ''
    this.setData(update)
    if (['date', 'doctor', 'service'].includes(field)) this.refreshDerived()
  },
  pickSlot(e) {
    if (e.currentTarget.dataset.disabled === true || e.currentTarget.dataset.disabled === 'true') return
    this.setData({ 'booking.slot': e.currentTarget.dataset.value })
  },
  input(e) { this.setData({ [`booking.${e.currentTarget.dataset.field}`]: e.detail.value }) },
  consentChange(e) { this.setData({ consent: e.detail.value.length > 0 }) },
  next() {
    if (!this.data.booking.slot) return wx.showToast({ title: '请选择预约时段', icon: 'none' })
    this.setData({ step: 2 })
  },
  previous() { this.setData({ step: 1 }) },
  submit() {
    if (this.data.busy) return
    if (!this.data.consent) return wx.showToast({ title: '请先阅读并同意隐私告知', icon: 'none' })
    if (!this.data.authReady) return this.showError(new Error('请先连接并登录本机服务'))
    if (!this.data.bookingMemberId) return this.showError(new Error('请先选择就诊成员'))
    this.requestKey = this.requestKey || `${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.setData({ busy: true })
    api.createAppointment({ ...this.data.booking, requestKey: this.requestKey, memberId: this.data.bookingMemberId,
      ...(this.data.bookingRecall ? { recallId: this.data.bookingRecall.appointmentId, recallNodeId:this.data.bookingRecall.nodeId||'', recallVersion: this.data.bookingRecall.version } : {}) }).then(() => {
      this.setData({ step: 3 })
      this.requestKey = null
      return this.refreshRemote()
    }).catch(error => { this.showError(error); this.refreshDerived() })
      .finally(() => this.setData({ busy: false }))
  },
  clearReschedule() {
    this.rescheduleRequestId = (this.rescheduleRequestId || 0) + 1
    this.rescheduleSlotRequestId = (this.rescheduleSlotRequestId || 0) + 1
    this.rescheduleRequestKey = null
    this.setData({ confirmationNote: '', confirmationSaving: false, confirmationError: '', rescheduleEditor: null, rescheduleSlots: [], rescheduleSlot: '', rescheduleReason: '',
      rescheduleLoading: false, rescheduleAvailabilityLoading: false, rescheduleSaving: false, rescheduleError: '', rescheduleSlotError: '' })
  },
  openReschedule(e) {
    if (!this.data.authReady) return this.showError(new Error('请先连接本机服务'))
    if (this.data.tab === 'clinic' && !['admin', 'frontdesk'].includes(this.data.profile.role)) return
    this.rescheduleReturnPage = this.data.page
    this.rescheduleAppointmentId = e.currentTarget.dataset.id
    this.clearReschedule()
    this.setData({ page: 'reschedule' })
    this.reloadReschedule()
  },
  reloadReschedule() {
    if (this.data.confirmationSaving || this.data.rescheduleSaving || this.data.page !== 'reschedule' || !this.rescheduleAppointmentId) return
    const id = this.rescheduleAppointmentId, tab = this.data.tab, profile = this.data.profile
    const requestId = (this.rescheduleRequestId || 0) + 1
    this.rescheduleRequestId = requestId
    this.rescheduleSlotRequestId = (this.rescheduleSlotRequestId || 0) + 1
    this.rescheduleRequestKey = null
    this.setData({ confirmationNote: '', confirmationError: '', rescheduleEditor: null, rescheduleLoading: true, rescheduleError: '', rescheduleSlots: [], rescheduleSlot: '', rescheduleReason: '' })
    const current = () => this.rescheduleRequestId === requestId && this.data.tab === tab && this.data.profile === profile && this.data.page === 'reschedule'
    return api.reschedule(id, tab === 'clinic' ? 'clinic' : 'mine').then(result => {
      if (!current()) return
      const dates = appointmentRules.bookableDates(), appointment = result.appointment
      const index = Math.max(0, dates.findIndex(date => date.key === appointment.date))
      this.setData({ rescheduleEditor: { ...appointment, confirmations: (appointment.confirmations || []).map(record => ({ ...record, timeLabel: historyTime(record.createdAt) })), changes: appointment.changes.map(change => ({ ...change, timeLabel: historyTime(change.createdAt) })) },
        rescheduleDates: dates, rescheduleDateIndex: index })
      if (appointment.canChange) this.loadRescheduleSlots()
    }).catch(error => { if (current()) this.setData({ rescheduleError: error.message || '预约加载失败' }) })
      .finally(() => { if (current()) this.setData({ rescheduleLoading: false }) })
  },
  loadRescheduleSlots() {
    const editor = this.data.rescheduleEditor
    if (!editor || !editor.canChange || this.data.page !== 'reschedule') return
    const date = this.data.rescheduleDates[this.data.rescheduleDateIndex].key, profile = this.data.profile
    const requestId = (this.rescheduleSlotRequestId || 0) + 1
    this.rescheduleSlotRequestId = requestId
    this.setData({ rescheduleAvailabilityLoading: true, rescheduleSlots: [], rescheduleSlotError: '' })
    const current = () => this.rescheduleSlotRequestId === requestId && this.data.profile === profile && this.data.page === 'reschedule' && this.data.rescheduleEditor && this.data.rescheduleEditor.id === editor.id
    return api.availability(date, editor.doctor, editor.service).then(result => {
      if (!current()) return
      const slots = result.slots.map(slot => ({ ...slot, disabled: slot.disabled || date === editor.date && slot.time === editor.slot }))
      this.setData({ rescheduleSlots: slots })
    }).catch(error => { if (current()) this.setData({ rescheduleSlotError: error.message || '号源加载失败' }) })
      .finally(() => { if (current()) this.setData({ rescheduleAvailabilityLoading: false }) })
  },
  rescheduleDateChange(e) {
    if (this.data.rescheduleSaving || this.data.confirmationSaving) return
    this.rescheduleRequestKey = null
    this.setData({ rescheduleDateIndex: Number(e.detail.value), rescheduleSlot: '' }); this.loadRescheduleSlots()
  },
  rescheduleSelectSlot(e) {
    if (this.data.confirmationSaving || this.data.rescheduleSaving || this.data.rescheduleAvailabilityLoading) return
    const slot = this.data.rescheduleSlots.find(item => item.time === e.currentTarget.dataset.slot && !item.disabled)
    if (slot) { this.rescheduleRequestKey = null; this.setData({ rescheduleSlot: slot.time }) }
  },
  rescheduleReasonInput(e) {
    if (this.data.rescheduleSaving || this.data.confirmationSaving) return
    this.rescheduleRequestKey = null; this.setData({ rescheduleReason: e.detail.value })
  },
  submitReschedule(e) {
    const approvalRequest=!!e?.currentTarget?.dataset?.request
    const editor = this.data.rescheduleEditor, tab = this.data.tab, profile = this.data.profile
    if (!editor || !editor.canChange || this.data.confirmationSaving || this.data.rescheduleSaving || this.data.rescheduleAvailabilityLoading) return
    if (!this.data.rescheduleSlot || this.data.rescheduleReason.trim().length < 2) return this.showError(new Error('请选择新时段并填写至少 2 字的原因'))
    const date = this.data.rescheduleDates[this.data.rescheduleDateIndex].key
    if (!this.rescheduleRequestKey) this.rescheduleRequestKey = `reschedule-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const body = { scope: tab === 'clinic' ? 'clinic' : 'mine', date, slot: this.data.rescheduleSlot, reason: this.data.rescheduleReason.trim(), version: editor.version, requestKey: this.rescheduleRequestKey }
    const requestId = this.rescheduleRequestId
    this.setData({ rescheduleSaving: true, rescheduleError: '' })
    const current = () => this.rescheduleRequestId === requestId && this.data.page === 'reschedule' && this.data.tab === tab && this.data.profile === profile && this.data.rescheduleEditor && this.data.rescheduleEditor.id === editor.id
    return (approvalRequest?api.featureRequest('POST',`/v1/appointments/${encodeURIComponent(editor.id)}/reschedule-request`,body):api.saveReschedule(editor.id, body)).then(result => {
      if (!current()) return
      if(approvalRequest){this.rescheduleRequestKey=null;this.setData({rescheduleSlot:'',rescheduleReason:''});wx.showToast({title:'申请已提交',icon:'none'});return}
      this.setData({ rescheduleEditor: { ...result.appointment, confirmations: (result.appointment.confirmations || []).map(record => ({ ...record, timeLabel: historyTime(record.createdAt) })), changes: result.appointment.changes.map(change => ({ ...change, timeLabel: historyTime(change.createdAt) })) }, rescheduleSlot: '', rescheduleReason: '' })
      this.rescheduleRequestKey = null
      wx.showToast({ title: result.repeated ? '改期已记录' : '已改期，待确认', icon: 'none' })
      this.refreshRemote(); this.loadRescheduleSlots()
    }).catch(error => { if (current()) this.setData({ rescheduleError: error.message || '改期失败，请重试' }) })
      .finally(() => { if (current()) this.setData({ rescheduleSaving: false }) })
  },
  closeReschedule() {
    if (this.data.rescheduleSaving || this.data.confirmationSaving) return
    const page = this.rescheduleReturnPage, id = this.rescheduleAppointmentId
    this.clearReschedule()
    if (page === 'history-detail') { this.setData({ page }); this.loadHistory(id) }
    else if (page === 'history') this.showHistory()
    else { this.setData({ page: this.data.tab === 'patient' ? 'appointments' : 'home' }); this.refreshRemote() }
  },
  confirmationNoteInput(e) {
    if (!this.data.confirmationSaving) this.setData({ confirmationNote: e.detail.value, confirmationError: '' })
  },
  submitConfirmation() {
    const editor = this.data.rescheduleEditor, profile = this.data.profile, requestId = this.rescheduleRequestId
    if (this.data.tab !== 'clinic' || !profile || !['admin', 'frontdesk'].includes(profile.role) ||
      !editor || editor.status !== '待确认' || this.data.confirmationSaving || this.data.rescheduleSaving) return
    const note = this.data.confirmationNote.trim()
    if (!note || note.length > 500) return this.setData({ confirmationError: '请填写 1–500 字的沟通说明' })
    const current = () => this.rescheduleRequestId === requestId && this.data.profile === profile && this.data.tab === 'clinic' && this.data.page === 'reschedule'
    this.setData({ confirmationSaving: true, confirmationError: '' })
    return api.changeStatus(editor.id, '已预约', editor.version, note).then(() => {
      if (!current()) return
      this.setData({ confirmationSaving: false, confirmationNote: '' })
      wx.showToast({ title: '预约已确认' })
      this.reloadReschedule(); this.refreshRemote()
    }).catch(error => { if (current()) this.setData({ confirmationError: error.message || '保存失败，请重新加载核实后再试' }) })
      .finally(() => { if (current()) this.setData({ confirmationSaving: false }) })
  },
  updateStatus(e) {
    const { id, status } = e.currentTarget.dataset
    const item = this.data.appointments.find(row => row.id === id)
    const version = e.currentTarget.dataset.version === undefined ? item && item.version : e.currentTarget.dataset.version
    if (item && item.status === '待确认' && status === '已预约') return this.openReschedule({ currentTarget: { dataset: { id } } })
    api.changeStatus(id, status, version, undefined, e.currentTarget.dataset.cancellationReason, this.data.tab==='clinic'?'clinic':'mine')
      .then(() => this.refreshRemote()).catch(error => { this.showError(error); this.refreshRemote() })
  },
  cancelAppointment(e) {
    const item = this.data.appointments.find(a => a.id === e.currentTarget.dataset.id)
    if (!item || !item.mayManage) return
    const next = item.status === '待确认' ? '已取消' : '取消申请中'
    wx.showModal({
      title: item.status === '待确认' ? '取消预约申请' : '申请取消已确认的预约',
      editable: true, placeholderText: '填写取消原因（1–500字）', content: '',
      success: res => { if (res.confirm) this.updateStatus({ currentTarget: { dataset: { id: item.id, status: next, version: item.version, cancellationReason: res.content || '患者申请取消' } } }) }
    })
  },
  showCare() { this.setData({ page: 'care' }); this.refreshRemote() },
  openCareEditor(e) {
    if (!this.data.profile || !['admin', 'doctor'].includes(this.data.profile.role)) return
    const { taskid, appointmentid } = e.currentTarget.dataset
    const task = taskid ? this.data.tasks.find(t => t.id === taskid)
      : this.data.tasks.find(t => t.appointmentId === appointmentid && t.status === 'draft')
    const appointment = this.data.appointments.find(a => a.id === (task ? task.appointmentId : appointmentid))
    if (!appointment && !task) return this.showError(new Error('请刷新就诊记录后重试'))
    this.careRequestKey = null
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    this.setData({ page: 'care-edit', careToday: today, careTemplateChoices: [], templateError: '', careEditor: {
      taskId: task ? task.id : '', appointmentId: task ? task.appointmentId : appointment.id,
      patient: task ? task.patient : appointment.patient, doctor: task ? task.doctor : appointment.doctor,
      service: task ? task.service : appointment.service, templateId: '', templateVersion: null, templateName: '',
      title: task ? task.title : `${appointment.service}后护理`, instructions: task ? task.instructions : '',
      dueDate: task && task.dueDate >= today ? task.dueDate : today
    } })
    this.loadCareTemplates(false)
  },
  careEditorInput(e) { if (!this.data.careBusy) this.setData({ [`careEditor.${e.currentTarget.dataset.field}`]: e.detail.value }) },
  showCareTemplates() {
    if (this.data.tab !== 'clinic' || !this.data.profile || !['doctor', 'admin'].includes(this.data.profile.role)) return
    this.setData({ page: 'care-templates' }); this.loadCareTemplates(true)
  },
  loadCareTemplates(management) {
    if (this.data.tab !== 'clinic' || !this.data.profile || !['doctor', 'admin'].includes(this.data.profile.role)) return Promise.resolve(false)
    const requestId = (this.templateRequestId || 0) + 1, userId = this.data.profile.id
    this.templateRequestId = requestId
    const page = this.data.page, appointmentId = this.data.careEditor.appointmentId
    this.setData({ templateLoading: true, templateError: '' })
    return api.careTemplates(management).then(result => {
      if (this.templateRequestId !== requestId || this.data.tab !== 'clinic' || this.data.profile.id !== userId || this.data.page !== page) return false
      if (management) this.setData({ templates: result.templates })
      else if (this.data.careEditor.appointmentId === appointmentId) this.setData({ careTemplateChoices: result.templates.filter(template => template.service === '通用' || template.service === this.data.careEditor.service) })
      return true
    }).catch(error => {
      if (this.templateRequestId === requestId && this.data.tab === 'clinic' && this.data.page === page) this.setData({ templateError: error.message, ...(management ? { templates: [] } : { careTemplateChoices: [] }) })
      return false
    }).finally(() => { if (this.templateRequestId === requestId) this.setData({ templateLoading: false }) })
  },
  reloadCareTemplates() { this.loadCareTemplates(this.data.page === 'care-templates') },
  applyCareTemplate(e) {
    if (this.data.careBusy) return
    const template = this.data.careTemplateChoices.find(item => item.id === e.currentTarget.dataset.id)
    if (!template) return
    const appointmentId = this.data.careEditor.appointmentId
    const apply = () => {
      if (this.data.page !== 'care-edit' || this.data.careEditor.appointmentId !== appointmentId || this.data.careBusy) return
      const due = new Date(Date.now() + 8 * 3600000)
      due.setUTCDate(due.getUTCDate() + template.feedbackDays)
      this.setData({ 'careEditor.title': template.title, 'careEditor.instructions': template.instructions,
        'careEditor.dueDate': due.toISOString().slice(0, 10), 'careEditor.templateId': template.id,
        'careEditor.templateVersion': template.version, 'careEditor.templateName': template.name })
    }
    if (this.data.careEditor.instructions.trim()) return wx.showModal({ title: '使用护理模板', content: '将替换当前标题、护理说明和反馈日期，应用后仍可修改。', success: result => { if (result.confirm) apply() } })
    apply()
  },
  clearCareTemplate() { if (!this.data.careBusy) this.setData({ 'careEditor.templateId': '', 'careEditor.templateVersion': null, 'careEditor.templateName': '' }) },
  editCareTemplate(e) {
    if (this.data.templateSaving) return
    const id = e.currentTarget.dataset.id
    const existing = id ? this.data.templates.find(item => item.id === id) : null
    if (id && (!existing || !existing.mayEdit)) return
    this.templateReturnPage = 'care-templates'
    this.templateRequestKey = `template-${Date.now()}-${Math.random().toString(36).slice(2)}`
    this.setData({ page: 'template-edit', templateEditor: existing ? { ...existing } : { id: '', name: '', title: '', instructions: '', service: '通用', feedbackDays: 1, enabled: true, version: 0 }, templateServiceIndex: existing ? this.data.templateServices.indexOf(existing.service) : 0 })
  },
  saveCareAsTemplate() {
    if (this.data.careBusy || this.data.templateSaving) return
    const form = this.data.careEditor
    this.templateReturnPage = 'care-edit'
    this.templateRequestKey = `template-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const today = new Date(Date.now() + 8 * 3600000).toISOString().slice(0, 10)
    const feedbackDays = Math.max(0, Math.min(365, Math.round((new Date(`${form.dueDate}T00:00:00Z`) - new Date(`${today}T00:00:00Z`)) / 86400000)))
    this.setData({ page: 'template-edit', templateEditor: { id: '', name: form.title.slice(0, 60), title: form.title, instructions: form.instructions,
      service: form.service, feedbackDays, enabled: true, version: 0 }, templateServiceIndex: this.data.templateServices.indexOf(form.service) })
  },
  templateInput(e) {
    if (this.data.templateSaving) return
    const field = e.currentTarget.dataset.field
    this.setData({ [`templateEditor.${field}`]: field === 'feedbackDays' ? Number(e.detail.value) : e.detail.value })
  },
  templateServiceChange(e) {
    if (this.data.templateSaving) return
    const index = Number(e.detail.value)
    this.setData({ templateServiceIndex: index, 'templateEditor.service': this.data.templateServices[index] })
  },
  returnFromTemplate() {
    const page = this.templateReturnPage === 'care-edit' ? 'care-edit' : 'care-templates'
    this.setData({ page, templateEditor: null }); this.loadCareTemplates(page === 'care-templates')
  },
  saveCareTemplate() {
    if (this.data.templateSaving || !this.data.templateEditor || this.data.tab !== 'clinic') return
    const editor = { ...this.data.templateEditor }, userId = this.data.profile.id
    this.setData({ templateSaving: true })
    api.saveCareTemplate(editor.id, { ...editor, requestKey: this.templateRequestKey }).then(() => {
      if (this.data.tab !== 'clinic' || this.data.profile.id !== userId || this.data.page !== 'template-edit' || !this.data.templateEditor || this.data.templateEditor.id !== editor.id) return
      this.returnFromTemplate(); wx.showToast({ title: '模板已保存' })
    }).catch(error => this.showError(error)).finally(() => this.setData({ templateSaving: false }))
  },
  publishCare() {
    if (this.data.careBusy) return
    this.careRequestKey = this.careRequestKey || `care-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const form = { ...this.data.careEditor, requestKey: this.careRequestKey }
    this.setData({ careBusy: true })
    const send = form.taskId ? api.publishCare(form.taskId, form) : api.createCare(form)
    send.then(() => {
      this.setData({ page: 'home', careEditor: {} }); this.careRequestKey = null
      this.refreshRemote(); wx.showToast({ title: '护理任务已发送' })
    }).catch(error => this.showError(error)).finally(() => this.setData({ careBusy: false }))
  },
  openCareFeedback(e) {
    const task = this.data.tasks.find(t => t.id === e.currentTarget.dataset.id)
    if (!task) return
    this.clearCarePhotoCache()
    this.setData({ page: 'care-detail', selectedCare: task,
      careFeedback: task.feedback ? { pain: task.feedback.pain, bleeding: !!task.feedback.bleeding, swelling: !!task.feedback.swelling, note: task.feedback.note }
        : { pain: '无疼痛', bleeding: false, swelling: false, note: '' } })
    this.loadCarePhotos()
  },
  loadCarePhotos() {
    if (!this.data.selectedCare || !['care-detail','care-review'].includes(this.data.page)) return Promise.resolve()
    if (this.data.tab === 'clinic' && !this.data.selectedCare.feedback) return Promise.resolve()
    const taskId = this.data.selectedCare.id, page = this.data.page, tab = this.data.tab, userId = this.data.profile.id
    this.clearCarePhotoCache()
    const requestId = this.photoRequestId
    const current = () => this.photoRequestId === requestId && this.data.page === page && this.data.tab === tab && this.data.profile.id === userId && this.data.selectedCare && this.data.selectedCare.id === taskId
    this.setData({ photosLoading: true })
    return api.carePhotos(taskId).then(result => {
      if (!current()) return
      this.setData({ carePhotos: result.photos.map(photo => ({ ...photo,url: '' })) })
      return Promise.all(result.photos.map(async photo => {
        try {
          const path = await api.downloadCarePhoto(photo.id)
          if (!current()) { wx.getFileSystemManager().unlink({ filePath: path,fail: () => {} }); return }
          this.photoCachePaths.push(path)
          this.setData({ carePhotos: this.data.carePhotos.map(row => row.id === photo.id ? { ...row,url: path } : row) })
        } catch (error) { if (current()) this.setData({ photosError: error.message }) }
      }))
    }).catch(error => { if (current()) this.setData({ photosError: error.message }) })
      .finally(() => { if (current()) this.setData({ photosLoading: false }) })
  },
  chooseCarePhotos() {
    if (this.data.photoBusy || this.data.photosLoading || this.data.careBusy || !this.data.selectedCare || this.data.selectedCare.status !== 'published' || this.data.tab !== 'patient') return
    const remaining = 3 - this.data.carePhotos.length
    if (!this.data.selectedCare.mayManage) return
    if (remaining <= 0) return this.showError(new Error('最多上传 3 张照片'))
    const taskId = this.data.selectedCare.id, userId = this.data.profile.id
    const current = () => this.data.tab === 'patient' && this.data.page === 'care-detail' && this.data.profile.id === userId && this.data.selectedCare && this.data.selectedCare.id === taskId
    this.setData({ photoBusy: true })
    new Promise((resolve,reject) => wx.chooseImage({ count: remaining,sizeType: ['compressed'],sourceType: ['album','camera'],
      success: result => resolve(result.tempFilePaths),fail: reject })).then(async paths => {
      for (const path of paths) {
        if (!current()) break
        await api.uploadCarePhoto(taskId,path,`photo-${Date.now()}-${Math.random().toString(36).slice(2)}`)
      }
    }).catch(error => { if (current() && !(error.errMsg && error.errMsg.includes('cancel'))) this.showError(error) })
      .finally(() => {
        this.setData({ photoBusy: false })
        if (current()) this.loadCarePhotos()
      })
  },
  removeCarePhoto(e) {
    if (this.data.photoBusy || this.data.photosLoading || this.data.careBusy || !this.data.selectedCare || this.data.selectedCare.status !== 'published' || this.data.tab !== 'patient') return
    const id = e.currentTarget.dataset.id, taskId = this.data.selectedCare.id
    if (!this.data.selectedCare.mayManage) return
    if (!this.data.carePhotos.some(photo => photo.id === id)) return
    this.setData({ photoBusy: true })
    api.removeCarePhoto(id).catch(error => this.showError(error)).finally(() => {
      this.setData({ photoBusy: false })
      if (this.data.page === 'care-detail' && this.data.selectedCare && this.data.selectedCare.id === taskId) this.loadCarePhotos()
    })
  },
  previewCarePhoto(e) {
    const urls = this.data.carePhotos.filter(photo => photo.url).map(photo => photo.url)
    const photo = this.data.carePhotos.find(photo => photo.id === e.currentTarget.dataset.id)
    if (photo && photo.url) wx.previewImage({ current: photo.url,urls })
  },
  carePainChange(e) { this.setData({ 'careFeedback.pain': e.currentTarget.dataset.value }) },
  careSymptomChange(e) { this.setData({ [`careFeedback.${e.currentTarget.dataset.field}`]: e.detail.value }) },
  careNoteInput(e) { this.setData({ 'careFeedback.note': e.detail.value }) },
  submitCareFeedback() {
    if (this.data.careBusy || this.data.photoBusy || this.data.photosLoading || !this.data.selectedCare) return
    if (this.data.photosError) return this.showError(new Error('请先刷新并确认照片加载成功'))
    if (!this.data.selectedCare.mayManage) return this.showError(new Error('该成员为只读授权，不能提交反馈'))
    this.setData({ careBusy: true })
    api.feedbackCare(this.data.selectedCare.id, { ...this.data.careFeedback,photos: this.data.carePhotos.map(photo => photo.id) }).then(result => {
      this.setData({ selectedCare: careView(result.task) }); this.refreshRemote()
      this.loadCarePhotos()
      wx.showToast({ title: '反馈已提交' })
    }).catch(error => this.showError(error)).finally(() => this.setData({ careBusy: false }))
  },
  openCareReview(e) {
    const task = this.data.tasks.find(t => t.id === e.currentTarget.dataset.id)
    if (!task) return
    this.clearCarePhotoCache()
    this.setData({ page: 'care-review', selectedCare: task, careContactNote: '', careContactKey: '', careResolutionNote: task.resolution ? task.resolution.note : '' })
    this.loadCarePhotos()
  },
  careResolutionInput(e) { this.setData({ careResolutionNote: e.detail.value }) },
  resolveCare() {
    if (this.data.careBusy || !this.data.selectedCare) return
    this.setData({ careBusy: true })
    api.resolveCare(this.data.selectedCare.id, this.data.careResolutionNote).then(result => {
      this.setData({ selectedCare: careView(result.task) }); this.refreshRemote()
      wx.showToast({ title: '处理意见已保存' })
    }).catch(error => this.showError(error)).finally(() => this.setData({ careBusy: false }))
  },
  showTip(e) { wx.showToast({ title: e.currentTarget.dataset.message || '即将开放', icon: 'none' }) }
})
