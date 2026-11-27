const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');

// Tempera's program compiler is renderer-free; load it with a tiny TS CommonJS loader so the
// order test does not need Pixi or a browser.
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

const programPath=path.join(__dirname,'../src/ui/lumiere-folia/components/visualizer/tempera/temperaProgram.ts');
const line={startTime:0,endTime:3,fullText:'一二三四五六',words:'一二三四五六'.split('').map((text,index)=>({
 text,startTime:index*0.5,endTime:index*0.5+0.45,
}))};
const segments=program=>program.paragraphs
 .flatMap(paragraph=>paragraph.lines)
 .flatMap(item=>item.segments)
 .filter(segment=>segment.graphemes.length>1)
 .map(segment=>segment.graphemes.map(grapheme=>[grapheme.char,grapheme.startTime,grapheme.endTime]));
const times=segment=>segment.map(grapheme=>[grapheme[1],grapheme[2]]);
const timeSignature=segment=>`${segment[0][1]}-${segment[1][1]}`;

test('split-phrase random glyph order keeps the phrase and permutes entry windows inside it',()=>{
 const {compileTemperaProgram}=pureLoader()(programPath);
 const ordered=segments(compileTemperaProgram([line],'seed-a',{shortPhrases:true,glyphOrder:'time'}));
 let shuffled=ordered;
 for(let seed=0;seed<64;seed++){
  shuffled=segments(compileTemperaProgram([line],`seed-${seed}`,{shortPhrases:true,glyphOrder:'random'}));
  if(shuffled.some((segment,index)=>timeSignature(segment)!==timeSignature(ordered[index])))break;
 }
 assert.equal(shuffled.length,ordered.length);
 shuffled.forEach((segment,index)=>{
  assert.deepEqual(segment.map(grapheme=>grapheme[0]),ordered[index].map(grapheme=>grapheme[0]),'glyph text and position stay put');
  assert.deepEqual([...times(segment)].sort(),[...times(ordered[index])].sort(),'the same entry windows are only permuted');
 });
 assert.ok(shuffled.some((segment,index)=>timeSignature(segment)!==timeSignature(ordered[index])),'at least one phrase enters in a different order');
});

test('split-phrase random glyph order is deterministic for a seed and can produce both orders',()=>{
 const {compileTemperaProgram}=pureLoader()(programPath);
 const compile=seed=>JSON.stringify(segments(compileTemperaProgram([line],seed,{shortPhrases:true,glyphOrder:'random'})));
 const first=compile('seed-b');
 assert.equal(compile('seed-b'),first);
 const variants=new Set();
 for(let seed=0;seed<32;seed++)variants.add(compile(`seed-${seed}`));
 assert.ok(variants.size>1,'different seeds must be able to shuffle into a different order');
});

test('whole-line mode ignores the split-phrase glyph order switch',()=>{
 const {compileTemperaProgram}=pureLoader()(programPath);
 const ordered=segments(compileTemperaProgram([line],'seed-a',{wholeLineLyrics:true,glyphOrder:'time'}));
 const random=segments(compileTemperaProgram([line],'seed-a',{wholeLineLyrics:true,glyphOrder:'random'}));
 assert.deepEqual(random,ordered);
});

test('all-random shuffles entry order across a whole line without moving glyphs',()=>{
 const {compileTemperaProgram}=pureLoader()(programPath);
 const ordered=segments(compileTemperaProgram([line],'seed-a',{wholeLineLyrics:true,glyphOrder:'time'}));
 let shuffled=ordered;
 for(let seed=0;seed<64;seed++){
  shuffled=segments(compileTemperaProgram([line],`seed-${seed}`,{wholeLineLyrics:true,glyphOrder:'all-random'}));
  if(shuffled.some((segment,index)=>timeSignature(segment)!==timeSignature(ordered[index])))break;
 }
 assert.equal(shuffled.length,ordered.length);
 shuffled.forEach((segment,index)=>{
  assert.deepEqual(segment.map(grapheme=>grapheme[0]),ordered[index].map(grapheme=>grapheme[0]),'glyph text and position stay put');
  assert.deepEqual([...times(segment)].sort(),[...times(ordered[index])].sort(),'the same entry windows are only permuted');
 });
 assert.ok(shuffled.some((segment,index)=>timeSignature(segment)!==timeSignature(ordered[index])),'whole-line all-random must be able to enter in a different order');
});

