const config = require('./config')
function base(){let version='develop';try{version=wx.getAccountInfoSync?.().miniProgram?.envVersion||'develop'}catch{}const value=config.apiBases[version]||'';if(!value||version!=='develop'&&!value.startsWith('https://'))throw new Error('当前环境尚未配置诊所服务地址，请联系诊所');return value.replace(/\/$/,'')}
let token = ''

function request(method, route, data) {
  return new Promise((resolve, reject) => {
    wx.request({
      url: base() + route, method, data, timeout: route.includes('external-verification') || route.includes('screenings') || route.includes('/invoices/') ? 20000 : 4000,
      header: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
      success: response => {
        if (response.statusCode >= 200 && response.statusCode < 300) resolve(response.data)
        else reject(new Error(response.data && response.data.error || '服务请求失败'))
      },
      fail: () => reject(new Error('无法连接本机预约服务'))
    })
  })
}
function uploadCarePhoto(id,path,requestKey,route) {
  return new Promise((resolve,reject) => wx.getFileSystemManager().readFile({ filePath: path,
    success: file => {
      if (file.data.byteLength > 3 * 1024 * 1024) return reject(new Error('单张图片不能超过 3 MB，请压缩后上传'))
      wx.request({ url: base() + (route || `/v1/care-tasks/${encodeURIComponent(id)}/photos?requestKey=${encodeURIComponent(requestKey)}`),
        method: 'POST',data: file.data,timeout: 15000,header: { 'content-type': 'application/octet-stream',authorization: `Bearer ${token}` },
        success: response => response.statusCode >= 200 && response.statusCode < 300 ? resolve(response.data.photo) : reject(new Error(response.data && response.data.error || '照片上传失败')),
        fail: () => reject(new Error('照片上传失败，请检查连接后重试')) })
    },fail: () => reject(new Error('无法读取照片，请重新选择')) }))
}
function downloadCarePhoto(id,route) {
  return new Promise((resolve,reject) => wx.downloadFile({ url: base() + (route || `/v1/care-photos/${encodeURIComponent(id)}`),
    header: { authorization: `Bearer ${token}` },timeout: 15000,
    success: response => {
      if (response.statusCode === 200) resolve(response.tempFilePath)
      else { if (response.tempFilePath) wx.getFileSystemManager().unlink({ filePath: response.tempFilePath,fail: () => {} }); reject(new Error('无法查看照片，请刷新或重新登录')) }
    },fail: () => reject(new Error('照片加载失败，请重试')) }))
}
function uploadRecordFile(path,route) {
  return new Promise((resolve,reject) => wx.getFileSystemManager().readFile({ filePath: path,success: file => {
    if (file.data.byteLength > 10*1024*1024) return reject(new Error('附件不能超过 10 MB'))
    wx.request({ url: base()+route,method: 'POST',data: file.data,timeout: 30000,header: { 'content-type': 'application/octet-stream',authorization: `Bearer ${token}` },
      success: response => response.statusCode >= 200 && response.statusCode < 300 ? resolve(response.data) : reject(new Error(response.data?.error || '上传失败')),
      fail: () => reject(new Error('上传失败，请重试')) })
  },fail: () => reject(new Error('无法读取所选文件')) }))
}
const queryString = values => Object.keys(values).map(key => encodeURIComponent(key)+'='+encodeURIComponent(values[key])).join('&')

