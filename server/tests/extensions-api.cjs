const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),http=require('node:http')
const {spawn}=require('node:child_process'),{once}=require('node:events'),{DatabaseSync}=require('node:sqlite')
async function main(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'apex-extensions-')),dbPath=path.join(dir,'test.sqlite'),port=30000+Math.floor(Math.random()*10000),base=`http://127.0.0.1:${port}`
 const provider=http.createServer(async(req,res)=>{let data='';for await(const chunk of req)data+=chunk;const parsed=JSON.parse(data);assert.equal(parsed.images.length,5);res.setHeader('Content-Type','application/json');res.end(JSON.stringify({model:'test-provider',concerns:['Mock：仅验证模型返回与医生复核隔离'],quality:'Mock：人工确认'}))})
 provider.listen(0,'127.0.0.1');await once(provider,'listening')
 const child=spawn(process.execPath,[path.join(__dirname,'../index.js')],{windowsHide:true,stdio:['ignore','pipe','pipe'],env:{...process.env,APEX_PORT:String(port),APEX_DATA_DIR:dir,APEX_DB_PATH:dbPath,APEX_DEMO_AUTH:'1',APEX_SCREENING_URL:`http://127.0.0.1:${provider.address().port}`,APEX_AUTO_BACKUP:'0',APEX_EXPORT_PART_BYTES:'1048576',APEX_WECHAT_APPID:'',APEX_WECHAT_SECRET:'',APEX_WECHAT_TEMPLATES:'{}'}})
 let stderr='';child.stderr.on('data',chunk=>stderr+=chunk);child.stdout.resume()
 async function request(method,route,token,body,expected=200){const result=await fetch(base+route,{method,signal:AbortSignal.timeout(30000),headers:{'content-type':'application/json',...(token?{authorization:`Bearer ${token}`}:{})},...(body===undefined?{}:{body:JSON.stringify(body)})});const data=await result.json();assert.equal(result.status,expected,`${method} ${route}: ${JSON.stringify(data)} ${result.status===500?stderr:""}`);return data}
 const png=await require('sharp')({create:{width:640,height:480,channels:3,background:{r:110,g:150,b:170}}}).png().toBuffer()
 async function binary(route,token,bytes=png,expected=201){const result=await fetch(base+route,{method:'POST',headers:{authorization:`Bearer ${token}`,'content-type':'application/octet-stream'},body:bytes});const data=await result.json();assert.equal(result.status,expected,JSON.stringify(data));return data}
 let direct
 try{
  let ready=false;for(let i=0;i<50;i++){try{await request('GET','/health');ready=true;break}catch{if(child.exitCode!==null)break;await new Promise(resolve=>setTimeout(resolve,100))}}assert.ok(ready,stderr)
  const admin=await request('POST','/v1/auth/demo','',{deviceId:'extensions-admin-device-001'}),patient=await request('POST','/v1/auth/demo','',{deviceId:'extensions-patient-device-001'}),other=await request('POST','/v1/auth/demo','',{deviceId:'extensions-other-device-001'})
  await request('POST','/v1/staff/claim',admin.token,{code:fs.readFileSync(path.join(dir,'bootstrap-code.txt'),'utf8').trim(),displayName:'测试管理员'})
  const doctor=await request('POST','/v1/auth/demo','',{deviceId:'extensions-doctor-device-001'}),front=await request('POST','/v1/auth/demo','',{deviceId:'extensions-frontdesk-device-001'})
  for(const [login,role] of [[doctor,'doctor'],[front,'frontdesk']]){const invitation=await request('POST','/v1/staff/invites',admin.token,{role,doctorName:role==='doctor'?'李医生':''},201);await request('POST','/v1/staff/claim',login.token,{code:invitation.code,displayName:role})}
  const member=(await request('POST','/v1/members',patient.token,{name:'测试成员',phone:'13800000000',relationship:'本人',enabled:true,version:0,requestKey:'extensions-member-001'},201)).member
  const catalog=await request('GET','/v1/admin/catalog',admin.token),service=catalog.services.find(item=>item.name==='洁牙护理')
  await request('PUT',`/v1/admin/catalog/services/${service.id}`,admin.token,{...service,durationMinutes:60})
  const initialDoctor=catalog.doctors.find(item=>item.name==='李医生')
  const checkedDoctor=(await request('PUT',`/v1/admin/catalog/doctors/${encodeURIComponent(initialDoctor.id)}`,admin.token,{...initialDoctor,license:'Mock自测执业资料'})).entry
  const checked=await request('POST',`/v1/admin/catalog/doctors/${encodeURIComponent(initialDoctor.id)}/verify`,admin.token,{version:checkedDoctor.version,identityChecked:true,qualificationChecked:true,note:'Mock核验'})
  assert.equal(checked.doctors.find(item=>item.id===initialDoctor.id).mockVerified,true)
  await binary(`/v1/admin/content-media/avatar/${encodeURIComponent(initialDoctor.id)}`,admin.token)
  const dates=require('../../miniprogram/lib/appointments').bookableDates(),date=dates[0].key,next=dates[1].key
  for(const d of [date,next])await request('PUT','/v1/admin/schedules',admin.token,{doctor:'李医生',date:d,start:'09:00',end:'12:00',capacity:1,enabled:true,version:0})
  let appointment=(await request('POST','/v1/appointments',patient.token,{name:'测试成员',phone:'13800000000',memberId:member.id,doctor:'李医生',service:'洁牙护理',date,slot:'09:00',requestKey:'extended-booking'},201)).appointment
  assert.equal(appointment.durationMinutes,60)
  const available=(await request('GET',`/v1/availability?date=${date}&doctor=${encodeURIComponent('李医生')}&service=${encodeURIComponent('洁牙护理')}`,patient.token)).slots
  assert.equal(available.find(item=>item.time==='09:30').remaining,0);assert.equal(available.find(item=>item.time==='11:30').remaining,0)
  await request('POST','/v1/appointments',other.token,{name:'另一个测试成员',phone:'13900000000',doctor:'李医生',service:'初次口腔检查',date,slot:'09:30',requestKey:'overlap-booking'},409)
  const pending=(await request('POST',`/v1/appointments/${appointment.id}/reschedule-request`,patient.token,{date:next,slot:'10:00',reason:'调整时间',version:appointment.version,requestKey:'reschedule-request-key'},201)).request
  await request('POST',`/v1/reschedule-requests/${pending.id}`,doctor.token,{decision:'approve',note:'审核',version:1},403)
  const approved=await request('POST',`/v1/reschedule-requests/${pending.id}`,front.token,{decision:'approve',note:'已与患者确认新时段',version:1})
  assert.equal(approved.appointment.date,next);assert.equal(approved.appointment.status,'待确认')
  await request('POST',`/v1/reschedule-requests/${pending.id}`,front.token,{decision:'approve',note:'重复',version:1},409)
  let rules=await request('GET','/v1/booking-rules',admin.token)
  await request('PUT','/v1/admin/booking-rules',patient.token,{...rules,selfCheckIn:true},403)
  rules=await request('PUT','/v1/admin/booking-rules',admin.token,{...rules,selfCheckIn:true,confirmationMinutes:30})
  await request('PUT','/v1/admin/booking-rules',admin.token,{...rules,version:rules.version-1},409)
  direct=new DatabaseSync(dbPath);const today=new Date(Date.now()+8*3600000).toISOString().slice(0,10),slot=new Date(Date.now()+8*3600000).toISOString().slice(11,13)+':00'
  direct.prepare("UPDATE appointments SET date=?,slot=?,status='已预约',booking_version=booking_version+1 WHERE id=?").run(today,slot,appointment.id)
  const current=direct.prepare('SELECT booking_version FROM appointments WHERE id=?').get(appointment.id).booking_version
  const queue=await request('POST',`/v1/appointments/${appointment.id}/check-in`,patient.token,{version:current});assert.equal(queue.items.length,1)
  await request('POST',`/v1/appointments/${appointment.id}/check-in`,other.token,{version:current},403)
  const clinicQueue=await request('GET','/v1/waiting-queue?scope=clinic',front.token),queueRow=clinicQueue.items[0]
  await request('POST',`/v1/waiting-queue/${appointment.id}`,front.token,{version:queueRow.version,status:'called'})
  await request('POST',`/v1/waiting-queue/${appointment.id}`,front.token,{version:'stale',status:'done'},409)
  let row=direct.prepare('SELECT * FROM appointments WHERE id=?').get(appointment.id)
  appointment=(await request('PATCH',`/v1/appointments/${appointment.id}/status`,doctor.token,{version:row.booking_version,status:'就诊中'})).appointment
  appointment=(await request('PATCH',`/v1/appointments/${appointment.id}/status`,doctor.token,{version:appointment.version,status:'已完成'})).appointment
  const summary=(await request('PUT',`/v1/appointments/${appointment.id}/summary`,doctor.token,{version:0,findings:'测试检查',treatment:'测试处置',nextSteps:'测试后续',structured:{teeth:['11']}})).summary
  await request('POST',`/v1/appointments/${appointment.id}/summary-acknowledgment`,admin.token,{version:summary.version,name:'管理员',confirmed:true},403)
  const ack=await request('POST',`/v1/appointments/${appointment.id}/summary-acknowledgment`,doctor.token,{version:summary.version,name:'李医生',confirmed:true});assert.equal(ack.digest.length,64);assert.equal(ack.verified,true);assert.equal(require('node:crypto').verify(null,Buffer.from(ack.payload),ack.publicKey,Buffer.from(ack.signature,'base64')),true)
  const stage=await request('POST',`/v1/appointments/${appointment.id}/treatment-stages`,doctor.token,{title:'测试治疗阶段',note:'说明',dueDate:next,status:'planned'})
  await request('POST',`/v1/appointments/${appointment.id}/treatment-stages`,doctor.token,{...stage,dueDate:next,version:0},409)
  await request('POST',`/v1/appointments/${appointment.id}/tooth-states`,doctor.token,{tooth:'11',surface:'buccal',status:'monitoring',note:'测试',version:0})
  assert.equal((await request('GET',`/v1/appointments/${appointment.id}/treatment-stages?scope=mine`,patient.token)).teeth.length,1)
  await request('GET',`/v1/appointments/${appointment.id}/treatment-stages?scope=mine`,other.token,undefined,403)
  await request('POST','/v1/daily-habits',patient.token,{kind:'morning'});await request('POST','/v1/daily-habits',patient.token,{kind:'morning'});assert.equal((await request('GET','/v1/daily-habits',patient.token)).items.length,1)
  const doc=await request('POST','/v1/admin/privacy-document',admin.token,{title:'Mock告知',body:'Mock：用于测试告知版本',version:0,confirmed:true})
  await request('POST','/v1/privacy-consent',patient.token,{version:doc.document.version,accepted:false},400)
  assert.equal((await request('POST','/v1/privacy-consent',patient.token,{version:doc.document.version,accepted:true})).accepted,true)
  let article=(await request('POST','/v1/admin/articles',admin.token,{title:'百科测试',summary:'测试',body:'测试正文',categoryId:'daily-care',service:'洁牙护理',metadata:{kind:'disease',definition:'Mock定义',faq:[{question:'测试问题',answer:'测试回答'}]}},201)).article
  await request('POST',`/v1/articles/${article.id}/favorite`,patient.token,{selected:true},404)
  article=(await binary(`/v1/admin/content-media/article/${article.id}`,admin.token)).article
  await request('GET',`/v1/content-media/${article.media[0].id}`,patient.token,undefined,404)
  article=(await request('POST',`/v1/content-reviews/${article.id}`,admin.token,{version:article.version,decision:'submit'})).article
  article=(await request('POST',`/v1/content-reviews/${article.id}`,doctor.token,{version:article.version,decision:'approve',note:'测试通过'})).article
  article=(await request('POST',`/v1/admin/articles/${article.id}/status`,admin.token,{version:article.version,status:'published'})).article
  await request('POST',`/v1/articles/${article.id}/favorite`,patient.token,{selected:true});assert.equal((await request('GET','/v1/reading-library',patient.token)).total,1)
  await request('POST',`/v1/articles/${article.id}/activity`,patient.token,{kind:'read'});await request('POST',`/v1/articles/${article.id}/activity`,patient.token,{kind:'read'})
  assert.equal((await request('GET','/v1/admin/content-statistics',admin.token)).items.find(item=>item.id===article.id).reads,1)
  let screening=(await request('POST','/v1/screenings',patient.token,{memberId:member.id,location:'测试位置',duration:'测试时长',symptoms:'Mock症状',recentTreatment:'',requestKey:'screening-test'},201)).screening
  await request('POST',`/v1/screenings/${screening.id}/submit`,patient.token,{version:screening.version,captureConfirmed:true,modelConsent:true,qualityOverride:true},400)
  for(const angle of ['front','upper','lower','left','right'])screening=(await binary(`/v1/screenings/${screening.id}/photos?angle=${angle}`,patient.token)).screening
  await binary(`/v1/screenings/${screening.id}/photos?angle=front`,other.token,png,403)
  screening=(await request('POST',`/v1/screenings/${screening.id}/submit`,patient.token,{version:screening.version,captureConfirmed:true,modelConsent:true,qualityOverride:true})).screening
  assert.equal(screening.status,'awaiting_doctor');assert.equal(screening.model,undefined)
  const medical=(await request('GET',`/v1/screenings/${screening.id}?scope=clinic`,doctor.token)).screening;assert.equal(medical.model.model,'test-provider')
  await request('POST',`/v1/screenings/${screening.id}/review`,front.token,{version:medical.version,opinion:'test',annotations:[]},403)
  const reviewed=(await request('POST',`/v1/screenings/${screening.id}/review`,doctor.token,{version:medical.version,opinion:'仅功能验证',service:'初次口腔检查',annotations:[{angle:'front',label:'演示标注',x:0.1,y:0.1,width:0.2,height:0.2}]})).screening
  assert.equal(reviewed.review.annotations.length,1);assert.equal((await request('GET',`/v1/screenings/${screening.id}`,patient.token)).screening.review.opinion,'仅功能验证')
  await request('GET','/v1/admin/system',patient.token,undefined,403)
  const backup=await request('POST','/v1/admin/backups',admin.token,{},201);assert.equal(backup.backups.length,1)
  assert.equal((await request('POST',`/v1/admin/backups/${backup.backups[0].id}/verify`,admin.token,{})).verified,true)
  await request('GET','/v1/admin/audit',front.token,undefined,403)
  assert.ok((await request('GET','/v1/admin/audit',admin.token)).total>10)
  const audit=new DatabaseSync(path.join(dir,'security-audit.sqlite'));try{assert.throws(()=>audit.exec('DELETE FROM audit_events'),/append only/)}finally{audit.close()}
  const series=(await request('POST',`/v1/appointments/${appointment.id}/recall-series`,doctor.token,{dueDate:next,instructions:'Mock周期复查',intervalDays:180})).items
  const recallNode=series[0];assert.equal(recallNode.intervalDays,180)
  let nodeVisit=(await request('POST','/v1/appointments',patient.token,{name:'测试成员',phone:'13800000000',memberId:member.id,doctor:'李医生',service:'洁牙护理',date:next,slot:'11:00',recallNodeId:recallNode.nodeId,recallVersion:recallNode.version,requestKey:'multi-recall-visit'},201)).appointment
  assert.equal(nodeVisit.recallId,appointment.id)
  for(const status of ['已预约','已到店','已完成'])nodeVisit=(await request('PATCH',`/v1/appointments/${nodeVisit.id}/status`,status==='已完成'?doctor.token:admin.token,{status,version:nodeVisit.version,communicationNote:'自测复查确认'})).appointment
  assert.equal((await request('GET',`/v1/appointments/${appointment.id}/recall-series?scope=mine`,patient.token)).items.length,2)
  // Shared equipment and closures affect every doctor, not just one start slot.
  const resources=await request('POST','/v1/admin/resources',admin.token,{name:'测试影像设备',capacity:1,enabled:true})
  const equipment=resources.resources[0]
  await request('POST','/v1/admin/resource-services',admin.token,{service:'洁牙护理',resourceIds:[equipment.id],version:0})
  await request('PUT','/v1/admin/schedules',admin.token,{doctor:'周医生',date:next,start:'09:00',end:'12:00',capacity:1,enabled:true,version:0})
  const equipmentBooking=(await request('POST','/v1/appointments',patient.token,{name:'测试成员',phone:'13800000000',memberId:member.id,doctor:'李医生',service:'洁牙护理',date:next,slot:'09:00',requestKey:'equipment-booking'},201)).appointment
  await request('POST','/v1/appointments',other.token,{name:'其他成员',phone:'13900000000',doctor:'周医生',service:'洁牙护理',date:next,slot:'09:30',requestKey:'equipment-overlap'},409)
  await request('PATCH',`/v1/appointments/${equipmentBooking.id}/status`,patient.token,{status:'已取消',version:equipmentBooking.version})
  const closureDate=dates[2].key
  await request('PUT','/v1/admin/schedules',admin.token,{doctor:'李医生',date:closureDate,start:'09:00',end:'12:00',capacity:1,enabled:true,version:0})
  await request('POST','/v1/admin/closures',admin.token,{date:closureDate,doctor:'李医生',reason:'测试停诊',enabled:true,version:0})
  assert.ok((await request('GET',`/v1/availability?date=${closureDate}&doctor=${encodeURIComponent('李医生')}`,patient.token)).slots.every(item=>item.remaining===0))
  const staffPatientVisit=(await request('POST','/v1/appointments',doctor.token,{name:'医生本人Mock预约',phone:'13700000000',doctor:'周医生',service:'初次口腔检查',date:next,slot:'10:00',requestKey:'staff-patient-visit'},201)).appointment
  await request('PATCH',`/v1/appointments/${staffPatientVisit.id}/status`,doctor.token,{status:'已取消',version:staffPatientVisit.version,scope:'clinic'},403)
  await request('PATCH',`/v1/appointments/${staffPatientVisit.id}/status`,doctor.token,{status:'已取消',version:staffPatientVisit.version,scope:'mine',cancellationReason:'自测患者端取消'})
  // Original articles are owned by a real doctor account, still independently reviewed.
  let original=(await request('POST','/v1/doctor/articles',doctor.token,{title:'测试原创',summary:'Mock',body:'仅自测',categoryId:'daily-care',service:''},201)).article
  assert.equal(original.metadata.authorId,doctor.profile.id)
  await request('GET',`/v1/doctor/articles/${original.id}`,patient.token,undefined,403)
  original=(await request('POST',`/v1/content-reviews/${original.id}`,doctor.token,{version:original.version,decision:'submit'})).article
  await request('POST',`/v1/content-reviews/${original.id}`,doctor.token,{version:original.version,decision:'approve',note:'本人'},403)
  await request('POST',`/v1/content-reviews/${original.id}`,admin.token,{version:original.version,decision:'approve',note:'测试通过'})
  const recipeData={service:'初次口腔检查',title:'测试自动流程',nodes:[{title:'第1天',instructions:'Mock护理说明',offsetDays:1},{title:'阶段后节点',instructions:'Mock阶段说明',offsetDays:3,releaseDays:2,triggerStage:'自测完成阶段'}],enabled:true,automaticPublish:true,version:0}
  let recipe=(await request('POST','/v1/care-recipes',doctor.token,recipeData)).items[0]
  recipe=(await request('POST',`/v1/care-recipes/${recipe.id}/review`,doctor.token,{version:recipe.version,decision:'submit'})).items[0]
  await request('POST',`/v1/care-recipes/${recipe.id}/review`,doctor.token,{version:recipe.version,decision:'approve',note:'本人'},403)
  recipe=(await request('POST',`/v1/care-recipes/${recipe.id}/review`,admin.token,{version:recipe.version,decision:'approve',note:'Mock流程通过'})).items[0]
  let generatedVisit=(await request('POST','/v1/appointments',patient.token,{name:'测试成员',phone:'13800000000',memberId:member.id,doctor:'李医生',service:'初次口腔检查',date:next,slot:'10:00',requestKey:'generated-plan-visit'},201)).appointment
  for(const status of ['已预约','已到店','已完成'])generatedVisit=(await request('PATCH',`/v1/appointments/${generatedVisit.id}/status`,status==='已完成'?doctor.token:admin.token,{status,version:generatedVisit.version,communicationNote:'自测确认'})).appointment
  let plan=(await request('GET','/v1/care-plans?scope=clinic',doctor.token)).plans.find(item=>item.appointmentId===generatedVisit.id)
  assert.equal(plan.nodes.length,2);assert.equal(plan.nodes.filter(node=>node.status==='scheduled').length,1);assert.equal(plan.status,'active')
  plan=(await request('POST',`/v1/care-plans/${plan.id}/manage`,doctor.token,{version:plan.version,action:'append',node:{title:'第2天',instructions:'Mock追加说明',dueDate:next}})).plan
  assert.equal(plan.nodes.length,3)
  plan=(await request('POST',`/v1/care-plans/${plan.id}/manage`,doctor.token,{version:plan.version,action:'pause'})).plan;assert.equal(plan.status,'paused')
  plan=(await request('POST',`/v1/care-plans/${plan.id}/manage`,doctor.token,{version:plan.version,action:'resume'})).plan;assert.equal(plan.status,'active');assert.equal(plan.nodes.filter(node=>node.status==='scheduled').length,1)
  await request('POST',`/v1/appointments/${generatedVisit.id}/treatment-stages`,doctor.token,{title:'自测完成阶段',note:'Mock阶段完成',dueDate:next,status:'completed'})
  const auto=require('../care-automation').createCareAutomation(direct,require('../catalog').createCatalog(direct),null);assert.equal(auto.release(next),1)
  plan=(await request('GET',`/v1/care-plans/${plan.id}?scope=clinic`,doctor.token)).plan;assert.equal(plan.nodes.filter(node=>node.status==='scheduled').length,0)
  plan=(await request('POST',`/v1/care-plans/${plan.id}/manage`,doctor.token,{version:plan.version,action:'archive'})).plan;assert.equal(plan.status,'archived')
  let template=(await request('POST','/v1/care-templates',doctor.token,{name:'自测单任务模板',title:'自测节点',instructions:'Mock说明',service:'初次口腔检查',feedbackDays:1,enabled:true,requestKey:'single-template-test'},201)).template
  assert.equal(template.reviewStatus,'draft')
  await request('POST',`/v1/care-templates/${template.id}/review`,doctor.token,{version:template.version,decision:'submit'})
  await request('POST',`/v1/care-templates/${template.id}/review`,doctor.token,{version:template.version,decision:'approve',note:'本人'},403)
  template=(await request('POST',`/v1/care-templates/${template.id}/review`,admin.token,{version:template.version,decision:'approve',note:'Mock审核通过'})).template;assert.equal(template.reviewStatus,'approved')
  // Cash records are idempotent; refund totals cannot exceed receipts.
  const bill={kind:'receipt',cents:10000,method:'cash',reason:'Mock实际收款登记',confirmed:true,requestKey:'billing-test'}
  await request('POST',`/v1/appointments/${appointment.id}/billing`,doctor.token,bill,403)
  await request('POST',`/v1/appointments/${appointment.id}/billing`,front.token,bill)
  assert.equal((await request('POST',`/v1/appointments/${appointment.id}/billing`,front.token,bill)).entries.length,1)
  await request('POST',`/v1/appointments/${appointment.id}/billing`,admin.token,{...bill,kind:'refund',cents:10001,requestKey:'over-refund'},409)
  const billView=await request('POST',`/v1/appointments/${appointment.id}/billing`,admin.token,{...bill,kind:'refund',cents:2500,requestKey:'refund-test'});assert.equal(billView.balanceCents,7500)
  await request('GET',`/v1/appointments/${appointment.id}/billing?scope=mine`,other.token,undefined,403)
  // Part 2 is a distinct authenticated archive; old export deletion cascades all volumes.
  for(let index=0;index<3;index++){const pdf=Buffer.alloc(600000,32);pdf.write('%PDF-1.4');pdf.write('%%EOF',pdf.length-5);await binary(`/v1/appointments/${appointment.id}/attachments?kind=${encodeURIComponent('检查单')}&name=part-${index}.pdf&requestKey=part-file-${index}`,doctor.token,pdf)}
  let exportRequest=(await request('POST','/v1/privacy-requests',patient.token,{kind:'export',memberId:member.id,details:'自测分卷导出',requestKey:'volume-export'},201)).request
  exportRequest=(await request('PATCH',`/v1/privacy-requests/${exportRequest.id}`,admin.token,{version:exportRequest.version,status:'processing',note:'自测受理'})).request
  exportRequest=(await request('PATCH',`/v1/privacy-requests/${exportRequest.id}`,admin.token,{version:exportRequest.version,status:'completed',note:'自测办理',confirmed:true})).request
  assert.ok(exportRequest.parts.length>=3)
  const secondPart=await fetch(base+`/v1/privacy-requests/${exportRequest.id}/download?part=2`,{headers:{authorization:`Bearer ${patient.token}`}});assert.equal(secondPart.status,200);assert.equal(Buffer.from(await secondPart.arrayBuffer()).subarray(0,2).toString(),'PK')
  await request('GET',`/v1/privacy-requests/${exportRequest.id}/download?part=2`,other.token,undefined,403)
  const triageTask=(await request('POST','/v1/care-tasks',doctor.token,{appointmentId:appointment.id,title:'Mock人工分级',instructions:'自测说明',dueDate:today,requestKey:'triage-task'},201)).task
  await request('POST',`/v1/care-tasks/${triageTask.id}/feedback`,patient.token,{pain:'明显疼痛',bleeding:false,swelling:false,note:'Mock反馈'})
  await request('POST',`/v1/care-tasks/${triageTask.id}/triage`,front.token,{version:0,priority:'urgent',destination:'admin',hours:2,note:'内部说明'},403)
  await request('POST',`/v1/care-tasks/${triageTask.id}/triage`,doctor.token,{version:0,priority:'urgent',destination:'admin',hours:2,note:'Mock内部说明'})
  const ownTasks=(await request('GET','/v1/care-tasks?scope=mine',patient.token)).tasks;assert.equal(ownTasks.find(task=>task.id===triageTask.id).triage,undefined)
  direct.prepare('UPDATE care_triage SET deadline=? WHERE task_id=?').run(new Date(Date.now()-60000).toISOString(),triageTask.id)
  assert.equal((await request('GET','/v1/worklist',admin.token)).worklist.items.find(item=>item.taskId===triageTask.id).priorityLabel,'处理超时，升级管理员')
  let removal=(await request('POST','/v1/record-requests',patient.token,{appointmentId:appointment.id,kind:'deletion',details:'自测删除扩展记录',requestKey:'extended-deletion'},201)).request
  removal=(await request('PATCH',`/v1/record-requests/${removal.id}`,admin.token,{version:removal.version,status:'processing',note:'自测核验'})).request
  removal=(await request('PATCH',`/v1/record-requests/${removal.id}`,admin.token,{version:removal.version,status:'completed',note:'自测执行',confirmed:true})).request
  assert.equal(removal.status,'completed');assert.equal(direct.prepare('SELECT COUNT(*) total FROM care_triage').get().total,0);assert.equal(direct.prepare('SELECT COUNT(*) total FROM treatment_stages WHERE appointment_id=?').get(appointment.id).total,0)
  assert.equal(direct.prepare('SELECT COUNT(*) total FROM summary_acknowledgments WHERE appointment_id=?').get(appointment.id).total,0)
  assert.equal(direct.prepare('SELECT COUNT(*) total FROM privacy_export_parts WHERE request_id=?').get(exportRequest.id).total,0)
  assert.equal((await request('GET','/v1/admin/system',admin.token)).backups.length,0)
  console.log('PASS: duration overlap, reschedule approval, check-in/queue, clinical stages/tooth access, author acknowledgment, habits, consent versions, media/review/favorites/history, provider isolation/review annotations, shared equipment/closures, clinician originals, approved automatic/staged recipes, plan lifecycle, recurring recall nodes, receipts/refund limits, multi-volume exports, deletion cleanup, signatures, backups and independent audit')
 }finally{if(direct)direct.close();if(child.exitCode===null){const closed=once(child,'exit');child.kill();await closed}await new Promise(resolve=>provider.close(resolve));fs.rmSync(dir,{recursive:true,force:true})}
}
main().catch(error=>{console.error(error);process.exitCode=1})
