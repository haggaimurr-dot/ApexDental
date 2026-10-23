const {randomUUID}=require('node:crypto')
const {fail,text,transaction}=require('./archive-common')
function createScreening(db,catalog,guardians,photoTypes){
  db.exec(`CREATE TABLE IF NOT EXISTS screening_cases(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL,member_id TEXT NOT NULL,questionnaire TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,model_json TEXT NOT NULL DEFAULT '{}',review_json TEXT NOT NULL DEFAULT '{}',reviewer TEXT NOT NULL DEFAULT '',request_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS screening_images(id TEXT PRIMARY KEY,case_id TEXT NOT NULL,angle TEXT NOT NULL,mime TEXT NOT NULL,bytes BLOB NOT NULL,created_at TEXT NOT NULL,UNIQUE(case_id,angle));
    CREATE TABLE IF NOT EXISTS screening_events(id INTEGER PRIMARY KEY,case_id TEXT NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL);`)
  if(!db.prepare('PRAGMA table_info(screening_images)').all().some(row=>row.name==='quality_json'))db.exec("ALTER TABLE screening_images ADD COLUMN quality_json TEXT NOT NULL DEFAULT '{}'")
  db.prepare("UPDATE screening_cases SET status='awaiting_doctor',model_json=?,version=version+1 WHERE status='analyzing'").run(JSON.stringify({enabled:false,failed:true,note:'分析中断，资料转人工复核'}))
  const angles=['front','upper','lower','left','right']
  function medical(user){if(!user.isStaff||!['admin','doctor'].includes(user.role))fail(403,'仅医生或管理员可复核初筛')}
  function access(user,id,clinic=false){const row=db.prepare('SELECT * FROM screening_cases WHERE id=?').get(id);if(!row)fail(404,'初筛记录不存在');if(clinic)medical(user);else if(row.owner_id!==user.id)fail(403,'无权查看此初筛');return row}
  function view(row,clinic){const images=db.prepare('SELECT id,angle,mime,quality_json FROM screening_images WHERE case_id=? ORDER BY angle').all(row.id);return {id:row.id,memberId:row.member_id,questionnaire:JSON.parse(row.questionnaire),status:row.status,version:row.version,createdAt:row.created_at,images:images.map(row=>({id:row.id,angle:row.angle,mime:row.mime,quality:JSON.parse(row.quality_json)})),review:row.status==='reviewed'?JSON.parse(row.review_json):null,...(clinic?{model:JSON.parse(row.model_json),reviewer:row.reviewer}:{})}}
  function start(user,body){
    if(typeof body?.memberId!=='string'||!body.memberId||body.memberId.length>100)fail(400,'成员标识无效')
    const member=db.prepare('SELECT * FROM family_members WHERE id=? AND owner_id=? AND enabled=1').get(body?.memberId,user.id);if(!member)fail(403,'请选择本人管理的有效成员');guardians.requireVerified(user,member.id)
    const questionnaire={location:text(body.location,200,'关注位置'),duration:text(body.duration,200,'持续时间'),symptoms:text(body.symptoms,1000,'症状说明'),recentTreatment:text(body.recentTreatment||'',1000,'近期治疗',true)}
    const key=text(body.requestKey,100,'请求标识'),serialized=JSON.stringify(questionnaire)
    return transaction(db,()=>{const old=db.prepare('SELECT * FROM screening_cases WHERE request_key=?').get(key);if(old){if(old.owner_id!==user.id||old.member_id!==member.id||old.questionnaire!==serialized)fail(409,'请求标识已使用');return view(old,false)}const id=randomUUID();db.prepare("INSERT INTO screening_cases(id,owner_id,member_id,questionnaire,status,version,request_key,created_at) VALUES(?,?,?,?,'draft',1,?,?)").run(id,user.id,member.id,serialized,key,new Date().toISOString());return view(access(user,id),false)})
  }
  async function upload(user,id,angle,req){
    const row=access(user,id);if(row.status!=='draft'||!angles.includes(angle))fail(409,'当前不能上传此角度')
    const chunks=[];let total=0;for await(const chunk of req){total+=chunk.length;if(total>3*1024*1024)fail(413,'照片不能超过3 MB');chunks.push(chunk)}const bytes=Buffer.concat(chunks),mime=photoTypes.imageType(bytes),quality=await require('./imaging').imageQuality(bytes)
    return transaction(db,()=>{const current=access(user,id);if(current.status!=='draft')fail(409,'初筛已提交');const imageId=randomUUID();db.prepare('INSERT INTO screening_images(id,case_id,angle,mime,bytes,created_at,quality_json) VALUES(?,?,?,?,?,?,?) ON CONFLICT(case_id,angle) DO UPDATE SET id=excluded.id,mime=excluded.mime,bytes=excluded.bytes,created_at=excluded.created_at,quality_json=excluded.quality_json').run(imageId,id,angle,mime,bytes,new Date().toISOString(),JSON.stringify(quality));db.prepare('UPDATE screening_cases SET version=version+1 WHERE id=?').run(id);return view(access(user,id),false)})
  }
  async function submit(user,id,body){
    const row=access(user,id);if(row.status!=='draft'||row.version!==body?.version)fail(409,'初筛已更新');guardians.requireVerified(user,row.member_id)
    const images=db.prepare('SELECT * FROM screening_images WHERE case_id=?').all(id);if(images.length!==angles.length||body.captureConfirmed!==true)fail(400,'请完成五个角度拍摄并确认清晰、光线及口腔完整')
    if(images.some(image=>JSON.parse(image.quality_json).needsRetake)&&body.qualityOverride!==true)fail(400,'部分照片质量检查未通过，请重拍，或由用户明确确认已人工核对')
    const url=process.env.APEX_SCREENING_URL
    if(url && body.modelConsent!==true)fail(400,'需主动同意照片和问卷提交已配置模型服务')
    const changed=db.prepare("UPDATE screening_cases SET status='analyzing',version=version+1 WHERE id=? AND version=? AND status='draft'").run(id,row.version);if(changed.changes!==1)fail(409,'初筛已变更')
    let model={enabled:false,note:'未配置模型服务，进入人工复核'},status='awaiting_doctor'
    if(url){try{
      const parsed=new URL(url);if(parsed.protocol!=='https:'&&!(process.env.APEX_DEMO_AUTH==='1'&&parsed.protocol==='http:'&&['127.0.0.1','localhost'].includes(parsed.hostname)))throw Error('Provider URL must use HTTPS')
      const response=await fetch(url,{method:'POST',signal:AbortSignal.timeout(15000),headers:{'content-type':'application/json',...(process.env.APEX_SCREENING_KEY?{authorization:`Bearer ${process.env.APEX_SCREENING_KEY}`}:{})},body:JSON.stringify({schemaVersion:1,questionnaire:JSON.parse(row.questionnaire),images:images.map(image=>({angle:image.angle,mime:image.mime,base64:Buffer.from(image.bytes).toString('base64')}))})})
      const raw=await response.text();if(!response.ok||Buffer.byteLength(raw)>32768)throw Error('invalid response');const result=JSON.parse(raw)
      if(!Array.isArray(result.concerns)||result.concerns.length>20||result.concerns.some(item=>typeof item!=='string'||item.length>1000))throw Error('invalid model output')
      model={enabled:true,model:typeof result.model==='string'?result.model.slice(0,100):'configured-provider',concerns:result.concerns,quality:typeof result.quality==='string'?result.quality.slice(0,2000):'未返回质量评估',reviewRequired:true}
    }catch{model={enabled:true,failed:true,note:'模型请求失败，保留原始资料供医生人工复核'}}}
    transaction(db,()=>{db.prepare('UPDATE screening_cases SET status=?,model_json=?,version=version+1 WHERE id=? AND status=\'analyzing\'').run(status,JSON.stringify(model),id);db.prepare('INSERT INTO screening_events(case_id,actor,action,snapshot,created_at) VALUES(?,?,?,?,?)').run(id,user.id,'submitted',JSON.stringify({modelEnabled:!!url}),new Date().toISOString())})
    return view(access(user,id),false)
  }
  function list(user,clinic){if(clinic)medical(user);const rows=db.prepare(`SELECT * FROM screening_cases ${clinic?"WHERE status IN ('awaiting_doctor','reviewed')":'WHERE owner_id=?'} ORDER BY created_at DESC LIMIT 100`).all(...(clinic?[]:[user.id]));return {items:rows.map(row=>view(row,clinic)),configured:!!process.env.APEX_SCREENING_URL}}
  function detail(user,id,clinic){return view(access(user,id,clinic),clinic)}
  function image(user,id,clinic){const row=db.prepare('SELECT * FROM screening_images WHERE id=?').get(id);if(!row)fail(404,'照片不存在');access(user,row.case_id,clinic);return row}
  function review(user,id,body){
    medical(user);const opinion=text(body?.opinion,3000,'复核意见'),service=body.service||''
    if(service&&!catalog.names('services').includes(service))fail(400,'推荐项目无效')
    if(!Array.isArray(body.annotations)||body.annotations.length>30)fail(400,'标注数量无效')
    return transaction(db,()=>{const row=access(user,id,true);if(row.status!=='awaiting_doctor'||row.version!==body.version)fail(409,'此初筛已处理或更新');if(row.owner_id===user.id)fail(403,'不能复核本人提交的初筛');const annotations=body.annotations.map(item=>{if(!angles.includes(item.angle)||typeof item.label!=='string'||!item.label.trim()||item.label.length>200||['x','y','width','height'].some(key=>!Number.isFinite(item[key])||item[key]<0||item[key]>1)||item.x+item.width>1||item.y+item.height>1)fail(400,'图片标注无效');return {angle:item.angle,label:item.label,x:item.x,y:item.y,width:item.width,height:item.height}});const agreement=body.modelAgreement||'unknown';if(!['agree','disagree','unknown'].includes(agreement))fail(400,'模型评价选项无效');const result={opinion,service,annotations,modelAgreement:JSON.parse(row.model_json).enabled?agreement:'unknown',reviewerName:user.displayName||user.doctorName,reviewedAt:new Date().toISOString()};db.prepare("UPDATE screening_cases SET status='reviewed',version=version+1,review_json=?,reviewer=? WHERE id=?").run(JSON.stringify(result),user.id,id);db.prepare('INSERT INTO screening_events(case_id,actor,action,snapshot,created_at) VALUES(?,?,?,?,?)').run(id,user.id,'reviewed',JSON.stringify(result),new Date().toISOString());return detail(user,id,true)})
  }
  function statistics(user){if(!user.isStaff||user.role!=='admin')fail(403,'仅管理员可查看初筛统计');const rows=db.prepare('SELECT status,model_json,review_json FROM screening_cases').all();return {total:rows.length,awaiting:rows.filter(row=>row.status==='awaiting_doctor').length,reviewed:rows.filter(row=>row.status==='reviewed').length,modelUsed:rows.filter(row=>JSON.parse(row.model_json).enabled).length,modelFailed:rows.filter(row=>JSON.parse(row.model_json).failed).length,bookings:db.prepare("SELECT COUNT(*) total FROM appointments WHERE screening_case_id<>''").get().total,agreement:['agree','disagree','unknown'].map(kind=>({kind,count:rows.filter(row=>row.status==='reviewed'&&(JSON.parse(row.review_json).modelAgreement||'unknown')===kind).length})),note:'模型评价来自医生人工选择，不是自动计算的诊断准确率；提交数为当前保留记录的总量'}}
  return {start,upload,submit,list,detail,image,review,statistics}
}
module.exports={createScreening}
