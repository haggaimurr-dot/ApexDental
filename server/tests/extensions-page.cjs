const assert=require('node:assert/strict')
const api=require('../../miniprogram/lib/api'),mixin=require('../../miniprogram/lib/extensions-page')
let definition;global.Page=value=>definition=value;global.wx={getFileSystemManager:()=>({unlink(){}}),showToast(){}}
require('../../miniprogram/pages/index/index')
const deferred=()=>{let resolve,reject;const promise=new Promise((yes,no)=>{resolve=yes;reject=no});return {promise,resolve,reject}}
function page(){const result={...mixin,data:{...structuredClone(definition.data),authReady:true,profile:{id:'patient',role:'patient'},tab:'patient',page:'home'},setData(update){for(const [key,value] of Object.entries(update)){const fields=key.split('.');let target=this.data;for(const field of fields.slice(0,-1))target=target[field];target[fields.at(-1)]=value}},refreshRemote(){return Promise.resolve()}};result.clearExtensions();return result}
async function main(){
 const p=page(),old=deferred(),latest=deferred();let requests=0
 api.featureRequest=()=>++requests===1?old.promise:latest.promise
 const first=p.showExtension({currentTarget:{dataset:{section:'library'}}}),second=p.libraryKind({currentTarget:{dataset:{kind:'history'}}})
 latest.resolve({items:[{id:'latest'}],page:1,hasMore:false});await second;old.resolve({items:[{id:'old'}],page:1,hasMore:false});await first;assert.equal(p.data.extItems[0].id,'latest')
 const delayed=deferred();api.featureRequest=()=>delayed.promise;const inFlight=p.loadExtension();p.clearExtensions();p.data.profile={id:'other',role:'patient'};delayed.resolve({items:[{id:'private-old'}]});await inFlight;assert.deepEqual(p.data.extItems,[])
 p.data.page='extensions';p.data.extSection='habits';const pending=deferred();let writes=0;api.featureRequest=(method)=>{if(method==='POST'){writes++;return pending.promise}return Promise.resolve({items:[]})}
 const saving=p.checkHabit({currentTarget:{dataset:{kind:'morning'}}});p.checkHabit({currentTarget:{dataset:{kind:'morning'}}});assert.equal(writes,1);assert.equal(p.data.extBusy,true);pending.resolve({items:[]});await saving;assert.equal(p.data.extBusy,false)
 p.data.extAnnotationImage={angle:'front',path:'image'};p.data.extAnnotationEditor={x:10,y:20,width:30,height:40,label:'自测区域'};p.addScreeningAnnotation();assert.deepEqual(p.data.extAnnotations[0],{angle:'front',label:'自测区域',x:0.1,y:0.2,width:0.3,height:0.4})
 p.data.extAnnotationEditor={x:90,y:20,width:30,height:40,label:'越界'};p.addScreeningAnnotation();assert.equal(p.data.extAnnotations.length,1)
 p.data.extSection='billing';p.data.extVisitId='visit';p.data.extPrivacyAccepted=true;p.data.extEditor={amount:'12.34',kind:'receipt',method:'cash',reason:'自测',requestKey:'test-key'};let posted
 api.featureRequest=(method,path,body)=>{if(method==='POST')posted=body;return Promise.resolve({entries:[],balanceCents:1234})};await p.saveBilling();assert.equal(posted.cents,1234);assert.equal(posted.confirmed,true)
 p.data.extEditor.amount='12.345';await p.saveBilling();assert.match(p.data.extError,/两位小数/)
 console.log('PASS: extension stale lists/account reset, duplicate-click prevention, annotations bounds, and exact money conversion')
}
main().catch(error=>{console.error(error);process.exitCode=1})
