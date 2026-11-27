const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { runEval, parseResult, unavailable, verifiedPass, skipped, evaluationError, commitState } = require('../dist_ts/eval.js');
const { buildComment, publishResult, statusDescription, ADVISORY_NOTE } = require('../dist_ts/comment.js');
const { detectAiChanges, detectAiChangeSet, hasAiImport, matchesDetection, MAX_IMPORT_FILE_BYTES } = require('../dist_ts/detector.js');
const { readTrustmodelConfig } = require('../dist_ts/config.js');
const { scanWebsite, normalizeWebsiteDomain } = require('../dist_ts/website.js');
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

test('unavailable results post a pending status before their comment', async()=>{
  const kit=octokit();await pub(kit);
  assert.equal(kit.calls[0][0],'status');
  assert.equal(kit.calls[0][1].state,'pending');
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

test('default detection skips user-agent, dependency and build paths (TRUS-2595)', ()=>{
  for (const f of ['user_agent.py','src/http/user-agent.ts','lib/UserAgent.ts','src/useragent_parser.js',
    'web/USER_AGENT.js','node_modules/pkg/agents/run.py','vendor/agents/x.py','dist/agent.js','.venv/lib/agents/a.py',
    'lib/python3.12/site-packages/langchain/agents/x.py','tools/build.sh','tools/data.json'])
    assert.equal(matchesDetection(f,[]),false,f);
});

test('default detection still finds AI paths (TRUS-2595)', ()=>{
  for (const f of ['agents/planner.py','src/support_agent.py','src/agentRunner.ts','src/agent.js','tools/search.py',
    'pkg/tools/sub/fetch.ts','prompts/system.md','app/x.prompt','.trustmodel.yml','evals/suite.yaml','chains/qa.py'])
    assert.equal(matchesDetection(f,[]),true,f);
});

test('custom detect patterns are not narrowed by the default excludes (TRUS-2595)', ()=>{
  assert.equal(matchesDetection('src/user_agent.py',['**/*agent*.py']),true);
  assert.equal(matchesDetection('vendor/agents/x.py',['vendor/**']),true);
  assert.equal(matchesDetection('agents/planner.py',['prompts/**']),false);
});

test('detector applies the default excludes to a real diff without reading content', async()=>{
  const old=process.cwd();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trust-excl-'));
  const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
  try {
    git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
    fs.writeFileSync(path.join(dir,'README.md'),'base');git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
    fs.mkdirSync(path.join(dir,'agents'));fs.mkdirSync(path.join(dir,'http'));
    fs.writeFileSync(path.join(dir,'agents','run.py'),'DO-NOT-UPLOAD-CONTENT');
    fs.writeFileSync(path.join(dir,'http','user_agent.py'),'import openai  # content must not matter');
    git('add','.');git('commit','-qm','head');const head=git('rev-parse','HEAD');
    process.chdir(dir);
    assert.deepEqual(await detectAiChanges({baseSha:base,headSha:head,patterns:[]}),['agents/run.py']);
  } finally {process.chdir(old);fs.rmSync(dir,{recursive:true,force:true});}
});

test('AI SDK imports are found in ordinary-looking source files on the runner (TRUS-2642)', async()=>{
  const old=process.cwd();const dir=fs.mkdtempSync(path.join(os.tmpdir(),'trust-imports-'));
  const git=(...args)=>execFileSync('git',args,{cwd:dir,encoding:'utf8'}).trim();
  const write=(f,c)=>{fs.mkdirSync(path.dirname(path.join(dir,f)),{recursive:true});fs.writeFileSync(path.join(dir,f),c);};
  try {
    git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');
    write('README.md','base');write('src/old_llm.py','from openai import OpenAI\n');
    git('add','.');git('commit','-qm','base');const base=git('rev-parse','HEAD');
    write('src/llm.py','import os\nfrom openai import OpenAI\n');
    write('src/chat.ts',"import Anthropic from '@anthropic-ai/sdk';\n");
    write('src/loader.js','const { X } = require("langchain/document_loaders");\n');
    write('src/notes.py','# use openai later\nx = "import openai"\n');            // comment and string only
    write('docs/setup.md','from openai import OpenAI\n');                          // not a source file
    write('http/user_agent.py','import openai\n');                                 // excluded path
    write('node_modules/x/index.js',"import OpenAI from 'openai';\n");            // dependency
    write('src/big.py','import openai\n'+'#'.repeat(MAX_IMPORT_FILE_BYTES));        // over the size cap
    write('src/blob.py','import openai\n\0binary');                                // binary
    write('agents/run.py','plain');                                               // path rule match
    fs.rmSync(path.join(dir,'src/old_llm.py'));                                    // deleted at head
    git('add','-A');git('commit','-qm','head');const head=git('rev-parse','HEAD');
    process.chdir(dir);
    const set=await detectAiChangeSet({baseSha:base,headSha:head,patterns:[]});
    assert.deepEqual(set.pathMatched,['agents/run.py']);
    assert.deepEqual(set.importMatched.sort(),['src/chat.ts','src/llm.py','src/loader.js']);
    // A custom detect list means exactly what it says: no import scan.
    assert.deepEqual(await detectAiChangeSet({baseSha:base,headSha:head,patterns:['agents/**']}),
                     {pathMatched:['agents/run.py'],importMatched:[]});
    // The path-only detector is unchanged.
    assert.deepEqual(await detectAiChanges({baseSha:base,headSha:head,patterns:[]}),['agents/run.py']);
  } finally {process.chdir(old);fs.rmSync(dir,{recursive:true,force:true});}
});

test('AI import matching: import statements only (TRUS-2642)', ()=>{
  for (const [f,t] of [['a.py','import openai'],['a.py','from langchain_openai import ChatOpenAI'],
    ['a.py','  from anthropic import Anthropic'],['a.py','import google.generativeai as genai'],
    ['a.py','client = boto3.client("bedrock-runtime")'],['a.ts',"import { generateText } from 'ai';"],
    ['a.ts',"import { openai } from '@ai-sdk/openai';"],['a.js',"const m = await import('openai');"],
    ['a.mjs',"import OpenAI from 'openai/index.mjs';"],['a.tsx',"import { ChatOllama } from '@langchain/ollama';"]])
    assert.equal(hasAiImport(f,t),true,t);
  for (const [f,t] of [['a.py','import openai_helpers'],['a.py','# import openai'],['a.py','x = "openai"'],
    ['a.ts',"import x from 'ai-tools';"],['a.ts',"import x from 'openai-like';"],['a.js','// uses the openai api']])
    assert.equal(hasAiImport(f,t),false,t);
});

test('import-matched paths are sent only when present, as paths (TRUS-2642)', async()=>{
  let body;
  await runEval({...opts, importMatchedFiles:['src/llm.py'], transport: async (url, req) => {
    body = JSON.parse(req.body); return json(na);
  }});
  assert.deepEqual(body.import_matched_files,['src/llm.py']);
  assert.deepEqual(body.changed_files,['agents/run.py']);
  await runEval({...opts, importMatchedFiles:[], transport: async (url, req) => { body = JSON.parse(req.body); return json(na); }});
  assert.ok(!('import_matched_files' in body));
});

test('config rejects unsafe API origins and invalid thresholds', async()=>{
  for(const baseUrl of ['http://remote.example','https://token@remote.example','https://remote.example/api/']) {
    await assert.rejects(readTrustmodelConfig({...cfg,baseUrl}));
  }
  await assert.rejects(readTrustmodelConfig({...cfg,threshold:0}));
});

test('website scan requires an explicit public domain, never guesses from a repository', () => {
  assert.equal(normalizeWebsiteDomain('TrustModel.AI'), 'trustmodel.ai');
  for (const domain of ['https://trustmodel.ai', 'trustmodel.ai/path', '127.0.0.1', 'localhost',
                        'host.internal', 'trustmodel.ai:443', 'trustmodel.ai?token=x', 'a..com']) {
    assert.throws(() => normalizeWebsiteDomain(domain));
  }
});

test('informational website request sends no API key, GitHub token, or PR data', async () => {
  const website = await scanWebsite({baseUrl: cfg.baseUrl, domain:'trustmodel.ai', transport: async (url, req) => {
    assert.equal(url, `${cfg.baseUrl}/v1/public/site-score/trustmodel.ai/`);
    assert.deepEqual(req.headers, {Accept:'application/json'});
    assert.equal(req.body, undefined);
    assert.equal(req.redirect, 'error');
    return json({domain:'trustmodel.ai',assessed:true,trust_score:100});
  }});
  const kit=octokit();
  await publishResult({octokit:kit,owner:'acme',repo:'app',prNumber:1,headSha:opts.headSha,result:unavailable(),website});
  assert.equal(kit.calls[0][1].state, 'pending');
  assert.equal(kit.calls[0][1].target_url, undefined);
  const body=kit.calls[1][1].body;
  assert.match(body,/Trust Review — not available/);
  assert.match(body,/Website TrustScore — informational/);
  assert.match(body,/100\/100/);
  assert.match(body,/not a review of this PR or its code/);
  assert.equal(verifiedPass(unavailable()),false);
});

test('invalid or mismatched website scores are unavailable, not invented zeros', async () => {
  for (const data of [null, {domain:'other.ai',assessed:true,trust_score:99},
      {domain:'trustmodel.ai',assessed:false,trust_score:99},
      {domain:'trustmodel.ai',assessed:true,trust_score:'99'},
      {domain:'trustmodel.ai',assessed:true,trust_score:101}]) {
    const result=await scanWebsite({baseUrl:cfg.baseUrl,domain:'trustmodel.ai',transport:async()=>json(data)});
    assert.equal(result.status,'unavailable');assert.equal(result.trustScore,null);
  }
});

test('website outage cannot change a verified PR result', async () => {
  const website=await scanWebsite({baseUrl:cfg.baseUrl,domain:'trustmodel.ai',transport:async()=>{throw new Error('network');}});
  const result=parseResult({status:'passed',passed:true,pr_diff_evaluated:true,trust_score:90});
  const kit=octokit();
  await publishResult({octokit:kit,owner:'acme',repo:'app',prNumber:1,headSha:opts.headSha,result,website});
  assert.equal(kit.calls[0][1].state,'success');
  assert.match(kit.calls[1][1].body,/Website TrustScore: unavailable/);
  assert.equal(result.trustScore,90);
});


test('quiet skips succeed without claiming evaluation or publishing a comment', async () => {
  const result=skipped(); const kit=octokit(); await pub(kit,result);
  assert.equal(verifiedPass(result),false);
  assert.equal(result.prDiffEvaluated,false);
  assert.equal(kit.calls.length,1);
  assert.equal(kit.calls[0][1].state,'success');
  assert.match(kit.calls[0][1].description,/skipped/);
});
test('only verified evidence passes; unavailable is pending and errors stay errors', () => {
  assert.equal(commitState(unavailable()),'pending');
  assert.equal(commitState(evaluationError()),'error');
  assert.equal(commitState(parseResult({status:'failed',passed:false,pr_diff_evaluated:true,trust_score:40})),'failure');
  assert.throws(()=>parseResult({status:'skipped',passed:false,pr_diff_evaluated:false}));
});
test('no website below is mentioned when website information is disabled', () => {
  assert.doesNotMatch(buildComment(unavailable()),/website assessment below|Website TrustScore/);
});

// ---- TRUS-2595: advisory mode (default) never blocks; enforce is today's gate ----
const failed40=()=>parseResult({status:'failed',passed:false,pr_diff_evaluated:true,trust_score:40});
const passed90=()=>parseResult({status:'passed',passed:true,pr_diff_evaluated:true,trust_score:90});
const pubMode=(kit,result,mode)=>publishResult({octokit:kit,owner:'acme',repo:'app',prNumber:1,headSha:opts.headSha,result,mode});

test('advisory: every result is a non-blocking success status', () => {
  for (const r of [unavailable(), evaluationError(), failed40(), passed90(), skipped()]) {
    assert.equal(commitState(r,'advisory'),'success', r.status);
  }
});
test('enforce keeps today\'s gate exactly', () => {
  assert.equal(commitState(unavailable(),'enforce'),'pending');
  assert.equal(commitState(evaluationError(),'enforce'),'error');
  assert.equal(commitState(failed40(),'enforce'),'failure');
  assert.equal(commitState(passed90(),'enforce'),'success');
  assert.equal(commitState(skipped(),'enforce'),'success');
});
test('advisory never reports a pass that did not happen', () => {
  for (const r of [unavailable(), evaluationError(), failed40()]) {
    assert.equal(verifiedPass(r), false, r.status);
    assert.match(statusDescription(r,'advisory'), /^Advisory, not enforced: /);
    assert.doesNotMatch(statusDescription(r,'advisory'), /evaluation passed/);
    assert.ok(statusDescription(r,'advisory').length <= 140);
  }
  assert.match(statusDescription(failed40(),'advisory'), /did not pass \(40\/100\)/);
  assert.equal(statusDescription(passed90(),'advisory'), 'Verified PR diff evaluation passed');
});
test('advisory comment says it is not blocking; a verified pass and enforce do not', () => {
  assert.ok(buildComment(failed40(),undefined,'advisory').includes(ADVISORY_NOTE));
  assert.ok(buildComment(unavailable(),undefined,'advisory').includes(ADVISORY_NOTE));
  assert.match(buildComment(failed40(),undefined,'advisory'), /not passed/);
  assert.ok(!buildComment(passed90(),undefined,'advisory').includes(ADVISORY_NOTE));
  assert.ok(!buildComment(failed40(),undefined,'enforce').includes(ADVISORY_NOTE));
});
test('advisory publishes a success status with its advisory description, then the comment', async () => {
  const kit=octokit(); await pubMode(kit, failed40(), 'advisory');
  assert.equal(kit.calls[0][1].state,'success');
  assert.equal(kit.calls[0][1].context,'trustmodel/trust-review');
  assert.match(kit.calls[0][1].description,/^Advisory, not enforced/);
  assert.ok(kit.calls[1][1].body.includes(ADVISORY_NOTE));
});
test('publishing without a mode stays enforce (no silent behaviour change for callers)', async () => {
  const kit=octokit(); await pubMode(kit, failed40(), undefined);
  assert.equal(kit.calls[0][1].state,'failure');
});
test('mode resolves input, then .trustmodel.yml, then advisory; bad values are rejected', async () => {
  const dir=fs.mkdtempSync(path.join(os.tmpdir(),'tr-mode-')); const cwd=process.cwd();
  try {
    process.chdir(dir);
    assert.equal((await readTrustmodelConfig({...cfg})).mode,'advisory');
    fs.writeFileSync('.trustmodel.yml','eval:\n  mode: enforce\n');
    assert.equal((await readTrustmodelConfig({...cfg})).mode,'enforce');
    assert.equal((await readTrustmodelConfig({...cfg,mode:'advisory'})).mode,'advisory');
    await assert.rejects(readTrustmodelConfig({...cfg,mode:'block'}));
    fs.writeFileSync('.trustmodel.yml','eval:\n  mode: true\n');
    await assert.rejects(readTrustmodelConfig({...cfg}));
  } finally { process.chdir(cwd); fs.rmSync(dir,{recursive:true,force:true}); }
});

// ---- TRUS-2605: gateway says no AI files changed -> same as the Action's own skip ----
const noAi=(extra={})=>parseResult({status:'not_available',reason:'no_ai_changes',passed:false,pr_diff_evaluated:false,trust_score:null,run_id:'63657636-7c06-4179-8352-4eef2fa61be1',...extra});
test('server no_ai_changes becomes a quiet skip in both modes, never a pass', async () => {
  const r=noAi();
  assert.equal(r.status,'skipped');
  assert.equal(verifiedPass(r),false);
  assert.equal(r.prDiffEvaluated,false);
  assert.equal(r.trustScore,null);
  for (const mode of ['advisory','enforce']) {
    assert.equal(commitState(r,mode),'success');
    const kit=octokit(); await pubMode(kit,r,mode);
    assert.equal(kit.calls.length,1);                       // status only, no comment
    assert.match(kit.calls[0][1].description,/No AI-related files changed/);
  }
});
test('no_ai_changes is honoured only on an unevaluated, non-passing not_available answer', () => {
  assert.equal(parseResult({status:'not_available',passed:false,pr_diff_evaluated:false,trust_score:null}).status,'not_available');
  assert.equal(parseResult({status:'not_available',reason:'something_else',passed:false,pr_diff_evaluated:false}).status,'not_available');
  assert.equal(parseResult({status:'error',reason:'no_ai_changes',passed:false,pr_diff_evaluated:false}).status,'error');
  assert.equal(parseResult({status:'failed',reason:'no_ai_changes',passed:false,pr_diff_evaluated:true,trust_score:40}).status,'failed');
  assert.equal(noAi({pr_diff_evaluated:true}).status,'not_available');
  assert.throws(()=>noAi({passed:true}));
});
test('server message text is never shown for no_ai_changes', () => {
  const r=noAi({message:'<script>SERVER_TEXT_SENTINEL</script>'});
  assert.doesNotMatch(r.message,/SERVER_TEXT_SENTINEL/);
});

// TRUS-2593: every reason Trust Review did not score a PR is explained on the PR,
// from the status and reason code only, never from server text.
const { notRun, ReviewApiError } = require('../dist_ts/eval.js');
const RUN = '12345678-1234-1234-1234-123456789abc';
const SECRET = 'SERVER_TEXT_MUST_NOT_REACH_THE_PR';
const refusalCases = [
  [402, {code:'insufficient_credits', detail:SECRET, run_id:RUN}, 'insufficient_credits', /not run: out of credits/, /Add credits in the TrustModel console/],
  [429, {code:'tr_daily_limit_reached', detail:SECRET, run_id:RUN}, 'daily_limit', /not run: daily limit reached/, /00:00 UTC/],
  [429, {detail:SECRET}, 'rate_limited', /not run: too many requests/, /Re-run this workflow in a minute/],
  [401, {detail:SECRET}, 'api_key_rejected', /not run: API key rejected/, /TRUSTMODEL_API_KEY/],
  [403, {detail:SECRET}, 'api_key_rejected', /not run: API key rejected/, /api_key/],
  [402, {code:'something_else', detail:SECRET}, 'service_error', /not run: service error/, /Re-run this workflow/],
  [500, {detail:SECRET}, 'service_error', /not run: service error/, /Re-run this workflow/],
];
for (const [status, body, reason, heading, next] of refusalCases) {
  test(`HTTP ${status} ${body.code ?? ''} is explained on the PR as ${reason}`, async () => {
    const error = await runEval({...opts, transport: async () => json(body, status)}).then(() => null, e => e);
    assert.ok(error instanceof ReviewApiError);
    assert.equal(error.httpStatus, status);
    assert.equal(error.reason, reason);
    const result = notRun(error.reason, error.runId);
    assert.equal(result.status, 'error');
    assert.equal(verifiedPass(result), false);
    for (const mode of ['advisory', 'enforce']) {
      const comment = buildComment(result, undefined, mode);
      assert.match(comment, heading);
      assert.match(comment, next);
      assert.match(comment, /No code was evaluated and no passing gate was issued/);
      assert.doesNotMatch(comment, new RegExp(SECRET));
      assert.doesNotMatch(statusDescription(result, mode), new RegExp(SECRET));
      assert.ok(statusDescription(result, mode).length <= 140);
    }
    assert.equal(commitState(result, 'advisory'), 'success');
    assert.equal(commitState(result, 'enforce'), 'error');
  });
}

test('out of credits keeps the run id and says so in the status', async () => {
  const error = await runEval({...opts, transport: async () => json({code:'insufficient_credits', run_id:RUN}, 402)}).then(() => null, e => e);
  assert.equal(error.runId, RUN);
  assert.match(statusDescription(notRun(error.reason), 'advisory'), /^Advisory, not enforced: TR: Not run, out of credits/);
});

test('a refusal while polling is explained the same way', async () => {
  let calls = 0;
  const error = await runEval({...opts, pollIntervalMs: 1, transport: async () => {
    calls++;
    return calls === 1 ? json({...na, status:'running', run_id:RUN}, 201) : json({code:'tr_daily_limit_reached'}, 429);
  }}).then(() => null, e => e);
  assert.equal(error.reason, 'daily_limit');
});

test('an evaluation that errored on the server says it failed, not unavailable', () => {
  const result = parseResult({status:'error', passed:false, pr_diff_evaluated:false, trust_score:null, run_id:RUN});
  assert.equal(result.reason, 'evaluation_error');
  assert.match(buildComment(result), /not run: evaluation failed/);
});

test('an unavailable evaluator keeps its original comment', () => {
  assert.match(buildComment(unavailable()), /Trust Review — not available/);
});
