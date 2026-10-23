const {fail,transaction}=require('./archive-common')
function createIdentityVerification(db){
 db.prepare("UPDATE guardian_checks SET external_pending=0,version=version+1,external_result_json=? WHERE external_pending=1").run(JSON.stringify({result:'unknown',reference:'',note:'外部核对被中断，可由诊所重新核对'}))
 async function query(user,id,body){
  if(!user.isStaff||user.role!=='admin')fail(403,'仅管理员可调用外部身份核对')
  const row=db.prepare('SELECT * FROM guardian_checks WHERE id=?').get(id)
  if(!row)fail(404,'核验材料不存在');if(row.owner_id===user.id)fail(403,'不能核验本人提交的材料')
  if(row.status!=='submitted'||row.version!==body?.version||row.external_pending)fail(409,'材料已处理、变更或正在核对')
  if(!row.bytes)fail(410,'核验材料已清理');if(!row.external_consent)fail(403,'申请人尚未同意外部身份核对')
  const address=process.env.APEX_IDENTITY_URL;if(!address||!process.env.APEX_IDENTITY_KEY)fail(503,'外部身份服务尚未配置，可继续诊所人工核验')
  const url=new URL(address);if(url.protocol!=='https:'&&!(process.env.APEX_DEMO_AUTH==='1'&&url.protocol==='http:'&&['127.0.0.1','localhost'].includes(url.hostname)))fail(503,'外部身份服务须使用HTTPS')
  const claimed=db.prepare('UPDATE guardian_checks SET external_pending=1,version=version+1 WHERE id=? AND version=? AND external_pending=0').run(id,row.version);if(claimed.changes!==1)fail(409,'外部核对已由其他人员发起')
  let result
  try{const response=await fetch(address,{method:'POST',signal:AbortSignal.timeout(10000),headers:{'content-type':'application/json',authorization:`Bearer ${process.env.APEX_IDENTITY_KEY}`,'idempotency-key':`${id}:${row.version}`},body:JSON.stringify({schemaVersion:1,checkId:id,guardianName:row.guardian_name,relationship:row.relationship,memberBirthDate:row.birth_date,evidence:{mime:row.mime,base64:Buffer.from(row.bytes).toString('base64')}})});const raw=await response.text();if(!response.ok||Buffer.byteLength(raw)>16384)throw Error('invalid response');const parsed=JSON.parse(raw);if(!['match','mismatch','unknown'].includes(parsed.result)||typeof parsed.reference!=='string'||parsed.reference.length>200)throw Error('invalid response');result={result:parsed.result,reference:parsed.reference,note:'外部辅助结果；监护关系及办理结果仍需诊所人工核验'}}catch{result={result:'unknown',reference:'',note:'外部服务未完成核对，可继续人工核验或重试'}}
  return transaction(db,()=>{const current=db.prepare('SELECT * FROM guardian_checks WHERE id=?').get(id);if(!current||current.version!==row.version+1||current.status!=='submitted')fail(409,'材料已由其他人员处理，外部结果不覆盖办理状态');db.prepare('UPDATE guardian_checks SET external_pending=0,external_result_json=?,version=version+1,updated_at=? WHERE id=?').run(JSON.stringify(result),new Date().toISOString(),id);db.prepare('INSERT INTO guardian_events(check_id,action,actor_id,note,created_at) VALUES(?,?,?,?,?)').run(id,'external-verification',user.id,`外部核对：${result.result}；参考号：${result.reference}`,new Date().toISOString());return {result,version:row.version+2,approved:false}})
 }
 function consent(user,id,body){if(typeof body?.selected!=='boolean')fail(400,'外部核对授权选项无效');return transaction(db,()=>{const row=db.prepare('SELECT * FROM guardian_checks WHERE id=?').get(id);if(!row||row.owner_id!==user.id)fail(403,'仅材料提交人可维护此授权');if(row.version!==body.version)fail(409,'核验材料已更新，请刷新');db.prepare('UPDATE guardian_checks SET external_consent=?,external_pending=0,version=version+1,updated_at=? WHERE id=?').run(Number(body.selected),new Date().toISOString(),id);db.prepare('INSERT INTO guardian_events(check_id,action,actor_id,note,created_at) VALUES(?,?,?,?,?)').run(id,'external-consent',user.id,body.selected?'提交人同意外部辅助核对':'提交人撤回外部辅助核对授权',new Date().toISOString());return {selected:body.selected,version:row.version+1}})}
 return {query,consent}
}
module.exports={createIdentityVerification}
