const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

function load(){
  const exports={};
  const source=fs.readFileSync(path.join(__dirname,'../src/ui/lumiere-folia/components/visualizer/tempera/impactSpeedDamping.ts'),'utf8');
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{exports});
  return exports;
}

test('slow camera moves leave the authored impact untouched',()=>{
  const {impactSpeedScale,impactSpringDamping}=load();
  for(const speed of [0,120,400,700]){
    assert.equal(impactSpeedScale(speed),1,`speed ${speed} should be inside the dead zone`);
    assert.equal(impactSpringDamping(speed).amplitude,1);
    assert.equal(impactSpringDamping(speed).frequency,1);
    assert.equal(impactSpringDamping(speed).decay,1);
  }
});

test('fast camera moves damp amplitude, ring and tail smoothly',()=>{
  const {impactSpeedScale,impactSpringDamping}=load();
  const slow=impactSpringDamping(700);
  const fast=impactSpringDamping(2600);
  const faster=impactSpringDamping(5000);
  assert.ok(fast.amplitude<slow.amplitude,'fast impact should lose amplitude');
  assert.ok(fast.frequency<slow.frequency,'fast impact should ring less');
  assert.ok(fast.decay<slow.decay,'fast impact should settle sooner');
  assert.ok(faster.amplitude<=0.3800001,'damping is clamped at the floor');
  assert.ok(impactSpeedScale(1800)>0.38&&impactSpeedScale(1800)<1,'middle speeds are interpolated');
});

test('damping strength and trigger speed are adjustable',()=>{
  const {impactSpeedScale}=load();
  assert.equal(impactSpeedScale(3000,0),1,'0% disables speed damping');
  assert.equal(impactSpeedScale(3000,100),0,'100% removes the bump at full speed');
  assert.equal(impactSpeedScale(900,80,1200),1,'raising the trigger speed keeps 900px/s untouched');
  assert.ok(impactSpeedScale(1600,80,1200)<1,'above the trigger speed it starts damping');
  assert.ok(impactSpeedScale(1600,20,700)>impactSpeedScale(1600,80,700),'stronger damping reduces more');
  assert.equal(impactSpeedScale(0,80,0),1,'0 trigger speed still leaves a stationary camera untouched');
  assert.ok(impactSpeedScale(400,80,0)<1,'0 trigger starts damping as soon as the camera moves');
  assert.ok(impactSpeedScale(1600,200,700)<0.1,'over-100% can flatten most of the bump before full speed');
  assert.ok(impactSpeedScale(1600,150,700)<=impactSpeedScale(1600,100,700),'150% weakens at least as much as 100%');
});
