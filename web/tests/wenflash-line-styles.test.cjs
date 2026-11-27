const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

function pureLoader(){
 const cache=new Map();
 return function load(file){
  if(cache.has(file))return cache.get(file);
  const exports={};cache.set(file,exports);
  const source=fs.readFileSync(file,'utf8');
  vm.runInNewContext(ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
   exports,console,
   require:specifier=>load(path.resolve(path.dirname(file),specifier.endsWith('.ts')?specifier:specifier+'.ts')),
  });
  return exports;
 };
}

const stylesPath=path.join(__dirname,'../src/ui/lumiere-folia/components/visualizer/tempera/wenflashLineStyles.ts');
const context={
 rect:{x:100,y:200,width:420,height:60},
 box:{x:90,y:190,width:440,height:80},
 perimeter:1040,
 phase:0.37,
 cycles:2.37,
 alpha:0.8,
 color:'#c9a6ff',
 width:3,
 glow:0.6,
 fontSize:48,
 lineY:280,
};
const graphics=()=>({
 moves:0,
 moveTo(){this.moves++;return this;},
 lineTo(){this.moves++;return this;},
 stroke(){this.moves++;return this;},
 circle(){this.moves++;return this;},
 fill(){this.moves++;return this;},
 rect(){this.moves++;return this;},
});

test('thirty distinct named line styles are available',()=>{
 const {WENFLASH_LINE_STYLES}=pureLoader()(stylesPath);
 assert.equal(WENFLASH_LINE_STYLES.length,30);
 assert.equal(new Set(WENFLASH_LINE_STYLES.map(s=>s.id)).size,30);
 assert.equal(new Set(WENFLASH_LINE_STYLES.map(s=>s.name)).size,30);
 assert.ok(WENFLASH_LINE_STYLES.every(s=>s.id&&s.name&&s.family&&typeof s.frame==='function'&&typeof s.line==='function'));
});

test('every style draws both a frame and a bottom line without throwing',()=>{
 const {WENFLASH_LINE_STYLES}=pureLoader()(stylesPath);
 for(const style of WENFLASH_LINE_STYLES){
  const g=graphics();
  style.frame(g,context);
  style.line(g,context);
  assert.ok(g.moves>0,`${style.id} draws something`);
 }
});

test('style pick is deterministic and spreads across seeds',()=>{
 const {WENFLASH_LINE_STYLES,pickWenflashLineStyle}=pureLoader()(stylesPath);
 assert.equal(pickWenflashLineStyle(123,0).id,pickWenflashLineStyle(123,0).id);
 const seen=new Set();
 for(let seed=1;seed<=240;seed++)seen.add(pickWenflashLineStyle(seed,0).id);
 assert.ok(seen.size>=20,`expected a broad spread, saw ${seen.size}`);
 assert.ok([...seen].every(id=>WENFLASH_LINE_STYLES.some(s=>s.id===id)));
});
