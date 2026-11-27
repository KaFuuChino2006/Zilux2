const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

// The layout only needs a measured word unit; stub the canvas-backed measure module so the
// arrangement math can run in plain Node.
function layoutLoader(){
 const cache=new Map();
 const measure={
  createTemperaMeasureContext:()=>({}),
  buildTemperaWordUnit:(_ctx,segment,lineIndex,segmentIndex,fontSize,scale)=>({
   lineIndex,segmentIndex,text:segment.text,startOffset:segment.startOffset,endOffset:segment.endOffset,
   leadingGap:0,scale,width:segment.graphemes.length*fontSize*0.5,
   glyphs:segment.graphemes.map((glyph,index)=>({
    char:glyph.char,startTime:glyph.startTime,endTime:glyph.endTime,
    offset:index*fontSize*0.5,width:fontSize*0.5,
   })),
   startTime:segment.startTime,endTime:segment.endTime,
  }),
 };
 function load(file){
  if(cache.has(file))return cache.get(file);
  const exports={};cache.set(file,exports);
  vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{
   compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
  }).outputText,{
   exports,console,
   require:specifier=>specifier==='./temperaMeasure'
    ? measure
    : load(path.resolve(path.dirname(file),specifier.endsWith('.ts')?specifier:specifier+'.ts')),
  });
  return exports;
 }
 return ()=>load(path.join(__dirname,'../src/ui/lumiere-folia/components/visualizer/tempera/temperaLayout.ts'));
}

const line=(lineIndex, count=3)=>({
 text:'一二三'.slice(0,count),startOffset:0,endOffset:count,isWordLike:true,
 startTime:lineIndex*3,endTime:lineIndex*3+2.5,
 graphemes:Array.from({length:count},(_,index)=>({
  char:'一二三'[index],startTime:lineIndex*3+index*0.5,endTime:lineIndex*3+index*0.5+0.4,
 })),
});
const lines=[[line(0)],[line(1)]];

function layout(overrides={}){
 const {resolveTemperaLayout}=layoutLoader()();
 return resolveTemperaLayout({
  lines,shotKind:'duo-split',width:1280,height:720,baseFontSize:64,
  fontFamily:'sans-serif',fontWeight:700,seed:42,centered:true,...overrides,
 });
}

test('vertical arrangement turns each lyric line into a top-to-bottom column without retiming',()=>{
 const placements=layout({arrangement:'vertical'});
 assert.equal(placements.length,6);
 for(const lineIndex of [0,1]){
  const column=placements.filter(item=>item.lineIndex===lineIndex);
  assert.equal(column.length,3);
  assert.ok(column.every(item=>Math.abs(item.x-column[0].x)<1e-6),'one column per lyric line');
  assert.ok(column[1].y>column[0].y&&column[2].y>column[1].y,'glyphs run downwards');
  assert.deepEqual(Array.from(column, item=>item.char),['一','二','三'],'character order is unchanged');
  assert.deepEqual(Array.from(column, item=>[item.startTime,item.endTime]),[[lineIndex*3,lineIndex*3+0.4],[lineIndex*3+0.5,lineIndex*3+0.9],[lineIndex*3+1,lineIndex*3+1.4]]);
 }
 assert.ok(placements.filter(item=>item.lineIndex===0)[0].x<placements.filter(item=>item.lineIndex===1)[0].x,'columns read left to right');
});

test('mixed arrangement alternates horizontal and vertical by lyric line',()=>{
 const {resolveTemperaArrangement}=layoutLoader()();
 assert.equal(resolveTemperaArrangement('mixed',0),'horizontal');
 assert.equal(resolveTemperaArrangement('mixed',1),'vertical');
 assert.equal(resolveTemperaArrangement('mixed',2),'horizontal');
 assert.equal(resolveTemperaArrangement('graphic',3),'graphic');
});

test('graphic arrangement spreads the same glyphs along a seeded trajectory',()=>{
 const placements=layout({arrangement:'graphic',graphicShape:'ring'});
 assert.equal(placements.length,6);
 assert.deepEqual(Array.from(placements, item=>[item.char,item.startTime,item.endTime]),lines.flat().flatMap(item=>item.graphemes.map(glyph=>[glyph.char,glyph.startTime,glyph.endTime])),'glyph text and timing are unchanged');
 assert.ok(new Set(placements.map(item=>`${item.x.toFixed(2)}:${item.y.toFixed(2)}`)).size>2,'ring spreads positions');
 assert.deepEqual(Array.from(placements, item=>[item.char,item.startTime,item.endTime]),Array.from(layout({arrangement:'graphic',graphicShape:'ring'}), item=>[item.char,item.startTime,item.endTime]),'same seed and shape are stable');
 const wave=layout({arrangement:'graphic',graphicShape:'wave'});
 assert.notDeepEqual(Array.from(wave, item=>`${item.x}:${item.y}`),Array.from(placements, item=>`${item.x}:${item.y}`),'shape changes the trajectory');
 assert.equal(wave.length,6);
});

