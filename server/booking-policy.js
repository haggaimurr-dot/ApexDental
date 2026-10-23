const { randomUUID } = require('node:crypto')
const { validDate } = require('./schedules')
function fail(status,message){const e=new Error(message);e.status=status;throw e}
const localDay=()=>new Date(Date.now()+8*3600000).toISOString().slice(0,10)
const appointmentTime=row=>Date.parse(`${row.date}T${row.slot}:00+08:00`)
function createBookingPolicy(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS booking_rules (id INTEGER PRIMARY KEY CHECK(id=1),payload TEXT NOT NULL,version INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS booking_rule_events (id INTEGER PRIMARY KEY,actor TEXT NOT NULL,payload TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS reschedule_requests (id TEXT PRIMARY KEY,appointment_id TEXT NOT NULL,owner_id TEXT NOT NULL,payload TEXT NOT NULL,status TEXT NOT NULL,version INTEGER NOT NULL,note TEXT NOT NULL DEFAULT '',created_at TEXT NOT NULL,reviewed_by TEXT NOT NULL DEFAULT '',request_key TEXT NOT NULL UNIQUE);
    CREATE UNIQUE INDEX IF NOT EXISTS pending_reschedule ON reschedule_requests(appointment_id) WHERE status='pending';
    CREATE TABLE IF NOT EXISTS waiting_queue (appointment_id TEXT PRIMARY KEY,day TEXT NOT NULL,number INTEGER NOT NULL,status TEXT NOT NULL,updated_at TEXT NOT NULL,UNIQUE(day,number));`)
  db.prepare('INSERT OR IGNORE INTO booking_rules VALUES(1,?,1)').run(JSON.stringify({cancelHours:0,rescheduleHours:0,confirmationMinutes:0,selfCheckIn:false,checkInBeforeMinutes:60,checkInAfterMinutes:120,waitingMinutes:15}))
  function admin(user){if(!user.isStaff||user.role!=='admin')fail(403,'仅管理员可维护预约规则')}
  function staff(user){if(!user.isStaff||!['admin','frontdesk'].includes(user.role))fail(403,'仅管理员或前台可管理候诊和改期申请')}
  function rules(){const row=db.prepare('SELECT * FROM booking_rules WHERE id=1').get();return {recallAheadDays:0,reminderHour:9,visitDayHours:24,visitSoonHours:2,...JSON.parse(row.payload),version:row.version}}
  function save(user,body){
    admin(user);const current=rules();if(body?.version!==current.version)fail(409,'规则已变更，请刷新')
    const values={}
    for(const [field,min,max] of [['cancelHours',0,168],['rescheduleHours',0,168],['confirmationMinutes',0,1440],['checkInBeforeMinutes',0,1440],['checkInAfterMinutes',0,1440],['waitingMinutes',1,120]]){
      if(!Number.isSafeInteger(body[field])||body[field]<min||body[field]>max)fail(400,'预约规则数值超出范围');values[field]=body[field]
    }
    for(const [field,max,fallback] of [['recallAheadDays',30,0],['reminderHour',23,9],['visitDayHours',168,24],['visitSoonHours',24,2]]){const value=body[field]===undefined?fallback:body[field];if(!Number.isSafeInteger(value)||value<0||value>max)fail(400,'提醒时间规则无效');values[field]=value}
    if(values.visitDayHours<=values.visitSoonHours||values.visitSoonHours<1)fail(400,'前一天提醒窗口须大于临近提醒窗口')
    if(typeof body.selfCheckIn!=='boolean')fail(400,'签到开关无效');values.selfCheckIn=body.selfCheckIn
    db.exec('BEGIN IMMEDIATE');try{
      const changed=db.prepare('UPDATE booking_rules SET payload=?,version=version+1 WHERE id=1 AND version=?').run(JSON.stringify(values),body.version)
      if(changed.changes!==1)fail(409,'规则已变更')
      db.prepare('INSERT INTO booking_rule_events(actor,payload,created_at) VALUES(?,?,?)').run(user.id,JSON.stringify({before:current,after:values}),new Date().toISOString())
      db.exec('COMMIT');return rules()
    }catch(e){db.exec('ROLLBACK');throw e}
  }
  function deadline(row,kind){const hours=rules()[kind==='cancel'?'cancelHours':'rescheduleHours'];if(hours&&appointmentTime(row)-Date.now()<hours*3600000)fail(409,`已超过${kind==='cancel'?'取消':'改期'}截止时间，请联系诊所`)}
  function submit(user,id,body){
    if(!body || typeof body.requestKey!=='string'||!body.requestKey||body.requestKey.length>100||!validDate(body.date)||!/^([01]\d|2[0-3]):(00|30)$/.test(body.slot||'')||typeof body.reason!=='string'||body.reason.trim().length<2||body.reason.length>500)fail(400,'改期申请内容无效')
    db.exec('BEGIN IMMEDIATE');try{
      const row=db.prepare('SELECT * FROM appointments WHERE id=?').get(id)
      if(!row||row.owner_id!==user.id)fail(403,'只有预约管理人可申请改期')
      const payload=JSON.stringify({date:body.date,slot:body.slot,reason:body.reason.trim(),version:body.version})
      const old=db.prepare('SELECT * FROM reschedule_requests WHERE request_key=?').get(body.requestKey)
      if(old){if(old.owner_id!==user.id||old.appointment_id!==id||old.payload!==payload)fail(409,'请求标识已使用');db.exec('COMMIT');return view(old)}
      if(!['待确认','已预约'].includes(row.status)||row.booking_version!==body.version)fail(409,'预约已变更，请刷新')
      if(row.date===body.date&&row.slot===body.slot)fail(400,'请选择其他时段');deadline(row,'reschedule')
      if(db.prepare("SELECT 1 FROM reschedule_requests WHERE appointment_id=? AND status='pending'").get(id))fail(409,'已有待审核改期申请')
      const requestId=randomUUID();db.prepare("INSERT INTO reschedule_requests(id,appointment_id,owner_id,payload,status,version,created_at,request_key) VALUES(?,?,?,?,'pending',1,?,?)").run(requestId,id,user.id,payload,new Date().toISOString(),body.requestKey)
      db.exec('COMMIT');return view(db.prepare('SELECT * FROM reschedule_requests WHERE id=?').get(requestId))
    }catch(e){db.exec('ROLLBACK');throw e}
  }
  function view(row){return {id:row.id,appointmentId:row.appointment_id,...JSON.parse(row.payload),status:row.status,requestVersion:row.version,note:row.note,createdAt:row.created_at}}
  function list(user,scope){if(scope==='clinic')staff(user);return db.prepare(`SELECT * FROM reschedule_requests ${scope==='clinic'?'':'WHERE owner_id=?'} ORDER BY created_at DESC LIMIT 100`).all(...(scope==='clinic'?[]:[user.id])).map(view)}
  function review(user,id,body,rescheduling){
    staff(user);if(!['approve','reject'].includes(body?.decision)||typeof body.note!=='string'||!body.note.trim()||body.note.length>1000)fail(400,'请填写审核结果与说明')
    db.exec('BEGIN IMMEDIATE');try{
      const row=db.prepare('SELECT * FROM reschedule_requests WHERE id=?').get(id)
      if(!row)fail(404,'改期申请不存在');if(row.version!==body.version||row.status!=='pending')fail(409,'申请已处理，请刷新')
      let appointment
      if(body.decision==='approve')appointment=rescheduling.save(user,row.appointment_id,{...JSON.parse(row.payload),scope:'clinic',requestKey:`request:${id}`},true).appointment
      db.prepare('UPDATE reschedule_requests SET status=?,version=version+1,note=?,reviewed_by=? WHERE id=?').run(body.decision==='approve'?'approved':'rejected',body.note.trim(),user.id,id)
      db.exec('COMMIT');return {request:view(db.prepare('SELECT * FROM reschedule_requests WHERE id=?').get(id)),appointment}
    }catch(e){db.exec('ROLLBACK');throw e}
  }
  function checkIn(user,id,version){
    db.exec('BEGIN IMMEDIATE');try{
      const row=db.prepare('SELECT * FROM appointments WHERE id=?').get(id)
      if(!row||row.owner_id!==user.id)fail(403,'只有预约管理人可签到')
      if(row.status==='已到店'&&db.prepare('SELECT 1 FROM waiting_queue WHERE appointment_id=?').get(id)){db.exec('COMMIT');return queue(user,'mine')}
      const rule=rules(), delta=(Date.now()-appointmentTime(row))/60000
      if(!rule.selfCheckIn)fail(409,'诊所未开放自助签到')
      if(row.status!=='已预约'||row.booking_version!==version||row.date!==localDay()||delta< -rule.checkInBeforeMinutes||delta>rule.checkInAfterMinutes)fail(409,'当前不在签到时间范围内或预约已变更')
      const now=new Date().toISOString()
      db.prepare("UPDATE appointments SET status='已到店',booking_version=booking_version+1,updated_at=? WHERE id=?").run(now,id)
      db.prepare("INSERT INTO events(appointment_id,from_status,to_status,actor,created_at) VALUES(?,'已预约','已到店',?,?)").run(id,user.id,now)
      enqueue(id)
      db.exec('COMMIT');return queue(user,'mine')
    }catch(e){db.exec('ROLLBACK');throw e}
  }
  function enqueue(id){const day=localDay(),number=db.prepare('SELECT COALESCE(MAX(number),0)+1 next FROM waiting_queue WHERE day=?').get(day).next;db.prepare("INSERT OR IGNORE INTO waiting_queue VALUES(?,?,?,'waiting',?)").run(id,day,number,new Date().toISOString())}
  function queue(user,scope){
    if(scope==='clinic'&&!user.isStaff)fail(403,'仅诊所员工可查看候诊队列')
    const rows=db.prepare(`SELECT q.*,a.patient,a.doctor,a.owner_id FROM waiting_queue q JOIN appointments a ON a.id=q.appointment_id WHERE q.day=? ${scope==='clinic'?(user.role==='doctor'?'AND a.doctor=?':''):'AND a.owner_id=?'} ORDER BY q.number`).all(localDay(),...(scope==='clinic'?(user.role==='doctor'?[user.doctorName]:[]):[user.id]))
    return {items:rows.map(row=>({appointmentId:row.appointment_id,number:row.number,status:row.status,version:row.updated_at,doctor:row.doctor,...(scope==='clinic'?{patient:row.patient}:{}),ahead:db.prepare("SELECT COUNT(*) total FROM waiting_queue WHERE day=? AND number<? AND status IN ('waiting','called')").get(localDay(),row.number).total})),estimatedMinutesPerPerson:rules().waitingMinutes,note:'预计时间按人数估算，以实际接诊为准'}
  }
  function call(user,id,body){staff(user);if(!['called','waiting','done'].includes(body?.status))fail(400,'候诊操作无效');const row=db.prepare('SELECT * FROM waiting_queue WHERE appointment_id=? AND day=?').get(id,localDay());if(!row)fail(404,'候诊记录不存在');if(row.updated_at!==body.version)fail(409,'候诊记录已变更');db.prepare('UPDATE waiting_queue SET status=?,updated_at=? WHERE appointment_id=?').run(body.status,new Date().toISOString(),id);return queue(user,'clinic')}
  function expire(){
    const minutes=rules().confirmationMinutes;if(!minutes)return 0
    db.exec('BEGIN IMMEDIATE');try{const rows=db.prepare("SELECT * FROM appointments WHERE status='待确认' AND updated_at<=?").all(new Date(Date.now()-minutes*60000).toISOString());for(const row of rows){const now=new Date().toISOString();db.prepare("UPDATE appointments SET status='已取消',booking_version=booking_version+1,updated_at=? WHERE id=?").run(now,row.id);db.prepare("INSERT INTO events(appointment_id,from_status,to_status,actor,created_at) VALUES(?,'待确认','已取消','system:confirmation-expiry',?)").run(row.id,now)}db.exec('COMMIT');return rows.length}catch(e){db.exec('ROLLBACK');throw e}
  }
  return {rules,save,deadline,submit,list,review,checkIn,enqueue,queue,call,expire}
}
module.exports={createBookingPolicy,appointmentTime}
