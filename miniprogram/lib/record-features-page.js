const api = require('./api')
const time = value => new Date(new Date(value).getTime()+8*3600000).toISOString().slice(0,16).replace('T',' ')
const statuses = { submitted:'待受理',processing:'处理中',approved:'核验通过',rejected:'未予办理',revoked:'已撤销',adult_confirmed:'已确认成年',completed:'已完成',withdrawn:'已撤回' }
const kinds = { access:'资料访问',export:'资料导出',closure:'账号注销' }
const key = () => 'archive-'+Date.now()+'-'+Math.random().toString(36).slice(2)
const chooseFile = () => new Promise((resolve,reject) => wx.chooseMessageFile({ count: 1,type:'file',success: result => resolve(result.tempFiles[0]),fail: reject }))
const emptyAnswers = () => ({ allergies:'',medications:'',conditions:'',previousReactions:'',chiefComplaint:'',bleedingHistory:null,pregnant:null,tobacco:'unknown' })
module.exports = {
  clearRecordFeatures() {
    this.recordFeatureEpoch=(this.recordFeatureEpoch || 0)+1
    for (const path of this.recordFeaturePaths || []) wx.getFileSystemManager().unlink({filePath:path,fail:()=>{}})
    this.recordFeaturePaths=[]
    this.setData({ dicomPreview:null,dicomFile:null,dicomCenter:'',dicomWidth:'',dicomFrame:0,registration:null,featureLoading:false,featureBusy:false,featureError:'',featureMemberId:'',featureVisit:null,attachments:[],healthVersions:[],healthEditor:null,healthConsent:false,healthDirty:false,
      guardianExternalConsent:false,guardianState:null,guardianItems:[],guardianPage:0,guardianHasMore:false,guardianReview:null,guardianEditor:{name:'',relationship:'母亲',phone:'',birthDate:''},guardianNote:'',guardianIdentityChecked:false,guardianRelationshipChecked:false,
      privacyItems:[],privacyEditor:null,privacyReview:null,privacyNote:'',privacyConfirmed:false,privacyPage:0,privacyHasMore:false,
      accessLogItems:[],accessLogPage:0,accessLogHasMore:false,accessLogAction:'',photoComparison:null,compareSelected:[] })
  },
  featureGuard() {
    const epoch=this.recordFeatureEpoch,profile=this.data.profile,tab=this.data.tab,page=this.data.page
    return () => epoch===this.recordFeatureEpoch && profile===this.data.profile && tab===this.data.tab && page===this.data.page
  },
  featureContext(page,memberId='',visit=null) { this.clearRecordFeatures(); this.setData({page,featureMemberId:memberId,featureVisit:visit}) },
  returnRecordFeature() {
    const member=this.data.featureMemberId,visit=this.data.featureVisit
    this.clearRecordFeatures()
    if (visit) { this.setData({page:'history-detail'}); this.loadHistory(visit.id) }
    else if (member) this.openPatientRecord({currentTarget:{dataset:{id:member}}})
    else this.goHome()
  },
  buildToothChart() {
    const adult=[[18,17,16,15,14,13,12,11,21,22,23,24,25,26,27,28],[48,47,46,45,44,43,42,41,31,32,33,34,35,36,37,38]],child=[[55,54,53,52,51,61,62,63,64,65],[85,84,83,82,81,71,72,73,74,75]]
    const numbers=this.data.dentition==='child' ? child : this.data.dentition==='mixed' ? [...adult,...child] : adult
    const recorded=new Set((this.data.patientRecord?.summaries || []).flatMap(row=>row.structured?.teeth || []))
    this.setData({ toothRows:numbers.map((row,index)=>({id:index,label: (this.data.dentition==='child' || this.data.dentition==='mixed' && index>=2 ? '乳牙 · ' : '恒牙 · ')+(index%2===0 ? '上颌（患者右 → 左）' : '下颌（患者右 → 左）'),teeth:row.map(number=>({id:String(number),hasRecord:recorded.has(String(number)),selected:this.data.selectedTooth===String(number)}))})) })
  },
  dentitionChange(e) { this.setData({dentition:e.currentTarget.dataset.value,selectedTooth:'',toothTreatments:[]}); this.buildToothChart() },
  selectTooth(e) {
    const tooth=e.currentTarget.dataset.tooth
    this.setData({ selectedTooth:tooth,toothTreatments:(this.data.patientRecord?.summaries || []).filter(row=>row.structured?.teeth?.includes(tooth)),toothPhotos:this.data.recordAlbum.filter(row=>row.tooth===tooth) })
    this.buildToothChart()
  },
  toggleComparePhoto(e) {
    if (this.data.recordPhotoBusy) return
    const id=e.currentTarget.dataset.id,photo=this.data.recordAlbum.find(row=>row.id===id)
    if (!photo || photo.source!=='record' || photo.angle==='未标注') return
    let selected=[...this.data.compareSelected]
    if (selected.includes(id)) selected=selected.filter(value=>value!==id)
    else if (selected.length<2) selected.push(id)
    else return this.setData({patientRecordError:'最多选择两张照片；请先取消一张'})
    this.setData({ compareSelected:selected,recordAlbum:this.data.recordAlbum.map(row=>({...row,compareChecked:selected.includes(row.id)})),photoComparison:null })
  },
  async compareRecordPhotos() {
    if (this.data.compareSelected.length!==2 || this.data.recordPhotoBusy || !this.data.patientRecord) return
    const current=this.patientRecordGuard(),member=this.data.patientRecord.member.id,[left,right]=this.data.compareSelected
    this.setData({recordPhotoBusy:true,patientRecordError:'',photoComparison:null})
    const paths=[]
    try {
      const result=await api.photoComparison(member,left,right,this.data.tab)
      if (!current()) return
      for (const photo of [result.comparison.left,result.comparison.right]) { paths.push(await api.downloadRecordPhoto(photo.id,this.data.tab)); if (!current()) return }
      this.recordPhotoPaths=[...(this.recordPhotoPaths || []),...paths]
      this.setData({photoComparison:{...result.comparison,leftUrl:paths[0],rightUrl:paths[1]},compareZoom:1,registration:null})
    } catch(error) { if(current()) this.setData({patientRecordError:error.message}) }
    finally {
      if(!current() || paths.length!==2) for(const path of paths) wx.getFileSystemManager().unlink({filePath:path,fail:()=>{}})
      if(current()) this.setData({recordPhotoBusy:false})
    }
  },
  async autoRegisterPhotos(){
    if(this.data.recordPhotoBusy||!this.data.photoComparison||!this.data.patientRecord)return
    const current=this.patientRecordGuard(),comparison=this.data.photoComparison
    this.setData({recordPhotoBusy:true,patientRecordError:'',registration:null})
    try{const result=await api.featureRequest('GET',`/v1/members/${encodeURIComponent(this.data.patientRecord.member.id)}/photo-registration?left=${encodeURIComponent(comparison.left.id)}&right=${encodeURIComponent(comparison.right.id)}&scope=${this.data.tab==='clinic'?'clinic':'mine'}`);if(current())this.setData({registration:result.registration})}catch(error){if(current())this.setData({patientRecordError:error.message})}finally{if(current())this.setData({recordPhotoBusy:false})}
  },
  resetRegistration(){this.setData({registration:null})},
  previewDicom(e){const row=this.data.attachments.find(item=>item.id===e.currentTarget.dataset.id);if(!row)return;this.setData({dicomFile:row,dicomCenter:'',dicomWidth:'',dicomFrame:0,dicomPreview:null});return this.renderDicomPreview()},
  dicomInput(e){if(!this.data.featureBusy&&['dicomCenter','dicomWidth','dicomFrame'].includes(e.currentTarget.dataset.field))this.setData({[e.currentTarget.dataset.field]:e.detail.value})},
  async renderDicomPreview(){
    if(this.data.featureBusy||!this.data.dicomFile)return
    const current=this.featureGuard(),id=this.data.dicomFile.id
    this.setData({featureBusy:true,featureError:''})
    const params=`scope=${this.data.tab==='clinic'?'clinic':'mine'}&frame=${encodeURIComponent(this.data.dicomFrame||0)}`+(this.data.dicomCenter!==''?`&center=${encodeURIComponent(this.data.dicomCenter)}`:'')+(this.data.dicomWidth!==''?`&width=${encodeURIComponent(this.data.dicomWidth)}`:'')
    try{const file=await api.downloadRecordFile(`/v1/record-attachments/${encodeURIComponent(id)}/preview?${params}`);if(!current()){wx.getFileSystemManager().unlink({filePath:file,fail:()=>{}});return}this.recordFeaturePaths.push(file);this.setData({dicomPreview:file})}catch(error){if(current())this.setData({featureError:'此影像无法预览；当前支持未压缩小端灰度DICOM，可下载原文件使用诊所阅片软件'})}finally{if(current())this.setData({featureBusy:false})}
  },
  compareZoomChange(e) { this.setData({compareZoom:Math.max(1,Math.min(3,this.data.compareZoom+Number(e.currentTarget.dataset.delta)))}) },
  openAttachments() {
    const visit=this.data.selectedHistory?.appointment
    if(!visit) return
    this.featureContext('record-attachments','',visit); return this.loadAttachments()
  },
  loadAttachments() {
    if(this.data.page!=='record-attachments' || !this.data.featureVisit) return
    const current=this.featureGuard()
    this.setData({featureLoading:true,featureError:'',attachments:[]})
    return api.recordAttachments(this.data.featureVisit.id,this.data.tab).then(result=>{if(current()) this.setData({attachments:result.attachments.map(row=>({...row,timeLabel:time(row.createdAt)}))})})
      .catch(error=>{if(current()) this.setData({featureError:error.message})}).finally(()=>{if(current()) this.setData({featureLoading:false})})
  },
  attachmentInput(e) { if(!this.data.featureBusy && ['attachmentKindIndex','attachmentTooth'].includes(e.currentTarget.dataset.field)) this.setData({[e.currentTarget.dataset.field]:e.currentTarget.dataset.field.endsWith('Index') ? Number(e.detail.value) : e.detail.value}) },
  async uploadAttachment() {
    if(this.data.featureBusy || this.data.tab!=='clinic' || this.data.featureVisit?.status!=='已完成') return
    const current=this.featureGuard(),id=this.data.featureVisit.id
    this.setData({featureBusy:true,featureError:''})
    try {
      const file=await chooseFile(); if(!current()) return
      await api.uploadRecordAttachment(id,file.path,{kind:this.data.attachmentKinds[this.data.attachmentKindIndex],name:file.name,tooth:this.data.attachmentTooth.trim(),requestKey:key()})
      if(current()) await this.loadAttachments()
    }catch(error){if(current() && !String(error.errMsg || '').includes('cancel')) this.setData({featureError:error.message || '附件上传失败'})}
    finally{if(current()) this.setData({featureBusy:false})}
  },
  async openPrivateFile(route,mime,name='附件') {
    if(this.data.featureBusy) return
    const current=this.featureGuard()
    this.setData({featureBusy:true,featureError:''})
    try {
      const path=await api.downloadRecordFile(route)
      if(!current()){wx.getFileSystemManager().unlink({filePath:path,fail:()=>{}});return}
      this.recordFeaturePaths=[...(this.recordFeaturePaths || []),path]
      if(mime?.startsWith('image/')) wx.previewImage({current:path,urls:[path]})
      else if(mime==='application/vnd.openxmlformats-officedocument.wordprocessingml.document'||mime==='application/vnd.openxmlformats-officedocument.spreadsheetml.sheet') wx.openDocument({filePath:path,fileType:mime.endsWith('.sheet')?'xlsx':'docx',showMenu:true,fail:()=>{if(current())this.setData({featureError:'当前环境无法预览Office附件，可下载后查看'})}})
      else if(mime==='application/pdf') wx.openDocument({filePath:path,fileType:'pdf',showMenu:true,fail:()=>{if(current()) this.setData({featureError:'无法预览 PDF，请重新下载或联系诊所'})}})
      else wx.shareFileMessage({filePath:path,fileName:name,fail:error=>{if(current() && !String(error.errMsg || '').includes('cancel')) this.setData({featureError:'文件已下载，当前微信版本无法转存此文件'})}})
    }catch(error){if(current()) this.setData({featureError:error.message})}
    finally{if(current()) this.setData({featureBusy:false})}
  },
  downloadAttachment(e){ const row=this.data.attachments.find(item=>item.id===e.currentTarget.dataset.id); if(row) return this.openPrivateFile(`/v1/record-attachments/${encodeURIComponent(row.id)}?scope=${this.data.tab==='clinic'?'clinic':'mine'}`,row.mime,row.name) },
  showQuestionnaire() {
    const member=this.data.patientRecord?.member
    if(!member) return
    this.featureContext('health-questionnaire',member.id); this.setData({healthMayEdit:this.data.tab==='patient' && member.mayManage}); return this.loadQuestionnaire()
  },
  loadQuestionnaire() {
    const current=this.featureGuard()
    this.setData({featureLoading:true,featureError:'',healthVersions:[],healthEditor:null,healthConsent:false,healthDirty:false})
    return api.questionnaire(this.data.featureMemberId,this.data.tab).then(result=>{
      if(!current()) return
      const versions=result.versions.map(row=>({...row,timeLabel:time(row.createdAt),preview:this.data.healthQuestionFields.map(field=>field.label+'：'+(row.answers[field.key] || '未填写')).join('\n')+'\n异常出血史：'+(row.answers.bleedingHistory===null?'未确认':row.answers.bleedingHistory?'有':'无')+'\n怀孕情况：'+(row.answers.pregnant===null?'未确认':row.answers.pregnant?'是':'否')+'\n吸烟情况：'+(this.data.tobaccoOptions.find(option=>option.value===row.answers.tobacco)?.label || '未确认')})),latest=versions[0]
      this.setData({healthVersions:versions,healthEditor:{version:latest?.version || 0,answers:latest?.answers || emptyAnswers()}})
    }).catch(error=>{if(current()) this.setData({featureError:error.message})}).finally(()=>{if(current()) this.setData({featureLoading:false})})
  },
  questionnaireInput(e) {
    if(this.data.featureBusy || !this.data.healthMayEdit || !this.data.healthEditor) return
    const field=e.currentTarget.dataset.field,value=e.detail?.value ?? e.currentTarget.dataset.value
    if(field==='consent') return this.setData({healthConsent:!!value})
    if(!['allergies','medications','conditions','previousReactions','chiefComplaint','pregnant','bleedingHistory','tobacco'].includes(field)) return
    const answer=['pregnant','bleedingHistory'].includes(field) ? value==='true' ? true : value==='false' ? false : null : value
    this.setData({healthDirty:true,healthEditor:{...this.data.healthEditor,answers:{...this.data.healthEditor.answers,[field]:answer}}})
  },
  saveHealthQuestionnaire() {
    if(this.data.featureBusy || !this.data.healthMayEdit || !this.data.healthEditor) return
    const current=this.featureGuard()
    this.setData({featureBusy:true,featureError:''})
    return api.saveQuestionnaire(this.data.featureMemberId,{...this.data.healthEditor,consent:this.data.healthConsent}).then(()=>{if(current()) return this.loadQuestionnaire()})
      .catch(error=>{if(current()) this.setData({featureError:error.message})}).finally(()=>{if(current()) this.setData({featureBusy:false})})
  },
  showGuardianCheck(e) {
    const id=e?.currentTarget?.dataset?.id || this.data.patientRecord?.member.id
    if(!id || this.data.tab!=='patient') return
    this.featureContext('guardian-check',id); return this.loadGuardianCheck()
  },
  loadGuardianCheck() {
    const current=this.featureGuard()
    this.setData({featureLoading:true,featureError:'',guardianState:null})
    return api.guardianStatus(this.data.featureMemberId).then(result=>{if(current()) this.setData({guardianState:{...result,checks:result.checks.map(row=>({...row,statusLabel:statuses[row.status]}))},guardianEditor:{...this.data.guardianEditor,birthDate:result.birthDate}})})
      .catch(error=>{if(current()) this.setData({featureError:error.message})}).finally(()=>{if(current()) this.setData({featureLoading:false})})
  },
  guardianInput(e) {
    if(this.data.featureBusy) return
    const field=e.currentTarget.dataset.field,value=e.detail?.value ?? e.currentTarget.dataset.value
    if(['name','phone','birthDate','relationship'].includes(field)) this.setData({guardianEditor:{...this.data.guardianEditor,[field]:value}})
    else if(['guardianNote','guardianIdentityChecked','guardianRelationshipChecked'].includes(field)) this.setData({[field]:value})
  },
  async submitGuardianCheck() {
    if(this.data.featureBusy || this.data.featureLoading) return
    const current=this.featureGuard(),id=this.data.featureMemberId
    this.setData({featureBusy:true,featureError:''})
    try {
      const file=await chooseFile(); if(!current()) return
      await api.submitGuardian(id,file.path,{...this.data.guardianEditor,externalConsent:this.data.guardianExternalConsent===true,requestKey:key()})
      if(current()) await this.loadGuardianCheck()
    }catch(error){if(current() && !String(error.errMsg || '').includes('cancel')) this.setData({featureError:error.message || '核验材料提交失败'})}
    finally{if(current()) this.setData({featureBusy:false})}
  },
  async toggleGuardianExternalConsent(e){if(this.data.featureBusy)return;const row=this.data.guardianState?.checks.find(item=>item.id===e.currentTarget.dataset.id);if(!row)return;const current=this.featureGuard();this.setData({featureBusy:true,featureError:''});try{await api.featureRequest('POST',`/v1/guardian-checks/${encodeURIComponent(row.id)}/external-consent`,{version:row.version,selected:!row.externalConsent});if(current())await this.loadGuardianCheck()}catch(error){if(current())this.setData({featureError:error.message})}finally{if(current())this.setData({featureBusy:false})}},
  guardianExternalConsent(e){if(!this.data.featureBusy)this.setData({guardianExternalConsent:e.detail.value.includes('accepted')})},
  async queryExternalIdentity(){if(this.data.featureBusy||!this.data.guardianReview)return;const current=this.featureGuard(),row=this.data.guardianReview;this.setData({featureBusy:true,featureError:''});try{await api.featureRequest('POST',`/v1/guardian-checks/${encodeURIComponent(row.id)}/external-verification`,{version:row.version});if(current()){this.setData({guardianReview:null});await this.loadGuardianAdmin()}}catch(error){if(current())this.setData({featureError:error.message})}finally{if(current())this.setData({featureBusy:false})}},
  showGuardianAdmin() {
    if(this.data.tab!=='clinic' || this.data.profile?.role!=='admin') return
    this.featureContext('guardian-admin'); return this.loadGuardianAdmin()
  },
  loadGuardianAdmin(more=false) {
    if(typeof more!=='boolean') more=false
    if(this.data.featureLoading || more && !this.data.guardianHasMore) return
    const current=this.featureGuard(),page=more ? this.data.guardianPage+1 : 1
    this.setData({featureLoading:true,featureError:'',...(!more ? {guardianItems:[],guardianReview:null} : {})})
    return api.guardianChecks(page).then(result=>{if(current()) this.setData({guardianItems:[...(more ? this.data.guardianItems : []),...result.items.map(row=>({...row,statusLabel:statuses[row.status]}))],guardianPage:page,guardianHasMore:result.hasMore})})
      .catch(error=>{if(current()) this.setData({featureError:error.message})}).finally(()=>{if(current()) this.setData({featureLoading:false})})
  },
  moreGuardianChecks(){return this.loadGuardianAdmin(true)},
  selectGuardianReview(e) { if(!this.data.featureBusy) this.setData({guardianReview:this.data.guardianItems.find(row=>row.id===e.currentTarget.dataset.id) || null,guardianNote:'',guardianIdentityChecked:false,guardianRelationshipChecked:false}) },
  reviewGuardianCheck(e) {
    if(this.data.featureBusy || !this.data.guardianReview) return
    const current=this.featureGuard(),row=this.data.guardianReview
    this.setData({featureBusy:true,featureError:''})
    return api.reviewGuardian(row.id,{version:row.version,status:e.currentTarget.dataset.status,note:this.data.guardianNote,identityChecked:this.data.guardianIdentityChecked,relationshipChecked:this.data.guardianRelationshipChecked}).then(()=>{if(current()) return this.loadGuardianAdmin()})
      .catch(error=>{if(current()) this.setData({featureError:error.message})}).finally(()=>{if(current()) this.setData({featureBusy:false})})
  },
  viewGuardianEvidence(e) { const id=e.currentTarget.dataset.id,row=this.data.guardianItems.find(item=>item.id===id) || this.data.guardianState?.checks.find(item=>item.id===id); if(row) return this.openPrivateFile(`/v1/guardian-checks/${encodeURIComponent(id)}/evidence`,row.mime,'监护关系材料') },
  showPrivacyRequests() {
    if(this.data.tab==='clinic' && this.data.profile?.role!=='admin') return
    this.featureContext('privacy-requests'); return this.loadPrivacyRequests()
  },
  startPrivacyRequest(e) {
    const kind=e.currentTarget.dataset.kind,member=this.data.patientRecord?.member
    if(this.data.tab!=='patient' || kind!=='closure' && !member?.mayManage) return
    this.featureContext('privacy-requests',kind==='closure'?'':member.id)
    this.setData({privacyEditor:{kind,memberId:kind==='closure'?'':member.id,details:'',requestKey:key(),confirmed:false}})
    return this.loadPrivacyRequests()
  },
  loadPrivacyRequests(more=false) {
    if(typeof more!=='boolean') more=false
    if(this.data.featureLoading || more && !this.data.privacyHasMore) return
    const current=this.featureGuard(),page=more ? this.data.privacyPage+1 : 1
    this.setData({featureLoading:true,featureError:'',...(!more ? {privacyItems:[],privacyReview:null} : {})})
    return api.privacyRequests(this.data.tab,page).then(result=>{if(current()) this.setData({privacyItems:[...(more ? this.data.privacyItems : []),...result.items.map(row=>({...row,statusLabel:statuses[row.status],kindLabel:kinds[row.kind],events:row.events.map(event=>({...event,statusLabel:statuses[event.status],timeLabel:time(event.createdAt)}))}))],privacyPage:page,privacyHasMore:result.hasMore})})
      .catch(error=>{if(current()) this.setData({featureError:error.message})}).finally(()=>{if(current()) this.setData({featureLoading:false})})
  },
  morePrivacyRequests(){return this.loadPrivacyRequests(true)},
  privacyInput(e) {
    if(this.data.featureBusy) return
    const field=e.currentTarget.dataset.field
    if(['details','confirmed'].includes(field) && this.data.privacyEditor) this.setData({privacyEditor:{...this.data.privacyEditor,[field]:e.detail.value,requestKey:key()}})
    else if(['privacyNote','privacyConfirmed'].includes(field)) this.setData({[field]:e.detail.value})
  },
  submitPrivacy() {
    if(this.data.featureBusy || !this.data.privacyEditor) return
    const current=this.featureGuard()
    this.setData({featureBusy:true,featureError:''})
    return api.submitPrivacyRequest(this.data.privacyEditor).then(()=>{if(current()){this.setData({privacyEditor:null});return this.loadPrivacyRequests()}})
      .catch(error=>{if(current()) this.setData({featureError:error.message})}).finally(()=>{if(current()) this.setData({featureBusy:false})})
  },
  selectPrivacyReview(e){if(!this.data.featureBusy) this.setData({privacyReview:this.data.privacyItems.find(row=>row.id===e.currentTarget.dataset.id) || null,privacyNote:'',privacyConfirmed:false,privacyEditor:null})},
  updatePrivacy(e) {
    if(this.data.featureBusy || !this.data.privacyReview) return
    const current=this.featureGuard(),row=this.data.privacyReview
    this.setData({featureBusy:true,featureError:''})
    return api.updatePrivacyRequest(row.id,{status:e.currentTarget.dataset.status,version:row.version,note:this.data.privacyNote,confirmed:this.data.privacyConfirmed}).then(()=>{if(current()) return this.loadPrivacyRequests()})
      .catch(error=>{if(current()) this.setData({featureError:error.message})}).finally(()=>{if(current()) this.setData({featureBusy:false})})
  },
  downloadPrivacyPackage(e) { const row=this.data.privacyItems.find(item=>item.id===e.currentTarget.dataset.id); if(row?.downloadable && this.data.tab==='patient') return this.openPrivateFile(`/v1/privacy-requests/${encodeURIComponent(row.id)}/download?part=${Number(e.currentTarget.dataset.part)||1}`,'application/zip',`ApexDental-${row.kind}-${row.id}.zip`) },
  showRecordLogs(e) {
    const member=e?.currentTarget?.dataset?.member || ''
    if(this.data.tab==='clinic' && this.data.profile?.role!=='admin') return
    this.featureContext('record-logs',member);return this.loadRecordLogs()
  },
  loadRecordLogs(more=false) {
    if(typeof more!=='boolean') more=false
    if(this.data.featureLoading || more && !this.data.accessLogHasMore) return
    const current=this.featureGuard(),page=more ? this.data.accessLogPage+1 : 1
    this.setData({featureLoading:true,featureError:'',...(!more ? {accessLogItems:[]} : {})})
    return api.recordAccessLogs(this.data.tab,this.data.featureMemberId,page,this.data.accessLogAction).then(result=>{if(current()) this.setData({accessLogItems:[...(more?this.data.accessLogItems:[]),...result.items.map(row=>({...row,timeLabel:time(row.createdAt),actionLabel:{access:'访问',download:'下载',change:'变更'}[row.action]}))],accessLogPage:page,accessLogHasMore:result.hasMore})})
      .catch(error=>{if(current()) this.setData({featureError:error.message})}).finally(()=>{if(current()) this.setData({featureLoading:false})})
  },
  logActionChange(e){if(this.data.featureLoading)return;this.setData({accessLogAction:e.currentTarget.dataset.action});return this.loadRecordLogs()},
  moreRecordLogs(){return this.loadRecordLogs(true)}
}
