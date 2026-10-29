const sharp=require('sharp');
const {zipSync,unzipSync,strToU8}=require('fflate');
const {createHash}=require('node:crypto');
const TYPES={png:'image/png',jpeg:'image/jpeg',webp:'image/webp',bmp:'image/bmp',tiff:'image/tiff',gif:'image/gif',avif:'image/avif',sb3:'application/x.scratch.sb3'};
const EXT={jpeg:'jpg',tiff:'tiff'};
async function encodeImage(png,format) {
  if(!TYPES[format]||format==='sb3')throw Error('Unsupported image encoding');
  const image=sharp(png,{limitInputPixels:16000000});
  if(format!=='bmp') {
    const result=await image.toFormat(format).toBuffer();
    const decoded=await sharp(result,{limitInputPixels:16000000}).metadata();
    if(decoded.format!==format && !(format==='avif'&&decoded.format==='heif'&&decoded.compression==='av1'))throw Error('Output format verification failed');
    return result;
  }
  const {data,info}=await image.flatten({background:'#ffffff'}).removeAlpha().raw().toBuffer({resolveWithObject:true});
  const stride=Math.ceil(info.width*3/4)*4,size=54+stride*info.height;
  const bmp=Buffer.alloc(size);bmp.write('BM');bmp.writeUInt32LE(size,2);bmp.writeUInt32LE(54,10);bmp.writeUInt32LE(40,14);
  bmp.writeInt32LE(info.width,18);bmp.writeInt32LE(info.height,22);bmp.writeUInt16LE(1,26);bmp.writeUInt16LE(24,28);bmp.writeUInt32LE(size-54,34);
  for(let y=0;y<info.height;y++)for(let x=0;x<info.width;x++) {
    const i=(y*info.width+x)*3,j=54+(info.height-1-y)*stride+x*3;
    bmp[j]=data[i+2];bmp[j+1]=data[i+1];bmp[j+2]=data[i];
  }
  return bmp;
}
const md5=bytes=>createHash('md5').update(bytes).digest('hex'); // Scratch asset addressing, not authentication.
async function scratchProject(png,motion) {
  const costume=await sharp(png).resize(160,160,{fit:'inside'}).png().toBuffer();
  const background=await sharp({create:{width:480,height:360,channels:3,background:'#ffffff'}}).png().toBuffer();
  const blocks={flag:{opcode:'event_whenflagclicked',next:motion==='walk'?'forever':null,parent:null,inputs:{},fields:{},shadow:false,topLevel:true,x:30,y:30}};
  if(motion==='walk')Object.assign(blocks,{
    forever:{opcode:'control_forever',next:null,parent:'flag',inputs:{SUBSTACK:[2,'move']},fields:{},shadow:false,topLevel:false},
    move:{opcode:'motion_movesteps',next:'bounce',parent:'forever',inputs:{STEPS:[1,[4,'5']]},fields:{},shadow:false,topLevel:false},
    bounce:{opcode:'motion_ifonedgebounce',next:'wait',parent:'move',inputs:{},fields:{},shadow:false,topLevel:false},
    wait:{opcode:'control_wait',next:null,parent:'bounce',inputs:{DURATION:[1,[4,'0.08']]},fields:{},shadow:false,topLevel:false},
  });
  const c=(bytes,name)=>({assetId:md5(bytes),name,md5ext:md5(bytes)+'.png',dataFormat:'png',bitmapResolution:1,rotationCenterX:name==='Backdrop'?240:80,rotationCenterY:name==='Backdrop'?180:80});
  const shared={variables:{},lists:{},broadcasts:{},comments:{},currentCostume:0,sounds:[],volume:100};
  const project={targets:[{...shared,isStage:true,name:'Stage',blocks:{},costumes:[c(background,'Backdrop')],tempo:60,videoTransparency:50,videoState:'on',textToSpeechLanguage:null,layerOrder:0},
    {...shared,isStage:false,name:'Generated sprite',blocks,costumes:[c(costume,'Costume')],visible:true,x:0,y:0,size:100,direction:90,draggable:false,rotationStyle:'left-right',layerOrder:1}],monitors:[],extensions:[],meta:{semver:'3.0.0',vm:'0.2.0',agent:'MundusX artifact generator'}};
  const result=Buffer.from(zipSync({'project.json':strToU8(JSON.stringify(project)),[md5(costume)+'.png']:costume,[md5(background)+'.png']:background}));
  await validateScratch(result,motion);
  return result;
}
async function validateScratch(bytes,motion,runVM=false) {
  const files=unzipSync(bytes);const project=JSON.parse(Buffer.from(files['project.json']).toString());
  if(project.targets.length!==2||!project.targets[0].isStage)throw Error('Invalid Scratch targets');
  for(const t of project.targets)for(const c of t.costumes)if(!files[c.md5ext])throw Error('Missing Scratch asset');
  for(const t of project.targets)for(const [id,block] of Object.entries(t.blocks)) {
    if((block.next&&!t.blocks[block.next])||(block.parent&&!t.blocks[block.parent]))throw Error('Broken Scratch block reference');
    for(const input of Object.values(block.inputs))if(typeof input[1]==='string'&&!t.blocks[input[1]])throw Error('Broken Scratch input');
    if(block.topLevel&&block.parent!==null)throw Error('Invalid top-level Scratch block');
  }
  if(!runVM)return;
  // Use official source entry: its bundled Node build omits a jsdom CSS asset.
  const path=require('node:path');
  const VM=require(path.resolve(path.dirname(require.resolve('@scratch/scratch-vm')),'../../src/virtual-machine.js'));const {ScratchStorage:Storage}=require('@scratch/scratch-storage');
  const vm=new VM();vm.attachStorage(new Storage());
  try {
    await vm.loadProject(bytes);
    const sprite=vm.runtime.targets.find(t=>!t.isStage);
    if(!sprite||!sprite.blocks.getBlock('flag'))throw Error('Scratch VM could not load generated sprite');
    if(motion==='walk') {
      const before=sprite.x;vm.runtime.currentStepTime=1000/30;vm.greenFlag();
      for(let i=0;i<5;i++)vm.runtime._step();
      if(sprite.x===before)throw Error('Scratch motion validation failed');
    }
  } finally {vm.stopAll();vm.quit();}
}
module.exports={TYPES,EXT,encodeImage,scratchProject,validateScratch};
