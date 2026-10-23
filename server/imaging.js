const sharp=require('sharp'),dicomParser=require('dicom-parser')
const {fail}=require('./archive-common')
const limitInputPixels=16*1024*1024
async function imageQuality(bytes){
 try{
  const metadata=await sharp(bytes,{limitInputPixels}).metadata()
  const {data,info}=await sharp(bytes,{limitInputPixels}).resize(128,128,{fit:'fill'}).removeAlpha().toColourspace('b-w').raw().toBuffer({resolveWithObject:true})
  let sum=0,lap=0,count=0;for(const value of data)sum+=value
  for(let y=1;y<info.height-1;y++)for(let x=1;x<info.width-1;x++){const i=y*info.width+x,v=data[i-1]+data[i+1]+data[i-info.width]+data[i+info.width]-4*data[i];lap+=v*v;count++}
  const brightness=sum/data.length,detail=count?lap/count:0,issues=[]
  if(metadata.width<320||metadata.height<240)issues.push('图片尺寸过小')
  if(brightness<25)issues.push('图片整体偏暗');if(brightness>240)issues.push('图片整体过亮');if(detail<20)issues.push('图片细节不足，请检查是否模糊')
  return {width:metadata.width,height:metadata.height,brightness:Math.round(brightness),detail:Math.round(detail),issues,needsRetake:issues.length>0,note:'基于尺寸、整体亮度与细节的通用检查，不能识别口腔拍摄角度或判断病情'}
 }catch{fail(400,'图片不能完整解码，请重新拍摄或选择JPEG/PNG')}
}
async function registerImages(left,right){
 const decoded=await Promise.all([left,right].map(bytes=>sharp(bytes,{limitInputPixels}).resize(96,96,{fit:'fill'}).removeAlpha().toColourspace('b-w').raw().toBuffer()))
 const [a,b]=decoded;let best={score:-2,dx:0,dy:0},second=-2
 for(let dy=-12;dy<=12;dy++)for(let dx=-12;dx<=12;dx++){
  let sa=0,sb=0,saa=0,sbb=0,sab=0,n=0
  for(let y=14;y<82;y+=2)for(let x=14;x<82;x+=2){const av=a[y*96+x],bv=b[(y+dy)*96+x+dx];sa+=av;sb+=bv;saa+=av*av;sbb+=bv*bv;sab+=av*bv;n++}
  const variance=(saa-sa*sa/n)*(sbb-sb*sb/n),score=variance>1?(sab-sa*sb/n)/Math.sqrt(variance):-2
  if(score>best.score){second=best.score;best={score,dx,dy}}else second=Math.max(second,score)
 }
 const reliable=best.score>=0.65&&best.score-second>0.001
 return {dx:reliable?-best.dx/96*100:0,dy:reliable?-best.dy/96*100:0,confidence:Math.max(0,best.score).toFixed(3),reliable,method:'归一化相关平移',note:reliable?'已估计平移，请人工核对；未校正旋转、透视及拍摄比例差异':'图像匹配不足，保留原图。请使用人工并排对比'}
}
async function renderDicom(bytes,query){
 let dataSet;try{dataSet=dicomParser.parseDicom(new Uint8Array(bytes))}catch{fail(422,'无法解析此DICOM，请使用诊所阅片软件查看')}
 const syntax=dataSet.string('x00020010');if(!['1.2.840.10008.1.2','1.2.840.10008.1.2.1'].includes(syntax))fail(422,'当前预览支持未压缩小端DICOM；此传输语法请使用专业阅片软件')
 const rows=dataSet.uint16('x00280010'),columns=dataSet.uint16('x00280011'),bits=dataSet.uint16('x00280100'),stored=dataSet.uint16('x00280101'),high=dataSet.uint16('x00280102'),samples=dataSet.uint16('x00280002'),signed=dataSet.uint16('x00280103'),photo=dataSet.string('x00280004')?.trim(),frames=Number(dataSet.string('x00280008')||1)
 if(!rows||!columns||rows*columns>limitInputPixels||![8,16].includes(bits)||!stored||stored>bits||high!==stored-1||samples!==1||![0,1].includes(signed)||!['MONOCHROME1','MONOCHROME2'].includes(photo)||!Number.isSafeInteger(frames)||frames<1||frames>256)fail(422,'当前预览不支持此像素格式或尺寸')
 const frame=Number(query.get('frame')||0);if(!Number.isSafeInteger(frame)||frame<0||frame>=frames)fail(400,'影像帧号无效')
 const pixel=dataSet.elements.x7fe00010,size=rows*columns*(bits/8),offset=pixel?.dataOffset+size*frame
 if(!pixel||offset+size>bytes.length||pixel.length<size*frames)fail(422,'像素数据不完整')
 const slope=Number(dataSet.string('x00281053')||1),intercept=Number(dataSet.string('x00281052')||0)
 if(!Number.isFinite(slope)||!Number.isFinite(intercept)||!slope)fail(422,'像素转换参数无效')
 const values=new Float64Array(rows*columns),mask=2**stored-1;let min=Infinity,max=-Infinity
 for(let i=0;i<values.length;i++){let value=(bits===8?bytes[offset+i]:bytes.readUInt16LE(offset+i*2))&mask;if(signed&&value>=2**(stored-1))value-=2**stored;value=value*slope+intercept;values[i]=value;min=Math.min(min,value);max=Math.max(max,value)}
 const center=query.has('center')?Number(query.get('center')):Number(dataSet.string('x00281050')?.split('\\')[0]||(min+max)/2),width=query.has('width')?Number(query.get('width')):Number(dataSet.string('x00281051')?.split('\\')[0]||Math.max(1,max-min))
 if(!Number.isFinite(center)||!Number.isFinite(width)||width<1||width>1e9)fail(400,'窗宽窗位参数无效')
 const raw=Buffer.alloc(values.length),inverse=photo==='MONOCHROME1'
 for(let i=0;i<values.length;i++){const value=width===1?(values[i]>center-0.5?255:0):Math.max(0,Math.min(255,((values[i]-(center-0.5))/(width-1)+0.5)*255));raw[i]=Math.round(inverse?255-value:value)}
 return {bytes:await sharp(raw,{raw:{width:columns,height:rows,channels:1}}).png().toBuffer(),rows,columns,frames,frame,center,width,note:'资料预览，保留原文件；未实现专业诊断工作站功能'}
}
module.exports={imageQuality,registerImages,renderDicom}