test('chained horizontal lines start under the previous last glyph with left edges aligned',()=>{
 const placements=layout({arrangement:'horizontal',chained:true});
 assert.equal(placements.length,6);
 const first=placements.filter(item=>item.lineIndex===0);
 const second=placements.filter(item=>item.lineIndex===1);
 const last=first[first.length-1];
 const firstNext=second[0];
 const lastLeft=last.x-last.width/2;
 const nextLeft=firstNext.x-firstNext.width/2;
 assert.ok(Math.abs(nextLeft-lastLeft)<1e-6,'next first glyph left edge follows previous last glyph');
 assert.ok(firstNext.y>last.y,'next line sits below the previous line');
 assert.ok(second[1].x>second[0].x&&second[2].x>second[1].x,'the next line still reads left to right');
});

test('random next-line placement scatters every line and seeds each sentence apart',()=>{
 const follow=layout({arrangement:'horizontal',chained:true});
 const random=layout({arrangement:'horizontal',chained:true,linePlacement:'random'});
 for(const lineIndex of [0,1]){
  const line=random.filter(item=>item.lineIndex===lineIndex);
  const chained=follow.filter(item=>item.lineIndex===lineIndex);
  assert.notDeepEqual(Array.from(line,item=>[item.x,item.y]),Array.from(chained,item=>[item.x,item.y]),`line ${lineIndex} leaves the chained spot`);
  assert.ok(line.every(item=>item.x>=0&&item.x<=1280&&item.y>=0&&item.y<=720),`line ${lineIndex} stays inside the frame`);
 }
 const first=random.filter(item=>item.lineIndex===0).map(item=>[item.x,item.y]);
 const second=random.filter(item=>item.lineIndex===1).map(item=>[item.x,item.y]);
 assert.notDeepEqual(first,second,'different sentences land on different spots');
 assert.deepEqual(Array.from(second),Array.from(layout({arrangement:'horizontal',chained:true,linePlacement:'random'}).filter(item=>item.lineIndex===1).map(item=>[item.x,item.y])),'same seed and sentence keep the same spot');
});

test('chained vertical lines start under the previous last glyph and keep one column',()=>{
 const placements=layout({arrangement:'vertical',chained:true});
 assert.equal(placements.length,6);
 const first=placements.filter(item=>item.lineIndex===0);
 const second=placements.filter(item=>item.lineIndex===1);
 const last=first[first.length-1];
 const firstNext=second[0];
 assert.ok(Math.abs((firstNext.x-firstNext.width/2)-(last.x-last.width/2))<1e-6,'next first glyph left edge follows previous last glyph');
 assert.ok(firstNext.y>last.y,'next line sits below the previous line');
 assert.ok(second.every(item=>Math.abs(item.x-second[0].x)<1e-6),'the next line stays a single column');
});


test('directional chain places the next line around the previous line box',()=>{
 const follow=layout({arrangement:'horizontal',chained:true});
 const followFirst=follow.filter(item=>item.lineIndex===0);
 const followSecond=follow.filter(item=>item.lineIndex===1);
 const south=layout({arrangement:'horizontal',chained:true,linePlacement:'direction',lineDirection:'south'});
 const southSecond=south.filter(item=>item.lineIndex===1);
 assert.ok(Math.abs((southSecond[0].x-southSecond[0].width/2)-(followSecond[0].x-followSecond[0].width/2))<1e-6,'south keeps the old chain');
 assert.ok(Math.abs((southSecond[0].y)-(followSecond[0].y))<1e-6,'south keeps the old vertical step');

 const east=layout({arrangement:'horizontal',chained:true,linePlacement:'direction',lineDirection:'east'});
 const eastFirst=east.filter(item=>item.lineIndex===0);
 const eastSecond=east.filter(item=>item.lineIndex===1);
 const firstRight=Math.max(...eastFirst.map(item=>item.x+item.width/2));
 const lastTop=Math.min(...eastFirst.map(item=>item.y-item.fontSize/2));
 const lastBottom=Math.max(...eastFirst.map(item=>item.y+item.fontSize/2));
 assert.ok(eastSecond[0].x-eastSecond[0].width/2>=firstRight-1e-6,'east starts at the previous line right edge');
 assert.ok(eastSecond[0].y>lastTop&&eastSecond[0].y<lastBottom,'east is vertically centred on the previous line');

 const north=layout({arrangement:'horizontal',chained:true,linePlacement:'direction',lineDirection:'north'});
 const northFirst=north.filter(item=>item.lineIndex===0);
 const northSecond=north.filter(item=>item.lineIndex===1);
 const firstTop=Math.min(...northFirst.map(item=>item.y-item.fontSize/2));
 const secondBottom=Math.max(...northSecond.map(item=>item.y+item.fontSize/2));
 assert.ok(secondBottom<=firstTop+1e-6,'north sits above the previous line');

 const rotated=layout({arrangement:'horizontal',chained:true,linePlacement:'direction',lineDirection:'south',lineDirectionMode:'rotate'});
 const rotatedFirst=rotated.filter(item=>item.lineIndex===0);
 const rotatedSecond=rotated.filter(item=>item.lineIndex===1);
 assert.ok(rotatedSecond[0].x-rotatedSecond[0].width/2>=Math.max(...rotatedFirst.map(item=>item.x+item.width/2))-1e-6,'rotate 45° turns south into south-east');
 assert.ok(rotatedSecond[0].y>=Math.max(...rotatedFirst.map(item=>item.y+item.fontSize/2))-1e-6,'rotated line also drops below');
});
