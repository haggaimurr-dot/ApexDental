const {randomUUID}=require('node:crypto')
const {fail,transaction,text,validDate}=require('./archive-common')
function createBilling(db){
 db.exec(`CREATE TABLE IF NOT EXISTS billing_entries(id TEXT PRIMARY KEY,appointment_id TEXT NOT NULL,kind TEXT NOT NULL,cents INTEGER NOT NULL,method TEXT NOT NULL,reason TEXT NOT NULL,actor TEXT NOT NULL,request_key TEXT NOT NULL UNIQUE,created_at TEXT NOT NULL);
 CREATE TABLE IF NOT EXISTS billing_events(id INTEGER PRIMARY KEY,entry_id TEXT NOT NULL,actor TEXT NOT NULL,snapshot TEXT NOT NULL,created_at TEXT NOT NULL);`)
 function cashier(user){if(!user.isStaff||!['admin','frontdesk'].includes(user.role))fail(403,'仅管理员或前台可登记实际收款')}
 function balance(id){const row=db.prepare("SELECT COALESCE(SUM(CASE WHEN kind='receipt' THEN cents ELSE -cents END),0) cents FROM billing_entries WHERE appointment_id=?").get(id);return row.cents}
 function list(user,id,scope){const visit=db.prepare('SELECT * FROM appointments WHERE id=?').get(id);if(!visit)fail(404,'预约不存在');if(scope==='clinic')cashier(user);else if(visit.owner_id!==user.id)fail(403,'仅预约管理人可查看费用记录');return {entries:db.prepare('SELECT id,kind,cents,method,reason,created_at FROM billing_entries WHERE appointment_id=? ORDER BY created_at,id').all(id),balanceCents:balance(id),appointmentId:id,onlinePaymentConfigured:false}}
 function save(user,id,body){
  cashier(user);if(!['receipt','refund'].includes(body?.kind)||!Number.isSafeInteger(body.cents)||body.cents<1||body.cents>100000000||!['cash','card','transfer','offline-wechat'].includes(body.method))fail(400,'收款类型、金额或方式无效')
  if(body.kind==='refund'&&user.role!=='admin')fail(403,'退款登记需管理员操作');const reason=text(body.reason,1000,'收款/退款说明'),key=text(body.requestKey,100,'请求标识')
  if(body.confirmed!==true)fail(400,'请确认已实际收款或退款，此处不执行转账')
  return transaction(db,()=>{const visit=db.prepare('SELECT * FROM appointments WHERE id=?').get(id);if(!visit)fail(404,'预约不存在');const old=db.prepare('SELECT * FROM billing_entries WHERE request_key=?').get(key);if(old){if(old.appointment_id!==id||old.actor!==user.id||old.kind!==body.kind||old.cents!==body.cents||old.method!==body.method||old.reason!==reason)fail(409,'请求标识已用于其他收款内容');return list(user,id,'clinic')}
   if(body.kind==='refund'&&body.cents>balance(id))fail(409,'退款不能超过已登记净收款');const entryId=randomUUID(),now=new Date().toISOString();db.prepare('INSERT INTO billing_entries VALUES(?,?,?,?,?,?,?,?,?)').run(entryId,id,body.kind,body.cents,body.method,reason,user.id,key,now);db.prepare('INSERT INTO billing_events(entry_id,actor,snapshot,created_at) VALUES(?,?,?,?)').run(entryId,user.id,JSON.stringify({appointmentId:id,kind:body.kind,cents:body.cents,method:body.method}),now);return list(user,id,'clinic')})
 }
 function statistics(user,params){if(!user.isStaff||user.role!=='admin')fail(403,'仅管理员可查看收款统计');const from=params.get('from'),to=params.get('to');if(!validDate(from)||!validDate(to)||from>to||Date.parse(to)-Date.parse(from)>89*86400000)fail(400,'请选择最多90天的有效日期范围');const rows=db.prepare('SELECT appointment_id,kind,cents,created_at FROM billing_entries').all().filter(row=>{const day=new Date(Date.parse(row.created_at)+8*3600000).toISOString().slice(0,10);return day>=from&&day<=to}),receipts=rows.filter(row=>row.kind==='receipt').reduce((sum,row)=>sum+row.cents,0),refunds=rows.filter(row=>row.kind==='refund').reduce((sum,row)=>sum+row.cents,0),visits=new Set(rows.filter(row=>row.kind==='receipt').map(row=>row.appointment_id)).size;return {from,to,receiptCents:receipts,refundCents:refunds,netCents:receipts-refunds,payingVisits:visits,averageReceiptCents:visits?Math.round(receipts/visits):null,note:'按实际登记时间统计，客单价按有收款的就诊数计算；此处不执行支付或退款'}}
 return {list,save,statistics}
}
module.exports={createBilling}
