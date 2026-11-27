const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

// 重合设置只依赖 localStorage；用极小的 TS CommonJS loader 就能测曲线，不需要 Pixi。
function loadOverlap(){
  const cache=new Map();
  const store=new Map();
  function load(file){
    if(cache.has(file))return cache.get(file);
    const exports={};
    cache.set(file,exports);
    const source=fs.readFileSync(file,'utf8');
    vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
      exports,console,
      localStorage:{getItem:key=>store.get(key)??null,setItem:(key,value)=>{store.set(key,String(value));}},
      window:{dispatchEvent(){}},
      CustomEvent:class{},
      require:specifier=>load(path.resolve(path.dirname(file),specifier.endsWith('.ts')?specifier:specifier+'.ts')),
    });
    return exports;
  }
  return load(path.join(__dirname,'../src/ui/overlapSettings.ts'));
}

test('overlap camera curves default to identity and stay neutral',()=>{
  const settings=loadOverlap();
  const live=settings.overlapFx();
  assert.deepEqual([...live.cameraCurve],[1/3,1/3,2/3,2/3]);
  assert.deepEqual([...live.cameraZoomCurve],[1/3,1/3,2/3,2/3]);
  for(const t of [0.1,0.25,0.5,0.75,0.9]){
    assert.ok(Math.abs(settings.overlapCameraSpeed(t)-1)<0.02,`identity curve keeps pan speed 1 at ${t}`);
    assert.ok(Math.abs(settings.overlapCameraZoomSpeed(t)-1)<0.02,`identity curve keeps zoom speed 1 at ${t}`);
  }
});

test('overlap pan and zoom curves are independent',()=>{
  const settings=loadOverlap();
  const live=settings.overlapFx();
  settings.setOverlapFx({...live,cameraCurve:[0.42,0,0.58,1],cameraZoomCurve:[1/3,1/3,2/3,2/3]});
  const panStart=settings.overlapCameraSpeed(0.08);
  const panMiddle=settings.overlapCameraSpeed(0.5);
  assert.ok(panStart<panMiddle,`eased pan starts slower (${panStart} < ${panMiddle})`);
  assert.ok(Math.abs(settings.overlapCameraZoomSpeed(0.5)-1)<0.02,'pan curve does not move zoom');
  settings.setOverlapFx({...settings.overlapFx(),cameraCurve:[1/3,1/3,2/3,2/3],cameraZoomCurve:[0.42,0,0.58,1]});
  const zoomStart=settings.overlapCameraZoomSpeed(0.08);
  const zoomMiddle=settings.overlapCameraZoomSpeed(0.5);
  assert.ok(zoomStart<zoomMiddle,`eased zoom starts slower (${zoomStart} < ${zoomMiddle})`);
  assert.ok(Math.abs(settings.overlapCameraSpeed(0.5)-1)<0.02,'zoom curve does not move pan');
});
