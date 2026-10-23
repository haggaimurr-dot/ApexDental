const assert=require('node:assert/strict'),{DatabaseSync}=require('node:sqlite'),{createCatalog}=require('../catalog')
const prior=process.env.APEX_DEMO_AUTH,db=new DatabaseSync(':memory:')
try{
 process.env.APEX_DEMO_AUTH='0';const catalog=createCatalog(db),admin={id:'verification-admin',role:'admin',isStaff:true}
 assert.equal(catalog.entries('doctors').length,0)
 const doctor=catalog.save(admin,'doctors',{name:'资质核验测试医生',title:'自测',license:'test-license-only',specialties:'自测',introduction:'仅用于隔离检查',serviceNames:[],enabled:true})
 assert.equal(catalog.permits(doctor.name,'初次口腔检查'),false)
 assert.throws(()=>catalog.verify({id:'patient',role:'patient',isStaff:false},doctor.id,{version:doctor.version}),error=>error.status===403)
 assert.throws(()=>catalog.verify(admin,doctor.id,{version:doctor.version,note:'自测',identityChecked:false,qualificationChecked:true}),error=>error.status===400)
 catalog.verify(admin,doctor.id,{version:doctor.version,note:'仅核验流程自测',identityChecked:true,qualificationChecked:true})
 assert.equal(catalog.permits(doctor.name,'初次口腔检查'),true)
 const updated=catalog.save(admin,'doctors',{...doctor,introduction:'已变更介绍'},doctor.id)
 assert.equal(catalog.permits(updated.name,'初次口腔检查'),false)
 assert.throws(()=>catalog.verify(admin,updated.id,{version:doctor.version,note:'旧版本',identityChecked:true,qualificationChecked:true}),error=>error.status===409)
 const mock=catalog.save(admin,'doctors',{...doctor,id:undefined,version:0,name:'测试医生（Mock）',license:'Mock：虚构执业资料'})
 assert.throws(()=>catalog.verify(admin,mock.id,{version:mock.version,note:'Mock',identityChecked:true,qualificationChecked:true}),error=>error.status===400)
 assert.ok(db.prepare('SELECT COUNT(*) count FROM catalog_check_events').get().count>0)
 console.log('PASS: non-demo booking requires current verification, changes invalidate verification, role/version checks, and fictional credentials cannot receive formal verification')
}finally{db.close();if(prior===undefined)delete process.env.APEX_DEMO_AUTH;else process.env.APEX_DEMO_AUTH=prior}