module.exports = {
  featureRequest: request,
  uploadFeatureFile: uploadRecordFile,
  recordAttachments: (id,scope) => request('GET',`/v1/appointments/${encodeURIComponent(id)}/attachments?scope=${scope === 'clinic' ? 'clinic' : 'mine'}`),
  uploadRecordAttachment: (id,path,values) => uploadRecordFile(path,`/v1/appointments/${encodeURIComponent(id)}/attachments?${queryString(values)}`),
  downloadRecordFile: route => downloadCarePhoto('',route),
  photoComparison: (id,left,right,scope) => request('GET',`/v1/members/${encodeURIComponent(id)}/photo-comparison?${queryString({left,right,scope: scope === 'clinic' ? 'clinic' : 'mine'})}`),
  questionnaire: (id,scope) => request('GET',`/v1/members/${encodeURIComponent(id)}/questionnaire?scope=${scope === 'clinic' ? 'clinic' : 'mine'}`),
  saveQuestionnaire: (id,body) => request('PUT',`/v1/members/${encodeURIComponent(id)}/questionnaire`,body),
  guardianStatus: id => request('GET',`/v1/members/${encodeURIComponent(id)}/guardian`),
  submitGuardian: (id,path,values) => uploadRecordFile(path,`/v1/members/${encodeURIComponent(id)}/guardian?${queryString(values)}`),
  guardianChecks: (page=1) => request('GET',`/v1/guardian-checks?page=${page}`),
  reviewGuardian: (id,body) => request('PATCH',`/v1/guardian-checks/${encodeURIComponent(id)}`,body),
  privacyRequests: (scope,page=1) => request('GET',`/v1/privacy-requests?scope=${scope === 'clinic' ? 'clinic' : 'mine'}&page=${page}`),
  submitPrivacyRequest: body => request('POST','/v1/privacy-requests',body),
  updatePrivacyRequest: (id,body) => request('PATCH',`/v1/privacy-requests/${encodeURIComponent(id)}`,body),
  recordAccessLogs: (scope,member='',page=1,action='') => request('GET',`/v1/record-access-logs?${queryString({scope: scope === 'clinic' ? 'clinic' : 'mine',member,page,action})}`),
  patientRecord: (id,scope) => request('GET', `/v1/members/${encodeURIComponent(id)}/record?scope=${scope === 'clinic' ? 'clinic' : 'mine'}`),
  recordPhotos: (id,scope) => request('GET', `/v1/appointments/${encodeURIComponent(id)}/record-photos?scope=${scope === 'clinic' ? 'clinic' : 'mine'}`),
  uploadRecordPhoto: (id,path,key,category,caption,details={}) => uploadCarePhoto(id,path,key,`/v1/appointments/${encodeURIComponent(id)}/record-photos?${queryString({requestKey:key,category,caption,...details})}`),
  downloadRecordPhoto: (id,scope) => downloadCarePhoto(id,`/v1/record-photos/${encodeURIComponent(id)}?scope=${scope === 'clinic' ? 'clinic' : 'mine'}`),
  carePlans: scope => request('GET', `/v1/care-plans?scope=${scope === 'clinic' ? 'clinic' : 'mine'}`),
  carePlan: (id, scope) => request('GET', `/v1/care-plans/${encodeURIComponent(id)}?scope=${scope === 'clinic' ? 'clinic' : 'mine'}`),
  saveCarePlan: entry => request(entry.id ? 'PUT' : 'POST', `/v1/care-plans${entry.id ? '/' + encodeURIComponent(entry.id) : ''}`, entry),
  publishCarePlan: (id, version) => request('POST', `/v1/care-plans/${encodeURIComponent(id)}/publish`, { version }),
  recordRequests: (scope, page = 1, status = '') => request('GET', `/v1/record-requests?scope=${scope}&page=${page}&status=${encodeURIComponent(status)}`),
  submitRecordRequest: data => request('POST', '/v1/record-requests', data),
  updateRecordRequest: (id, data) => request('PATCH', `/v1/record-requests/${encodeURIComponent(id)}`, data),
  notifications: (page = 1, admin = false, status = '') => request('GET', `/v1/${admin ? 'admin/' : ''}notifications?page=${page}&status=${encodeURIComponent(status)}`),
  notificationSettings: () => request('GET', '/v1/notifications/settings'),
  subscribeNotifications: choices => request('POST', '/v1/notifications/subscriptions', { choices }),
  readNotification: id => request('POST', `/v1/notifications/${encodeURIComponent(id)}/read`, {}),
  retryNotification: id => request('POST', `/v1/admin/notifications/${encodeURIComponent(id)}/retry`, {}),
  setToken: value => { token = value || '' },
  articles: (query = '', category = '', page = 1, admin = false, symptom = '', population = '', doctor = '', service = '') => request('GET', `/v1/${admin ? 'admin/' : ''}articles?q=${encodeURIComponent(query)}&category=${encodeURIComponent(category)}&page=${page}&symptom=${encodeURIComponent(symptom)}&population=${encodeURIComponent(population)}&doctor=${encodeURIComponent(doctor)}&service=${encodeURIComponent(service)}`),
  article: (id, admin = false) => request('GET', `/v1/${admin ? 'admin/' : ''}articles/${encodeURIComponent(id)}`),
  saveArticle: entry => request(entry.id ? 'PUT' : 'POST', `/v1/admin/articles${entry.id ? '/' + encodeURIComponent(entry.id) : ''}`, entry),
  articleStatus: (id, version, status) => request('POST', `/v1/admin/articles/${encodeURIComponent(id)}/status`, { version, status }),
  saveArticleCategory: entry => request(entry.id ? 'PUT' : 'POST', `/v1/admin/article-categories${entry.id ? '/' + encodeURIComponent(entry.id) : ''}`, entry),
  contentReviews: (status = 'pending', page = 1) => request('GET', `/v1/content-reviews?status=${encodeURIComponent(status)}&page=${page}`),
  contentReview: id => request('GET', `/v1/content-reviews/${encodeURIComponent(id)}`),
  reviewArticle: (id, version, decision, note = '') => request('POST', `/v1/content-reviews/${encodeURIComponent(id)}`, { version, decision, note }),
  catalog: () => request('GET', '/v1/catalog'),
  adminCatalog: () => request('GET', '/v1/admin/catalog'),
  saveCatalog: (kind, entry) => request(kind === 'clinic' || entry.id ? 'PUT' : 'POST', `/v1/admin/catalog/${kind}${entry.id ? '/' + encodeURIComponent(entry.id) : ''}`, entry),
  health: () => request('GET', '/health'),
  me: () => request('GET', '/v1/me'),
  loginWechat: code => request('POST', '/v1/auth/wechat', { code }),
  loginDemo: deviceId => request('POST', '/v1/auth/demo', { deviceId }),
  claimStaff: (code, displayName) => request('POST', '/v1/staff/claim', { code, displayName }),
  createInvite: (role, doctorName) => request('POST', '/v1/staff/invites', { role, doctorName }),
  staff: () => request('GET', '/v1/staff'),
  disableStaff: id => request('POST', `/v1/staff/${encodeURIComponent(id)}/disable`, {}),
  schedule: (date, doctor) => request('GET', `/v1/admin/schedules?date=${encodeURIComponent(date)}&doctor=${encodeURIComponent(doctor)}`),
  saveSchedule: data => request('PUT', '/v1/admin/schedules', data),
  previewScheduleBatch: data => request('POST','/v1/admin/schedules/batch-preview',data),
  commitScheduleBatch: previewId => request('POST','/v1/admin/schedules/batch-commit',{ previewId }),
  availability: (date, doctor, service = '') => request('GET', `/v1/availability?date=${encodeURIComponent(date)}&doctor=${encodeURIComponent(doctor)}&service=${encodeURIComponent(service)}`),
  appointments: scope => request('GET', `/v1/appointments?scope=${scope === 'clinic' ? 'clinic' : 'mine'}`),
  members: () => request('GET', '/v1/members'),
  saveMember: (id,data) => request(id ? 'PUT' : 'POST',id ? `/v1/members/${encodeURIComponent(id)}` : '/v1/members',data),
  assignMember: (id,memberId) => request('PUT', `/v1/appointments/${encodeURIComponent(id)}/member`,{ memberId }),
  memberShares: id => request('GET',`/v1/members/${encodeURIComponent(id)}/shares`),
  inviteMemberShare: id => request('POST',`/v1/members/${encodeURIComponent(id)}/shares`,{}),
  previewMemberShare: code => request('POST','/v1/member-shares/preview',{ code }),
  acceptMemberShare: (code,displayName) => request('POST','/v1/member-shares/accept',{ code,displayName }),
  revokeMemberShare: (id,isInvite) => request('POST',`/v1/${isInvite ? 'member-share-invites' : 'member-shares'}/${encodeURIComponent(id)}/revoke`,{}),
  worklist: () => request('GET', '/v1/worklist'),
  records: filters => request('GET', '/v1/records?' + Object.keys(filters).map(key => `${encodeURIComponent(key)}=${encodeURIComponent(filters[key])}`).join('&')),
  reschedule: (id,scope) => request('GET', `/v1/appointments/${encodeURIComponent(id)}/reschedule?scope=${scope === 'clinic' ? 'clinic' : 'mine'}`),
  saveReschedule: (id,data) => request('POST', `/v1/appointments/${encodeURIComponent(id)}/reschedule`, data),
  statistics: (from,to,doctor) => request('GET', `/v1/statistics?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&doctor=${encodeURIComponent(doctor || '')}`),
  followupRecall: (id, data) => request('POST', `/v1/appointments/${encodeURIComponent(id)}/recall-followup`, data),
  history: (id, scope) => request('GET', `/v1/appointments/${encodeURIComponent(id)}/history?scope=${scope === 'clinic' ? 'clinic' : 'mine'}`),
  saveVisitSummary: (id, data) => request('PUT', `/v1/appointments/${encodeURIComponent(id)}/summary`, data),
  recalls: scope => request('GET', `/v1/recalls?scope=${scope === 'clinic' ? 'clinic' : 'mine'}`),
  saveRecall: (id, data) => request('PUT', `/v1/appointments/${encodeURIComponent(id)}/recall`, data),
  tasks: scope => request('GET', `/v1/care-tasks?scope=${scope === 'clinic' ? 'clinic' : 'mine'}`),
  carePhotos: id => request('GET', `/v1/care-tasks/${encodeURIComponent(id)}/photos`),
  uploadCarePhoto, downloadCarePhoto,
  removeCarePhoto: id => request('DELETE', `/v1/care-photos/${encodeURIComponent(id)}`),
  careTemplates: includeDisabled => request('GET', `/v1/care-templates?includeDisabled=${includeDisabled ? '1' : '0'}`),
  saveCareTemplate: (id, data) => request(id ? 'PUT' : 'POST', id ? `/v1/care-templates/${encodeURIComponent(id)}` : '/v1/care-templates', data),
  createCare: data => request('POST', '/v1/care-tasks', data),
  publishCare: (id, data) => request('POST', `/v1/care-tasks/${encodeURIComponent(id)}/publish`, data),
  feedbackCare: (id, data) => request('POST', `/v1/care-tasks/${encodeURIComponent(id)}/feedback`, data),
  followupCare: (id, body) => request('POST', `/v1/care-tasks/${encodeURIComponent(id)}/followup`, body),
  resolveCare: (id, note) => request('POST', `/v1/care-tasks/${encodeURIComponent(id)}/resolve`, { note }),
  createAppointment: data => request('POST', '/v1/appointments', data),
  changeStatus: (id, status, version, communicationNote, cancellationReason, scope) => request('PATCH', `/v1/appointments/${encodeURIComponent(id)}/status`, { status, version, communicationNote, cancellationReason, scope }),
}
