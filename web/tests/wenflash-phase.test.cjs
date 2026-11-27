const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

function loadPureModule(file){
 const source=fs.readFileSync(file,'utf8');
 const exports={};
 vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  exports,console,
  require:specifier=>loadPureModule(path.resolve(path.dirname(file),specifier)),
 });
 return exports;
}
const phasePath=path.join(__dirname,'../src/ui/wenflashPhase.ts');

test('run duration 0 keeps the cycle linear',()=>{
 const {wenflashEasedCycles}=loadPureModule(phasePath);
 assert.equal(wenflashEasedCycles(3.6,3.6,0,1.2),1);
 assert.equal(wenflashEasedCycles(9,3.6,0,1.2),2.5);
});

test('before the run duration the cycle stays linear',()=>{
 const {wenflashEasedCycles}=loadPureModule(phasePath);
 assert.equal(wenflashEasedCycles(1.8,3.6,3,1.2),0.5);
 assert.ok(Math.abs(wenflashEasedCycles(3,3.6,3,1.2)-3/3.6)<1e-9);
});

test('braking adds a third of the brake window and then freezes',()=>{
 const {wenflashEasedCycles}=loadPureModule(phasePath);
 const atStop=wenflashEasedCycles(3+1.2,3.6,3,1.2);
 assert.ok(Math.abs(atStop-(3+1.2/3)/3.6)<1e-9);
 assert.equal(wenflashEasedCycles(30,3.6,3,1.2),atStop);
});

test('a zero brake window stops exactly at the run duration',()=>{
 const {wenflashEasedCycles}=loadPureModule(phasePath);
 assert.ok(Math.abs(wenflashEasedCycles(3,3.6,3,0)-3/3.6)<1e-9);
 assert.ok(Math.abs(wenflashEasedCycles(20,3.6,3,0)-3/3.6)<1e-9);
});
