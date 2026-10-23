const assert=require('node:assert/strict'),http=require('node:http'),crypto=require('node:crypto'),{DatabaseSync}=require('node:sqlite'),{once}=require('node:events')
const {createBilling}=require('../billing'),{createPayments}=require('../payments')
async function main(){
 const names=['APEX_PAYMENT_URL','APEX_PAYMENT_KEY','APEX_PAYMENT_CALLBACK_SECRET','APEX_DEMO_AUTH'],previous=Object.fromEntries(names.map(name=>[name,process.env[name]])),db=new DatabaseSync(':memory:')
 db.exec("CREATE TABLE appointments(id TEXT PRIMARY KEY,owner_id TEXT NOT NULL);CREATE TABLE users(id TEXT PRIMARY KEY,subject TEXT NOT NULL);INSERT INTO appointments VALUES('visit','patient');INSERT INTO users VALUES('patient','demo:payment-test')")
 const billing=createBilling(db),payments=createPayments(db),cashier={id:'cashier',role:'frontdesk',isStaff:true},patient={id:'patient',role:'patient',isStaff:false}
 const gateway=http.createServer(async(req,res)=>{let body='';for await(const chunk of req)body+=chunk;const payload=JSON.parse(body);assert.equal(payload.cents,1234);assert.equal(req.headers['idempotency-key'],payload.invoiceId);res.setHeader('content-type','application/json');res.end(JSON.stringify({params:{timeStamp:String(Math.floor(Date.now()/1000)),nonceStr:'mock-nonce',package:'prepay_id=mock-prepay',signType:'RSA',paySign:'mock-signature-for-tests-only'}}))})
 try{
  delete process.env.APEX_PAYMENT_URL;delete process.env.APEX_PAYMENT_KEY;delete process.env.APEX_PAYMENT_CALLBACK_SECRET
  const invoice=payments.invoice(cashier,'visit',{cents:1234,description:'Mock费用',requestKey:'invoice-test'}).invoices[0]
  assert.equal(payments.list(patient,'visit','mine').configured,false)
  await assert.rejects(payments.intent(patient,invoice.id,{version:invoice.version}),error=>error.status===503)
  await assert.rejects(payments.intent({id:'other'},invoice.id,{version:invoice.version}),error=>error.status===403)
  gateway.listen(0,'127.0.0.1');await once(gateway,'listening');process.env.APEX_PAYMENT_URL=`http://127.0.0.1:${gateway.address().port}`;process.env.APEX_PAYMENT_KEY='mock-key';process.env.APEX_PAYMENT_CALLBACK_SECRET='mock-secret-with-more-than-32-characters';process.env.APEX_DEMO_AUTH='1'
  const intent=await payments.intent(patient,invoice.id,{version:invoice.version});assert.equal(intent.paid,false);assert.equal(billing.list(patient,'visit','mine').balanceCents,0)
  const event={eventId:'event-1',invoiceId:invoice.id,transactionId:'mock-transaction-1',cents:1234,status:'paid'}
  function headers(body,when=Math.floor(Date.now()/1000)){const timestamp=String(when);return {'x-apex-timestamp':timestamp,'x-apex-signature':crypto.createHmac('sha256',process.env.APEX_PAYMENT_CALLBACK_SECRET).update(timestamp+'.'+JSON.stringify(body)).digest('hex')}}
  assert.throws(()=>payments.callback({},event),error=>error.status===401)
  assert.throws(()=>payments.callback(headers(event,1),event),error=>error.status===401)
  const wrong={...event,cents:1233};assert.throws(()=>payments.callback(headers(wrong),wrong),error=>error.status===409)
  assert.equal(payments.callback(headers(event),event).recorded,true)
  assert.equal(billing.list(patient,'visit','mine').balanceCents,1234)
  assert.equal(payments.callback(headers(event),event).recorded,false)
  assert.equal(billing.list(patient,'visit','mine').entries.length,1)
  const conflicting={...event,transactionId:'another-transaction'};assert.throws(()=>payments.callback(headers(conflicting),conflicting),error=>error.status===409)
  assert.equal((await payments.intent(patient,invoice.id,{version:1})).paid,true)
  console.log('PASS: invoice ownership, disabled payment state, idempotent gateway contract, no payment from client success, callback signatures/time/amount checks and duplicate-credit prevention')
 }catch(error){throw error}finally{if(gateway.listening)await new Promise(resolve=>gateway.close(resolve));db.close();for(const name of names)if(previous[name]===undefined)delete process.env[name];else process.env[name]=previous[name]}
}
main().catch(error=>{console.error(error);process.exitCode=1})
