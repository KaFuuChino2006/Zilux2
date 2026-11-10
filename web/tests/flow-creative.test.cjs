const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const cache=new Map();
function load(file){
 file=path.resolve(file);if(cache.has(file))return cache.get(file);
 const exports={};cache.set(file,exports);
 vm.runInNewContext(ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText,{
  exports,require:specifier=>load(path.resolve(path.dirname(file),specifier+'.ts')),
 });return exports;
}
const mg=load(path.join(__dirname,'../src/ui/flowMg.ts'));
const creative=load(path.join(__dirname,'../src/ui/flowMgCreative.ts'));
class Graphics {
 constructor(){this.commands=[];}
}
for(const method of ['poly','rect','roundRect','circle','ellipse','arc','moveTo','lineTo','bezierCurveTo','quadraticCurveTo','closePath'])Graphics.prototype[method]=function(...args){
 for(const value of args.flat())if(typeof value==='number')assert.ok(Number.isFinite(value),`${method} received nonfinite coordinate`);
 this.commands.push([method,...args]);return this;
};
Graphics.prototype.fill=function(style){this.style={fill:true,...style};return this;};
Graphics.prototype.stroke=function(style){this.style={fill:false,...style};return this;};
function drawing(variant,width=1280,height=720,density=1){
 const nodes=[];
 const ctx={width,height,seed:42,flowAngle:Math.PI/3,palette:{blockA:'#7c8fff',blockB:'#ee729d',blockC:'#65d7bf',accent:'#ffc577'},pixi:{Graphics},
  createGroup:()=>({scale:{set(){}}}),add:(node,options)=>nodes.push({commands:node.commands,style:node.style,options})};
 mg.drawFlowMg(ctx,{variant,density,scale:1,opacity:.8,stagger:.65});return nodes;
}
test('40 creative and 50 solid geometry constructions append without moving saved IDs',()=>{
 assert.equal(creative.FLOW_CREATIVE_NAMES.length,40);assert.equal(new Set(creative.FLOW_CREATIVE_NAMES).size,40);
 assert.equal(mg.FLOW_MG_STYLES[71].name,'空间折线');
 assert.equal(mg.FLOW_MG_STYLES[72].variant,72);assert.equal(mg.FLOW_MG_STYLES[72].id,193);
 const geometry=load(path.join(__dirname,'../src/ui/flowMgGeometry.ts'));
 assert.equal(geometry.FLOW_GEOMETRY_NAMES.length,50);assert.equal(new Set(geometry.FLOW_GEOMETRY_NAMES).size,50);
 assert.equal(mg.FLOW_MG_STYLES[111].name,'机械虹膜');assert.equal(mg.FLOW_MG_STYLES[112].id,233);
 assert.equal(mg.FLOW_COMPOSITION_COUNT,283);assert.equal(new Set(mg.FLOW_COMPOSITION_ORDER).size,283);
 for(const style of mg.FLOW_MG_STYLES)assert.equal(mg.flowMgVariantForId(style.id),style.variant);
});
test('all 50 solid geometries produce different filled assemblies within the node budget',()=>{
 const signatures=new Set();
 for(let variant=112;variant<162;variant++){
  for(const [width,height]of [[1280,720],[720,1280]])for(const density of [.4,1,1.6]){
   const nodes=drawing(variant,width,height,density);
   assert.ok(nodes.length>=4&&nodes.length<=60,`solid node budget ${variant}: ${nodes.length}`);
   assert.ok(nodes.every(node=>node.style.fill),`unfilled node in solid construction ${variant}`);
  }
  signatures.add(JSON.stringify(drawing(variant).map(node=>node.commands)));
 }
 assert.equal(signatures.size,50);
 if(process.env.FLOW_GEOMETRY_OUT)fs.writeFileSync(process.env.FLOW_GEOMETRY_OUT,JSON.stringify(Array.from({length:50},(_,i)=>({variant:112+i,name:mg.FLOW_MG_STYLES[112+i].name,nodes:drawing(112+i)}))));
});
test('all 40 render distinct finite bounded geometry in landscape and portrait',()=>{
 const signatures=new Set(),contact=[];
 for(let variant=72;variant<112;variant++){
  for(const [width,height]of [[1280,720],[720,1280]])for(const density of [.4,1,1.6]){
   const nodes=drawing(variant,width,height,density);
   assert.ok(nodes.length>=6&&nodes.length<=72,`node budget ${variant}: ${nodes.length}`);
   assert.ok(nodes.every(node=>node.commands.length>0&&node.commands.length<160));
   for(const node of nodes){
    assert.ok(node.options.delay>=0&&node.options.delay<1);
    for(const command of node.commands)for(const value of command.slice(1).flat())if(typeof value==='number')assert.ok(Math.abs(value)<Math.max(width,height)*4);
   }
  }
  const nodes=drawing(variant);
  signatures.add(JSON.stringify(nodes.map(node=>node.commands)));
  assert.deepEqual(nodes,drawing(variant));
  contact.push({variant,name:mg.FLOW_MG_STYLES[variant].name,nodes});
 }
 assert.equal(signatures.size,40);
 if(process.env.FLOW_CONTACT_OUT)fs.writeFileSync(process.env.FLOW_CONTACT_OUT,JSON.stringify(contact));
});
