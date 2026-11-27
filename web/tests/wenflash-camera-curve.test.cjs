const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

// wenflashSettings is DOM-free apart from its storage listener, so a localStorage stub is
// enough to exercise the camera speed curve without Pixi or a browser.
function loadSettings(){
 const store=new Map();
 const exports={};
 const source=fs.readFileSync(path.join(__dirname,'../src/ui/wenflashSettings.ts'),'utf8');
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  exports,console,
  localStorage:{getItem:key=>store.get(key)??null,setItem:(key,value)=>{store.set(key,String(value));}},
 });
 return exports;
}

test('camera speed curve defaults to the entry curve and stays neutral',()=>{
 const settings=loadSettings();
 const current=settings.currentWenflashSettings();
 assert.deepEqual([...current.cameraCurve],[1/3,1/3,2/3,2/3]);
 for(const t of [0.1,0.25,0.5,0.75,0.9]){
  assert.ok(Math.abs(settings.wenflashCameraSpeed(t)-1)<0.02,`identity curve keeps speed 1 at ${t}`);
 }
});

test('camera speed curve follows the slope of an eased curve',()=>{
 const settings=loadSettings();
 const current=settings.currentWenflashSettings();
 settings.previewWenflashSettings({...current,cameraCurve:[0.42,0,0.58,1]});
 const start=settings.wenflashCameraSpeed(0.08);
 const middle=settings.wenflashCameraSpeed(0.5);
 const end=settings.wenflashCameraSpeed(0.92);
 assert.ok(start<middle,`eased start should be slower (${start} < ${middle})`);
 assert.ok(end<middle,`eased end should be slower (${end} < ${middle})`);
 assert.ok(start>=0.35&&middle<=2,'speed stays inside the renderer clamp');
});

test('camera zoom speed uses its own curve',()=>{
 const settings=loadSettings();
 const current=settings.currentWenflashSettings();
 assert.deepEqual([...current.cameraZoomCurve],[1/3,1/3,2/3,2/3]);
 for(const t of [0.1,0.25,0.5,0.75,0.9]){
  assert.ok(Math.abs(settings.wenflashCameraZoomSpeed(t)-1)<0.02,`identity curve keeps zoom speed 1 at ${t}`);
 }
 settings.previewWenflashSettings({...current,cameraZoomCurve:[0.42,0,0.58,1]});
 const start=settings.wenflashCameraZoomSpeed(0.08);
 const middle=settings.wenflashCameraZoomSpeed(0.5);
 const end=settings.wenflashCameraZoomSpeed(0.92);
 assert.ok(start<middle,`eased start should zoom slower (${start} < ${middle})`);
 assert.ok(end<middle,`eased end should zoom slower (${end} < ${middle})`);
 assert.ok(start>=0.25&&middle<=2.5,'zoom speed stays inside the zoom clamp');
 assert.ok(Math.abs(settings.wenflashCameraSpeed(0.5)-1)<0.02,'zoom curve does not affect pan');
});

test('camera overlap blends the next line in before its first glyph',()=>{
 const settings=loadSettings();
 const nextStart=10;
 assert.equal(settings.wenflashCameraBlend(8.9,nextStart,0.8),0);
 const early=settings.wenflashCameraBlend(9.25,nextStart,0.8);
 const middle=settings.wenflashCameraBlend(9.6,nextStart,0.8);
 const late=settings.wenflashCameraBlend(10,nextStart,0.8);
 assert.ok(early>0&&early<middle,`overlap starts before the next line (${early} < ${middle})`);
 assert.ok(middle>early&&middle<late,`overlap keeps rising into the next line (${middle} < ${late})`);
 assert.equal(late,1);
 assert.equal(settings.wenflashCameraBlend(10,nextStart,0),1);
 assert.equal(settings.wenflashCameraBlend(9.9,nextStart,0),0);
});

test('camera zoom overlap can split from the position overlap',()=>{
 const settings=loadSettings();
 const current=settings.currentWenflashSettings();
 assert.equal(current.cameraOverlapLinked,true);
 settings.previewWenflashSettings({
  ...current,
  cameraOverlapLinked:false,
  cameraOverlap:0.2,
  cameraZoomOverlap:1.4,
 });
 assert.equal(settings.wenflashCameraOverlapLinked(),false);
 assert.equal(settings.wenflashCameraOverlap(),0.2);
 assert.equal(settings.wenflashCameraZoomOverlap(),1.4);
 const position=settings.wenflashCameraBlend(9.9,10,0.2);
 const zoom=settings.wenflashCameraZoomBlend(9.9,10);
 assert.ok(zoom>position,`zoom can ramp earlier than position (${zoom} > ${position})`);
});
