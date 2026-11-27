const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

const root=path.join(__dirname,'../src/ui/lumiere-folia/components/visualizer');
const loadCache=new Map();
function load(file){
 if(loadCache.has(file))return loadCache.get(file);
 const exports={};loadCache.set(file,exports);
 const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{
  compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022},
 }).outputText;
 vm.runInNewContext(source,{
  exports,console,
  require:specifier=>{
   const target=path.resolve(path.dirname(file),specifier.endsWith('.ts')?specifier:specifier+'.ts');
   return load(target);
  },
 });
 return exports;
}
const printMarks=()=>load(path.join(root,'tempera/wenflashPrintMarks.ts'));
const inkField=()=>load(path.join(root,'tempera/wenflashInkField.ts'));

test('print layout keeps every mark outside the text frame and inside the stage',()=>{
 const {computeWenflashPrintLayout}=printMarks();
 const layout=computeWenflashPrintLayout(1280,720);
 assert.equal(layout.width,1280);
 assert.equal(layout.height,720);
 assert.equal(layout.corners.length,4);
 assert.equal(layout.targets.length,2);
 assert.equal(layout.labels.length,4);
 assert.equal(layout.foldMarks.length,2);
 assert.ok(layout.frame.x>0&&layout.frame.y>0);
 assert.ok(layout.frame.x+layout.frame.w<1280);
 assert.ok(layout.frame.y+layout.frame.h<720);
 for(const corner of layout.corners){
  assert.ok(corner.x<layout.frame.x||corner.x>layout.frame.x+layout.frame.w);
 }
 assert.ok(layout.bar.w>0&&layout.bar.h>0);
 assert.ok(layout.bar.x+layout.bar.w<=1280);
 assert.ok(layout.bar.y+layout.bar.h<=720);
 assert.ok(layout.ticks.length>0);
 assert.ok(layout.perforations.length>0);
});

test('ink mote count and positions are deterministic and density-driven',()=>{
 const {computeWenflashInkMotes,wenflashInkMoteCount}=inkField();
 assert.equal(wenflashInkMoteCount(0),10);
 assert.equal(wenflashInkMoteCount(1),44);
 const sparse=computeWenflashInkMotes(1280,720,0.15,1234);
 const dense=computeWenflashInkMotes(1280,720,0.95,1234);
 assert.ok(dense.length>sparse.length);
 const again=computeWenflashInkMotes(1280,720,0.15,1234);
 assert.equal(sparse.length,again.length);
 for(let i=0;i<sparse.length;i+=1){
  assert.equal(sparse[i].x,again[i].x);
  assert.equal(sparse[i].y,again[i].y);
  assert.ok(sparse[i].x>=0&&sparse[i].x<=1280);
  assert.ok(sparse[i].y>=0&&sparse[i].y<=720);
 }
});

test('halftone radii breathe without leaving their legal band',()=>{
 const {wenflashHalftoneRadii}=inkField();
 const start=wenflashHalftoneRadii(9,0);
 const end=wenflashHalftoneRadii(9,1);
 assert.equal(start.length,9);
 assert.equal(end.length,9);
 for(const radius of [...start,...end]){
  assert.ok(radius>=1.1&&radius<=2.9);
 }
});