test('omitting shortPhrases keeps the legacy split for overlap and default effects',()=>{
 const {compileTemperaProgram}=pureLoader()(programPath);
 const shots=program=>program.paragraphs
  .flatMap(paragraph=>paragraph.shots)
  .filter(shot=>!shot.isBridge&&shot.slices.length>0);
 const split=shots(compileTemperaProgram([line],'seed-legacy',{wholeLineLyrics:false}));
 const whole=shots(compileTemperaProgram([line],'seed-legacy',{wholeLineLyrics:true}));
 assert.ok(split.length>1,'wholeLineLyrics=false without shortPhrases must still split the line');
 assert.equal(whole.length,1,'wholeLineLyrics=true keeps the line in one shot');
});

test('legacy split keeps word-grouped chunks while wenflash phrases stay one phrase per shot',()=>{
 const {compileTemperaProgram}=pureLoader()(programPath);
 const shotSizes=options=>compileTemperaProgram([line],'seed-chunks',options).paragraphs
  .flatMap(paragraph=>paragraph.shots)
  .filter(shot=>!shot.isBridge&&shot.slices.length>0)
  .map(shot=>shot.slices.reduce((count,slice)=>count+(slice.segmentEnd-slice.segmentStart),0));
 const legacy=shotSizes({wholeLineLyrics:false});
 const wenflash=shotSizes({shortPhrases:true});
 assert.ok(legacy.length>0&&legacy.every(count=>count>=2),'overlap still groups several words into one shot');
 assert.ok(wenflash.length>0&&wenflash.every(count=>count===1),'each wenflash short phrase owns its shot');
});

test('mixed layout keeps both whole-line and split-phrase shots',()=>{
 const {compileTemperaProgram}=pureLoader()(programPath);
 const lines=Array.from({length:4},(_,lineIndex)=>({
  ...line,
  startTime:lineIndex*3,
  endTime:lineIndex*3+3,
  words:'一二三四五六'.split('').map((text,index)=>({
   text,startTime:lineIndex*3+index*0.5,endTime:lineIndex*3+index*0.5+0.45,
  })),
 }));
 const program=compileTemperaProgram(lines,'seed-mixed',{shortPhrases:true,mixedPhrases:true});
 const counts=new Map();
 for(const shot of program.paragraphs.flatMap(paragraph=>paragraph.shots)){
  if(shot.isBridge)continue;
  const lineIndex=shot.slices[0]?.lineIndex;
  if(lineIndex===undefined)continue;
  counts.set(lineIndex,(counts.get(lineIndex)??0)+1);
 }
 assert.ok([...counts.values()].includes(1),'whole-line lines stay in one shot');
 assert.ok([...counts.values()].some(count=>count>1),'split-phrase lines produce several shots');
 const pattern=[0,1,2,3].map(lineIndex=>counts.get(lineIndex)===1?1:2);
 assert.notDeepEqual(pattern,[1,2,1,2],'mixed is random, not a fixed 1-2-1 alternation');
 assert.notDeepEqual(pattern,[2,1,2,1],'mixed is random, not a fixed 1-2-1 alternation');
});

test('phrase size controls how many Han characters share a short phrase',()=>{
 const {buildTemperaSegments}=pureLoader()(programPath);
 const texts=size=>buildTemperaSegments(line,true,'time','seed',0,size)
  .map(segment=>segment.text)
  .filter(text=>/[\u4e00-\u9fff]/u.test(text));
 assert.deepEqual([...texts(1)],['一','二','三','四','五','六']);
 assert.deepEqual([...texts(3)],['一二三','四五六']);
 assert.deepEqual([...texts(8)],['一二三四五六']);
});

test('phrase size adapts to dense scripts by character and spaced scripts by word',()=>{
 const {buildTemperaSegments}=pureLoader()(programPath);
 const texts=(text,size)=>buildTemperaSegments({startTime:0,endTime:3,fullText:text,words:[]},true,'time','seed',0,size)
  .map(segment=>segment.text.trim())
  .filter(Boolean);
 assert.deepEqual([...texts('あいうえお',2)],['あい','うえ','お']);
 assert.deepEqual([...texts('hello beautiful world',2)],['hello beautiful','world']);
 assert.deepEqual([...texts('안녕 하세요 세계',2)],['안녕 하세요','세계']);
 assert.deepEqual([...texts('مرحبا بالعالم',1)],['مرحبا','بالعالم']);
});
