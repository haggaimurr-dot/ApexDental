const assert=require('node:assert/strict')
const api=require('../../miniprogram/lib/api')
const features=require('../../miniprogram/lib/record-features-page')
const records=require('../../miniprogram/lib/patient-records-page')
let definition,removed=[],previews=[]
global.Page=value=>{definition=value}
global.wx={getFileSystemManager:()=>({unlink:options=>removed.push(options.filePath)}),previewImage:options=>previews.push(options),openDocument:()=>{},shareFileMessage:()=>{}}
require('../../miniprogram/pages/index/index')
const tap=dataset=>({currentTarget:{dataset}})
function page(){const instance={...records,...features,data:structuredClone(definition.data),setData(values){Object.assign(this.data,values)},goHome(){this.data.page='home'}};instance.data.profile={id:'owner',role:'patient'};instance.data.authReady=true;instance.clearPatientRecord();return instance}
function deferred(){let resolve;const promise=new Promise(done=>{resolve=done});return{resolve,promise}}
async function main(){
  const instance=page()
  instance.data.patientRecord={member:{id:'member',mayManage:true},summaries:[{appointmentId:'visit',structured:{teeth:['36','55'],diagnosis:'已记录'}}]}
  instance.data.recordAlbum=[{id:'left',source:'record',angle:'局部',tooth:'36'},{id:'right',source:'record',angle:'局部',tooth:'36'},{id:'third',source:'record',angle:'局部',tooth:'36'},{id:'pending',source:'care',angle:'未标注'}]
  instance.buildToothChart();assert.equal(instance.data.toothRows.flatMap(row=>row.teeth).length,32)
  assert.equal(instance.data.toothRows.flatMap(row=>row.teeth).find(row=>row.id==='36').hasRecord,true)
  instance.dentitionChange(tap({value:'child'}));assert.equal(instance.data.toothRows.flatMap(row=>row.teeth).length,20)
  instance.selectTooth(tap({tooth:'55'}));assert.equal(instance.data.toothTreatments.length,1)
  instance.dentitionChange(tap({value:'mixed'}));assert.equal(instance.data.toothRows.flatMap(row=>row.teeth).length,52)
  instance.toggleComparePhoto(tap({id:'pending'}));assert.equal(instance.data.compareSelected.length,0)
  instance.toggleComparePhoto(tap({id:'left'}));instance.toggleComparePhoto(tap({id:'right'}));instance.toggleComparePhoto(tap({id:'third'}));assert.equal(instance.data.compareSelected.length,2)
  instance.data.page='patient-record'
  api.photoComparison=async()=>({comparison:{left:{id:'left',angle:'局部'},right:{id:'right',angle:'局部'}}})
  api.downloadRecordPhoto=async id=>'/tmp/'+id
  await instance.compareRecordPhotos();assert.equal(instance.data.photoComparison.leftUrl,'/tmp/left')
  instance.compareZoomChange(tap({delta:'5'}));assert.equal(instance.data.compareZoom,3)
  api.photoComparison=async()=>{throw new Error('请选择同角度照片')}
  await instance.compareRecordPhotos();assert.equal(instance.data.photoComparison,null);assert.equal(instance.data.patientRecordError,'请选择同角度照片')
  const old=deferred();api.questionnaire=()=>old.promise
  const loading=instance.showQuestionnaire();instance.clearRecordFeatures();instance.data.profile={id:'other',role:'patient'};instance.data.page='home'
  old.resolve({versions:[{version:1,answers:{allergies:'private'},createdAt:'2026-10-02T01:00:00Z'}]});await loading;assert.equal(instance.data.healthEditor,null)
  const answers={allergies:'无',medications:'无',conditions:'无',previousReactions:'无',chiefComplaint:'检查',bleedingHistory:null,pregnant:null,tobacco:'unknown'}
  api.questionnaire=async()=>({versions:[{version:1,answers,createdAt:'2026-10-02T01:00:00Z'}]})
  instance.data.patientRecord={member:{id:'member',mayManage:false}}
  await instance.showQuestionnaire();instance.questionnaireInput({...tap({field:'allergies'}),detail:{value:'偷偷修改'}});assert.equal(instance.data.healthEditor.answers.allergies,'无')
  let saves=0;api.saveQuestionnaire=async()=>{saves++}
  await instance.saveHealthQuestionnaire();assert.equal(saves,0)
  instance.data.patientRecord.member.mayManage=true;await instance.showQuestionnaire()
  instance.questionnaireInput({...tap({field:'bleedingHistory'}),detail:{value:'false'}});assert.equal(instance.data.healthEditor.answers.bleedingHistory,false)
  instance.questionnaireInput({...tap({field:'consent'}),detail:{value:true}});assert.equal(instance.data.healthConsent,true)
  api.saveQuestionnaire=async()=>{throw new Error('请先核验监护关系')}
  await instance.saveHealthQuestionnaire();assert.equal(instance.data.featureError,'请先核验监护关系');assert.equal(instance.data.healthEditor.version,1)
  // Authorized downloads are re-requested and discarded after an identity switch.
  instance.featureContext('record-attachments','',{id:'visit'})
  const downloading=deferred();api.downloadRecordFile=()=>downloading.promise
  const file=instance.openPrivateFile('/v1/record-attachments/file','image/png')
  instance.clearRecordFeatures();instance.data.profile={id:'new-user'};instance.data.page='home'
  downloading.resolve('/tmp/stale-attachment');await file;assert.ok(removed.includes('/tmp/stale-attachment'));assert.equal(previews.length,0)
  instance.data.tab='patient';instance.data.patientRecord={member:{id:'member',mayManage:false}}
  instance.startPrivacyRequest(tap({kind:'export'}));assert.equal(instance.data.privacyEditor,null)
  instance.data.patientRecord.member.mayManage=true
  api.privacyRequests=async()=>({items:[],hasMore:false})
  await instance.startPrivacyRequest(tap({kind:'export'}))
  const sending=deferred();let submissions=0
  api.submitPrivacyRequest=()=>{submissions++;return sending.promise}
  const submit=instance.submitPrivacy();instance.submitPrivacy();assert.equal(submissions,1)
  instance.clearRecordFeatures();instance.data.page='home';sending.resolve({});await submit;assert.equal(instance.data.privacyItems.length,0)
  instance.data.tab='clinic';instance.data.profile={id:'doctor',role:'doctor'}
  instance.showGuardianAdmin();instance.showPrivacyRequests();instance.showRecordLogs();assert.equal(instance.data.page,'home')
  console.log('PASS: adult/child/mixed dentition, per-tooth history, comparison selection and bounds, questionnaire ownership, guardian errors, private-file cleanup, rights gates and stale responses')
}
main().catch(error=>{console.error(error);process.exitCode=1})
