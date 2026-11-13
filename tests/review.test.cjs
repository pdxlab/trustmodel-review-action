const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runEval, parseResult, unavailable, verifiedPass } = require('../dist_ts/eval.js');
const { buildComment, publishResult } = require('../dist_ts/comment.js');
const { detectAiChanges } = require('../dist_ts/detector.js');
const { readTrustmodelConfig } = require('../dist_ts/config.js');
const cfg = { apiKey: 'tm-test', baseUrl: 'http://127.0.0.1:8000', threshold: 65, detectPatterns: [] };
const opts = { cfg, changedFiles: ['agents/run.py'], baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40), repo: 'acme/app', prNumber: 1 };
const na = { status: 'not_available', passed: false, pr_diff_evaluated: false, trust_score: null, grade: null };
const json = (data, status=200) => new Response(JSON.stringify(data), {status, headers:{'Content-Type':'application/json'}});

test('uploads only paths, never source content or GitHub credentials', async () => {
  process.env.GITHUB_TOKEN = 'github-secret-must-stay-client-side';
  let body;
  const result = await runEval({...opts, transport: async (url, req) => {
    assert.ok(url.endsWith('/v1/pr-trust/review/'));
    body = JSON.parse(req.body);
    assert.equal(req.headers['X-API-Key'], 'tm-test');
    return json(na, 201);
  }});
  assert.deepEqual(body.changed_files, ['agents/run.py']);
  assert.deepEqual(Object.keys(body).sort(), ['repo','pr_number','base_sha','head_sha','changed_files','threshold','framework'].sort());
  assert.ok(!JSON.stringify(body).includes(process.env.GITHUB_TOKEN));
  assert.equal(result.status, 'not_available');
  assert.equal(verifiedPass(result), false);
});

test('no API key does not call any backend or public site-score', async () => {
  const result = await runEval({...opts, cfg:{...cfg,apiKey:''}, transport: async () => { throw new Error('unexpected network'); }});
  assert.equal(result.status, 'not_available');
  assert.equal(result.trustScore, null);
});

for (const status of [400,401,404,429,500,503]) test(`HTTP ${status} never falls back`, async () => {
  let calls=0;
  await assert.rejects(runEval({...opts, transport: async () => {calls++;return json({},status);}}));
  assert.equal(calls,1);
});

test('connection failures never fall back', async () => {
  let calls=0;
  await assert.rejects(runEval({...opts,transport:async()=>{calls++;throw new Error('network');}}));
  assert.equal(calls,1);
});

test('polling times out without a preliminary fallback', async () => {
  const urls=[];
  await assert.rejects(runEval({...opts,timeoutMs:10,pollIntervalMs:10,transport:async url=>{
    urls.push(url);return json({status:'running',run_id:'12345678-1234-1234-1234-123456789abc'},202);
  }}), /timed out/);
  assert.ok(urls.every(url=>url.includes('/v1/pr-trust/')));
});

test('legacy website score cannot become a passing result', () => {
  assert.throws(()=>parseResult({status:'passed',passed:true,pr_diff_evaluated:false,trust_score:100}));
  assert.throws(()=>parseResult({status:'passed',passed:true,trust_score:100}));
  assert.throws(()=>parseResult({status:'passed',passed:true,pr_diff_evaluated:true,trust_score:null}));
  assert.equal(verifiedPass(parseResult({status:'passed',passed:true,pr_diff_evaluated:true,trust_score:90,grade:'A'})),true);
});

test('not-available comment has no website score headline or false upgrade promise', () => {
  const body=buildComment(unavailable());
  assert.match(body,/Trust Review — not available/);
  assert.match(body,/No code was evaluated/);
  assert.doesNotMatch(body,/TrustScore \*\*|Upgrade|full 10-dimension/);
});

function octokit({head=opts.headSha,commentError=false}={}) {
  const calls=[];
  return { calls, rest:{repos:{createCommitStatus:async x=>{calls.push(['status',x]);}},
    pulls:{get:async()=>({data:{head:{sha:head}}})}, issues:{
      listComments(){}, createComment:async x=>{if(commentError)throw new Error('comments unavailable');calls.push(['comment',x]);},
      updateComment:async x=>{calls.push(['patch',x]);},
    }}, paginate:{iterator:async function*(){yield {data:[],url:'https://api.github.com/comments?page=1'};}} };
}
const pub=(kit,result=unavailable())=>publishResult({octokit:kit,owner:'acme',repo:'app',prNumber:1,headSha:opts.headSha,result});

test('unavailable results post an error status before their comment', async()=>{
  const kit=octokit();await pub(kit);
  assert.equal(kit.calls[0][0],'status');
  assert.equal(kit.calls[0][1].state,'error');
  assert.equal(kit.calls[0][1].context,'trustmodel/trust-review');
  assert.equal(kit.calls[1][0],'comment');
});
test('a comment failure cannot suppress the commit status',async()=>{
  const kit=octokit({commentError:true});await assert.rejects(pub(kit));
  assert.equal(kit.calls[0][0],'status');
});
test('superseded heads report only their own commit status',async()=>{
  const kit=octokit({head:'c'.repeat(40)});await pub(kit);
  assert.equal(kit.calls.length,1);assert.equal(kit.calls[0][1].sha,opts.headSha);
});

test('detector includes added/deleted/renamed paths without reading file contents', async()=>{
  const old=process.cwd();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trust-paths-'));
  const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
  try {
    git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
    fs.mkdirSync(path.join(dir,'prompts'));fs.writeFileSync(path.join(dir,'prompts','old.prompt'),'DO-NOT-UPLOAD-CONTENT');
    git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
    fs.renameSync(path.join(dir,'prompts','old.prompt'),path.join(dir,'prompts','new.prompt'));
    git('add','-A');git('commit','-qm','head');const head=git('rev-parse','HEAD');
    process.chdir(dir);
    const files=await detectAiChanges({baseSha:base,headSha:head,patterns:[]});
    assert.deepEqual(files.sort(),['prompts/new.prompt','prompts/old.prompt']);
    await assert.rejects(detectAiChanges({baseSha:'HEAD;echo unsafe',headSha:head,patterns:[]}));
  } finally {process.chdir(old);fs.rmSync(dir,{recursive:true,force:true});}
});

test('config rejects unsafe API origins and invalid thresholds', async()=>{
  for(const baseUrl of ['http://remote.example','https://token@remote.example','https://remote.example/api/']) {
    await assert.rejects(readTrustmodelConfig({...cfg,baseUrl}));
  }
  await assert.rejects(readTrustmodelConfig({...cfg,threshold:0}));
});
