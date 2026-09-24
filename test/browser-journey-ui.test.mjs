import test from 'node:test';
import assert from 'node:assert/strict';
import { browserActionError, browserActionFailure, browserActionLabel, browserBlockers, browserCaseState, browserConcurrencyLabel, browserFrameLabel, browserInstallCommand, browserJourneySteps, browserReadiness, browserRunLabel, browserUnavailable, checkedOutcome, generateRequestDialog, inspectorTab, JOURNEY_GENERATE_REQUEST, journeyActions, journeyCheckFailed, journeyCheckState, journeyCode, journeyElapsed, journeyErrorTone, journeyLastAction, journeyOpenByDefault, journeyQueueLabel, journeyRecordings, journeyRequest, journeyRevision, journeyRunRequest, journeySegments, journeySummary, orderJourneys, playwrightReady, runEngines, stageJourneyGroups, testToolbar } from '../client/src/lib/browser-test-ui.js';

const journey = { id:'happy', name:'Create and run a workflow', goal:'Execute the workflow and verify credit usage', preconditions:['Test account'], expectedOutcomes:['Result delivered and credits debited'], assertions:[], steps:[{id:'login',title:'Sign in'},{id:'execute',title:'Execute workflow'}], isolation:'shared', needsReview:false };
const run = (status, cases, extra={}) => ({id:'run',mode:'run',status,createdAt:'2026-09-23T00:00:00Z',caseIds:['happy','payment'],caseSummaries:[journey],progress:{cases},...extra});

test('a queued journey stays queued while another journey is running', () => {
  assert.equal(browserCaseState(journey,[run('running',[{id:'happy',status:'queued'},{id:'payment',status:'running'}])]).status,'queued');
});
test('edited milestones cannot inherit a successful old result', () => {
  const edited={...journey,steps:[...journey.steps,{id:'reopen',title:'Reopen and verify the saved result'}]};
  assert.notEqual(browserCaseState(edited,[run('passed',[],{results:[{caseId:'happy',status:'passed'}]})]).status,'passed');
});
test('a terminal run cannot leave its journey looking actively running', () => {
  assert.equal(browserCaseState(journey,[run('failed',[{id:'happy',status:'running'}])]).status,'failed');
});
test('skip cleanup has a distinct state and does not become success', () => {
  assert.equal(browserCaseState(journey,[run('running',[{id:'happy',status:'skipping'}])]).label,'Skipping…');
  assert.equal(browserCaseState(journey,[run('skipped',[{id:'happy',status:'skipped'}])]).label,'Skipped');
});
test('a finished run with skipped journeys is never labelled discovery or passing', () => {
  assert.equal(browserRunLabel({mode:'run',status:'completed'}),'Finished with skips');
  assert.equal(browserRunLabel({mode:'discover',status:'completed'}),'Cases ready');
  assert.equal(browserRunLabel({mode:'run',status:'blocked'}),'Blocked');
});
test('an uncertain terminal result cannot leave a milestone spinning', () => {
  assert.equal(browserJourneySteps(journey,{steps:[{id:'login',status:'running'}]},'needs_review')[0].status,'unconfirmed');
});

test('a run result needing review is distinct from an unreviewed draft', () => {
  const draft = browserCaseState({...journey,needsReview:true},[]);
  assert.deepEqual([draft.status,draft.label],['needs_review','Needs review']);
  const result = browserCaseState(journey,[run('needs_review',[{id:'happy',status:'needs_review'}],{results:[{caseId:'happy',status:'needs_review'}]})]);
  assert.deepEqual([result.status,result.label],['needs_review','Review result']);
});
test('a finished journey replays its recordings while a live one keeps its frames', () => {
  const files = ['page@' + 'b'.repeat(32) + '.webm', 'page@' + 'a'.repeat(32) + '.webm'];
  const recorded = { ...run('passed', [{ id:'happy', status:'passed', videos:files }]), id:'run/1' };
  const request = { repoPath:'/repo path', stageId:'beta', run:recorded, caseId:'happy' };
  for (const status of ['queued', 'running', 'skipping']) assert.deepEqual(journeyRecordings({ ...request, status }), [], status);
  assert.deepEqual(journeyRecordings({ ...request, run:run('passed', [{ id:'happy', status:'passed' }]), status:'passed' }), []);
  assert.deepEqual(journeyRecordings({ ...request, run:undefined, status:'passed' }), []);
  const urls = journeyRecordings({ ...request, status:'passed' });
  assert.deepEqual(urls.map(url => new URL(url, 'http://127.0.0.1').searchParams.get('file')), files);
  assert.equal(urls[0], `/api/browser/runs/run%2F1/video?repoPath=%2Frepo+path&stageId=beta&caseId=happy&file=${files[0].replace('@', '%40')}`);
});
test('a blocked journey is neither passed nor failed', () => {
  const state = browserCaseState(journey,[run('blocked',[{id:'happy',status:'blocked'}],{results:[{caseId:'happy',status:'blocked',blockers:[{kind:'account',evidence:'No test account'}]}]})]);
  assert.deepEqual([state.status,state.label,state.variant],['blocked','Blocked','outline']);
});
test('the viewport says Review to run only before any run exists', () => {
  assert.equal(browserFrameLabel({status:'needs_review'}),'Review to run');
  assert.equal(browserFrameLabel({status:'needs_review',runId:'run'}),'No browser frame');
  assert.equal(browserFrameLabel({status:'running',runId:'run'}),'Opening browser…');
  assert.equal(browserFrameLabel({status:'running',runId:'run',image:true,fresh:true}),'Live');
  assert.equal(browserFrameLabel({status:'running',runId:'run',image:true,error:'Stream unavailable'}),'Reconnecting');
  assert.equal(browserFrameLabel({status:'passed',runId:'run',image:true}),'Last frame');
});
test('payment live-mode rejections and progress failures have readable labels', () => {
  assert.equal(browserActionError('payment_live_mode_rejected'),'Live payment blocked');
  assert.equal(browserActionError('journey_progress_invalid'),'Invalid journey progress');
  assert.equal(browserActionError('toString'),'');
  assert.equal(browserActionLabel('input_text'),'Enter text');
  assert.equal(browserActionLabel('report_journey_step'),'Report milestone');
  assert.equal(browserActionLabel('sign_in_with_test_account'),'Sign in');
  assert.equal(browserActionLabel('reload_page'),'Reload');
  assert.equal(browserActionLabel('custom_tool'),'custom tool');
});
test('every worker action failure code is kept by the controller and labelled in the client', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = path => readFile(new URL(path, import.meta.url), 'utf8');
  const runner = (await source('../integrations/browser-use/runner.py')).match(/^ACTION_FAILURES = \{\n([\s\S]*?)\n\}/m)[1];
  const worker = [...runner.matchAll(/^\s+"([a-z_]+)":/gm)].map(match => match[1]);
  const controller = JSON.parse((await source('../src/browser/manager.mjs')).match(/const actionErrorCodes=new Set\((\[[^\]]*\])\)/)[1].replaceAll("'", '"'));
  assert.ok(worker.includes('credential_field_unavailable') && worker.includes('navigation_not_allowed'));
  // The controller still accepts a retired code that stored runs contain.
  assert.deepEqual([...controller].sort(), [...worker, 'journey_progress_invalid'].sort());
  for (const code of worker) assert.notEqual(browserActionError(code), '', code);
});

const checks = { id:'credits', title:'Verify credits decreased', checks:[{type:'read-number',label:'Credits',name:'creditsAfter'},{type:'compare-number',label:'Credits',name:'creditsDelta',op:'<',than:'creditsBefore'},{type:'text-visible',value:'Run complete'}] };
const priced = {...journey,steps:[{id:'balance',title:'Record starting credits',checks:[{type:'read-number',label:'Credits',name:'creditsBefore'}]},checks]};
test('milestone checks show independent results with observed numbers', () => {
  const steps = browserJourneySteps(priced,{steps:[
    {id:'balance',status:'completed',evidence:'Balance shows 120',checks:[{type:'read-number',label:'Credits',name:'creditsBefore',passed:true,observed:120}]},
    {id:'credits',status:'failed',evidence:'Workflow finished',checks:[{type:'read-number',label:'Credits',name:'creditsAfter',passed:true,observed:100},{type:'compare-number',label:'Credits',name:'creditsDelta',op:'<',than:'creditsBefore',passed:true,observed:100},{type:'text-visible',value:'Run complete',passed:false,error:'Text not visible'}]},
  ]},'failed');
  assert.deepEqual(steps.map(step => step.status),['completed','failed']);
  assert.equal(steps[0].checks[0].text,'Credits 120');
  assert.equal(steps[1].checks[1].text,'Credits 120 → 100');
  assert.deepEqual(steps[1].checks.map(check => check.result),['Passed','Passed','Failed']);
  assert.equal(steps[1].checks[2].error,'Text not visible');
  assert.equal(steps[0].evidence,'Balance shows 120');
});
test('unevaluated checks stay explicitly unchecked', () => {
  const [first] = browserJourneySteps(priced,{steps:[{id:'balance',status:'pending',checks:priced.steps[0].checks}]},'running');
  assert.equal(first.checks[0].result,'Not checked');
  assert.equal(first.checks[0].text,'Credits');
  const [, second] = browserJourneySteps(priced,null,'not_run');
  assert.equal(second.checks[1].text,'Credits < creditsBefore');
});

test('milestone segments fill only on observed completion', () => {
  const segments = journeySegments([{id:'a',status:'completed'},{id:'b',status:'running'},{id:'c',status:'blocked'},{id:'d',status:'failed'},{id:'e',status:'unconfirmed'},{id:'f',status:'pending'}]);
  assert.deepEqual(segments.map(item => item.state),['observed','current','blocked','failed','pending','pending']);
});
test('journey summaries report real milestone progress only', () => {
  const steps = [{id:'a',title:'Sign in',status:'completed'},{id:'b',title:'Execute workflow',status:'running'},{id:'c',title:'Check credits',status:'pending'}];
  assert.equal(journeySummary(steps,'running').text,'1/3 · Execute workflow');
  assert.equal(journeySummary(steps.map(step => step.status === 'running' ? {...step,status:'pending'} : step),'running').text,'1/3');
  assert.equal(journeySummary(steps,'queued').text,'');
  assert.equal(journeySummary(steps.map(step => ({...step,status:'completed'})),'passed').text,'3/3 observed');
  const blocked = journeySummary([steps[0],{...steps[1],status:'blocked'},steps[2]],'blocked');
  assert.deepEqual([blocked.text,blocked.status],['Execute workflow','blocked']);
  assert.equal(journeySummary([{...steps[0],status:'failed'}],'failed').text,'Sign in');
  assert.equal(journeySummary([],'running').text,'');
});
test('elapsed time is plain clock text', () => {
  assert.equal(journeyElapsed('2026-09-23T00:00:00Z',Date.parse('2026-09-23T00:01:05Z')),'01:05');
  assert.equal(journeyElapsed('2026-09-23T00:00:00Z',Date.parse('2026-09-23T01:02:03Z')),'1:02:03');
  assert.equal(journeyElapsed('',Date.now()),'');
  assert.equal(journeyElapsed('2026-09-23T00:00:10Z',Date.parse('2026-09-23T00:00:00Z')),'00:00');
});
test('queue reasons and the latest action come from real progress', () => {
  assert.equal(journeyQueueLabel('shared-data'),'Waiting for shared test data');
  assert.equal(journeyQueueLabel('browser'),'Waiting for a browser');
  assert.equal(journeyQueueLabel('account'),'Waiting for test account');
  assert.equal(journeyQueueLabel(undefined),'Waiting for a browser');
  assert.equal(journeyQueueLabel('toString'),'Waiting for a browser');
  assert.deepEqual(journeyLastAction({actionCount:7,lastAction:{type:'click',status:'running'}}),{type:'click',status:'running',count:7});
  assert.deepEqual(journeyLastAction({actions:[{type:'navigate',status:'passed'},{type:'input',status:'failed',errorCode:'payment_live_mode_rejected'}]}),{type:'input',status:'failed',errorCode:'payment_live_mode_rejected',count:2});
  assert.equal(journeyLastAction({actions:[]}),null);
});
test('finished runs list failures first, then blocked and review', () => {
  const summaries = ['a','b','c','d'].map(id => ({...journey,id,name:id}));
  const finished = {...run('failed',[]),caseIds:['a','b','c','d'],caseSummaries:summaries,results:[{caseId:'a',status:'passed'},{caseId:'b',status:'needs_review'},{caseId:'c',status:'blocked'},{caseId:'d',status:'failed'}]};
  assert.deepEqual(orderJourneys(summaries,finished).map(entry => entry.item.id),['d','c','b','a']);
  const active = {...finished,status:'running'};
  assert.deepEqual(orderJourneys(summaries,active).map(entry => entry.item.id),['a','b','c','d']);
});
test('forced serial execution is shown with its reason', () => {
  assert.equal(browserConcurrencyLabel({concurrency:4,effectiveConcurrency:1,concurrencyLimit:'shared-data'}),'1 of 4 browsers · Shared test data');
  assert.equal(browserConcurrencyLabel({concurrency:2,effectiveConcurrency:1,concurrencyLimit:'account'}),'1 of 2 browsers · Test account');
  assert.equal(browserConcurrencyLabel({concurrency:2,effectiveConcurrency:2}),'');
  assert.equal(browserConcurrencyLabel({}),'');
});
test('blockers name their milestone and kind', () => {
  assert.deepEqual(browserBlockers({blockers:[{stepId:'execute',kind:'integration',evidence:'Workflow runner is not configured'},{kind:'bogus',evidence:'x'}]},journey.steps),[{kind:'Integration',step:'Execute workflow',evidence:'Workflow runner is not configured'},{kind:'Blocker',step:'',evidence:'x'}]);
  assert.deepEqual(browserBlockers(null,journey.steps),[]);
});
test('the stage card promotes reviewed journeys and groups legacy cases and drafts', () => {
  const legacy = {...journey,id:'legacy',steps:[]};
  const draft = {...journey,id:'draft',needsReview:true};
  const running = {...journey,id:'old',steps:[]};
  const runs = [{...run('running',[{id:'old',status:'running'}]),caseIds:['old'],caseSummaries:[running]}];
  const groups = stageJourneyGroups([legacy,journey,draft,running],runs);
  assert.deepEqual(groups.journeys.map(item => item.id),['happy','old']);
  assert.deepEqual(groups.others.map(item => item.id),['legacy','draft']);
});
test('graph requests are parsed without confusing case IDs', () => {
  assert.deepEqual(journeyRequest(JOURNEY_GENERATE_REQUEST),{kind:'generate',caseId:''});
  assert.deepEqual(journeyRequest('new'),{kind:'new',caseId:''});
  assert.deepEqual(journeyRequest(journeyRunRequest('happy')),{kind:'run',caseId:'happy'});
  assert.deepEqual(journeyRequest('happy'),{kind:'case',caseId:'happy'});
  assert.deepEqual(journeyRequest('run:happy'),{kind:'case',caseId:'run:happy'});
  assert.deepEqual(journeyRequest('generate'),{kind:'case',caseId:'generate'});
  assert.deepEqual(journeyRequest('!unknown'),{kind:'',caseId:''});
  assert.deepEqual(journeyRequest(''),{kind:'',caseId:''});
});
test('only failed journeys show their error as a failure', () => {
  assert.equal(journeyErrorTone('failed'),'text-destructive');
  for (const status of ['blocked','needs_review','cancelled','skipped','passed']) assert.equal(journeyErrorTone(status),'text-muted-foreground');
});
test('lists open only live or failed journeys by default', () => {
  for (const status of ['queued','running','skipping','failed']) assert.equal(journeyOpenByDefault(status),true);
  for (const status of ['passed','cancelled','skipped','blocked','needs_review','completed','not_run']) assert.equal(journeyOpenByDefault(status),false);
});
test('a journey frame revision changes only with that journey\'s own events', () => {
  const first = journeyRevision({actionCount:3,steps:[{id:'login',status:'completed'},{id:'execute',status:'running'}]});
  assert.equal(first,journeyRevision({actionCount:3,steps:[{id:'login',status:'completed'},{id:'execute',status:'running'}],frameUpdatedAt:'later'}));
  assert.notEqual(first,journeyRevision({actionCount:4,steps:[{id:'login',status:'completed'},{id:'execute',status:'running'}]}));
  assert.notEqual(first,journeyRevision({actionCount:3,steps:[{id:'login',status:'completed'},{id:'execute',status:'completed'}]}));
  assert.equal(journeyRevision({actions:[{},{}]}),'2:');
  assert.equal(journeyRevision(undefined),undefined);
});
test('browser capabilities list every missing prerequisite, and unknown is not unavailable', () => {
  assert.equal(browserUnavailable(null),'');
  assert.equal(browserUnavailable({runtimeInstalled:false,modelConfigured:true}),'Install the browser runtime');
  assert.equal(browserUnavailable({runtimeInstalled:true,browserInstalled:false,modelConfigured:true}),'Install Chromium');
  assert.equal(browserUnavailable({runtimeInstalled:true,modelConfigured:false}),'Add an OpenRouter API Key');
  assert.equal(browserUnavailable({runtimeInstalled:false,browserInstalled:false,modelConfigured:false}),'Install the browser runtime\nAdd an OpenRouter API Key', 'A missing runtime never hides a missing key');
  assert.equal(browserUnavailable({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}),'');
});
test('readiness lists the target URL, browser runtime and OpenRouter API Key, each with its own fix', () => {
  const none = browserReadiness({runtimeInstalled:false,browserInstalled:false,modelConfigured:false}, false);
  assert.deepEqual(none.map(item => [item.id,item.label,item.ready]), [['target','Target URL',false],['runtime','Browser runtime',false],['model','OpenRouter API Key',false]]);
  assert.match(none[1].command, /^uv sync --project integrations\/browser-use --frozen\n/);
  assert.equal(none[0].command, undefined);
  assert.equal(none[2].command, undefined, 'The key is fixed in Settings, not with a command');
  const ready = browserReadiness({runtimeInstalled:true,browserInstalled:true,modelConfigured:true}, true);
  assert.deepEqual(ready.map(item => item.ready), [true,true,true]);
  assert.equal(ready[1].command, '');
  assert.deepEqual(browserReadiness(null, false).map(item => item.id), ['target'], 'Unknown capabilities are not listed as missing');
});
test('a graph Generate request opens Generate only when the toolbar would allow it', () => {
  assert.equal(generateRequestDialog({validTarget:true}),'generate');
  assert.equal(generateRequestDialog({validTarget:false}),'settings');
  assert.equal(generateRequestDialog({validTarget:true,unavailable:true}),null);
  assert.equal(generateRequestDialog({validTarget:false,unavailable:true}),null);
  assert.equal(generateRequestDialog({validTarget:true,disabled:true}),null);
});
test('an unreached final check is neither passed nor failed', () => {
  const unreached = {type:'text-visible',value:'Payment complete',passed:false,reached:false};
  assert.deepEqual(journeyCheckState(unreached),{label:'Not reached',variant:'outline'});
  assert.deepEqual(journeyCheckState({...unreached,passed:true}),{label:'Not reached',variant:'outline'});
  assert.deepEqual(journeyCheckState({type:'text-visible',value:'Payment complete',passed:false}),{label:'Failed',variant:'destructive'});
  assert.deepEqual(journeyCheckState({type:'text-visible',value:'Payment complete',passed:true}),{label:'Passed',variant:'outline'});
  assert.deepEqual(journeyCheckState({type:'text-visible',value:'Payment complete'}),{label:'Not checked',variant:'outline'});
});
test('finished journeys rank by the controller status alone, never by re-reading their checks', () => {
  const unreached = [{type:'text-visible',value:'Payment complete',passed:false,reached:false}];
  const summaries = ['timeout','blocked','failed'].map(id => ({...journey,id,name:id}));
  const finished = {...run('failed',[]),caseIds:summaries.map(item => item.id),caseSummaries:summaries,results:[
    {caseId:'timeout',status:'needs_review',assertions:unreached},
    {caseId:'blocked',status:'blocked',assertions:unreached,blockers:[{kind:'integration',evidence:'Stripe keys missing'}]},
    {caseId:'failed',status:'failed',assertions:[{type:'text-visible',value:'Payment complete',passed:false}]},
  ]};
  assert.deepEqual(orderJourneys(summaries,finished).map(entry => [entry.item.id,entry.status]),[['failed','failed'],['blocked','blocked'],['timeout','needs_review']]);
});
test('summary progress without an action list still shows the count and latest action', () => {
  assert.deepEqual(journeyActions({actionCount:12,lastAction:{index:11,type:'click',status:'passed'}}),{items:[{index:11,type:'click',status:'passed'}],count:12});
  const actions = [{index:0,type:'navigate',status:'passed'},{index:1,type:'click',status:'running'}];
  assert.deepEqual(journeyActions({actionCount:2,actions,lastAction:actions[1]}),{items:actions,count:2});
  assert.deepEqual(journeyActions({actions}),{items:actions,count:2});
  assert.deepEqual(journeyActions({actionCount:0}),{items:[],count:0});
  assert.deepEqual(journeyActions(undefined),{items:[],count:0});
});
test('journey evidence reads actions and final checks only through shared helpers', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = file => readFile(new URL(`../client/src/${file}`, import.meta.url), 'utf8');
  for (const file of ['JourneyEvidence.jsx','JourneyCard.jsx','RunJourneyGallery.jsx','StageJourney.jsx']) assert.doesNotMatch(await source(file), /progress\??\.actions/, file);
  const evidence = await source('JourneyEvidence.jsx');
  assert.match(evidence, /journeyCheckState\(check\)/);
  assert.doesNotMatch(evidence, /check\.passed \?/);
});
test('every case click opens its review/edit view; its run opens from the status badge', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = file => readFile(new URL(`../client/src/${file}`, import.meta.url), 'utf8');
  const panel = await source('BrowserTestingPanel.jsx');
  assert.match(panel, /if \(kind === 'case' && !initialWatch\) openCase\(item\);/);
  assert.match(panel, /onInspect=\{\(\) => openCase\(item\)\}/);
  assert.match(panel, /onViewRun=\{run \? \(\) => setWatching\(\{ \.\.\.run, focusCaseId: item\.id \}\) : undefined\}/);
  const open = panel.slice(panel.indexOf('function openCase'), panel.indexOf('async function saveCase'));
  assert.match(open, /setEditingCase\(item\)/);
  assert.doesNotMatch(open, /setWatching|perform|start\(|updateCases|setRunDialog/);
  const card = await source('JourneyCard.jsx');
  assert.match(card, /onViewRun \? <Button[^>]*aria-label=\{`View run for \$\{item\.name\}: \$\{statusLabel\}`\} onClick=\{onViewRun\}>\{badge\}<\/Button> : badge/);
  // The title opens review/edit; expanding is a separate, named chevron.
  assert.match(card, /<Button variant="link"[^>]*aria-label=\{`\$\{item\.name\}: \$\{item\.needsReview \? 'Review' : 'Edit'\}`\} onClick=\{onInspect\}>\{item\.name\}<\/Button>/);
  assert.match(card, /<CollapsibleTrigger asChild><Button variant="ghost" size="icon-sm"[^\n]*?aria-label=\{`\$\{item\.name\} details`\}><ChevronDown/);
  assert.doesNotMatch(card, /<CollapsibleTrigger asChild><Button[^>]*><CardTitle/, 'The title never only toggles the card');
  const row = await source('StageJourney.jsx');
  assert.match(row, /aria-label=\{`View run for \$\{item\.name\}: \$\{state\.label\}`\} onClick=\{\(\) => onWatch\?\.\(run\)\}/);
  assert.match(row, /data-selected=\{selected\} onClick=\{onOpen\}/);
});
test('a graph case request selects the tests tab in the same render and waits for that view', async () => {
  const opened = inspectorTab(null, 'browser', 1);
  assert.equal(opened.tab, 'browser');
  const onRuns = { ...opened, tab: 'browser-runs' };
  assert.equal(inspectorTab(onRuns, 'browser', 1), onRuns, 'The viewer keeps its own tab until a new request');
  assert.equal(inspectorTab(onRuns, 'browser', 2).tab, 'browser', 'A case clicked while Runs is showing switches back to tests');
  assert.equal(inspectorTab(null, 'browser-runs', 3).tab, 'browser-runs');
  assert.equal(inspectorTab(null, 'runs', 3).tab, 'browser');
  const { readFile } = await import('node:fs/promises');
  const panel = await readFile(new URL('../client/src/BrowserTestingPanel.jsx', import.meta.url), 'utf8');
  const effect = panel.slice(panel.indexOf("if (loading || !initialCaseId"), panel.indexOf('useEffect(() => {\n    if (loading || !initialWatch)'));
  assert.match(effect, /^if \(loading \|\| !initialCaseId \|\| view !== 'tests'\) return;/);
  assert.match(effect, /\}, \[loading, view, initialCaseId, caseRequestKey,/);
  const inspector = await readFile(new URL('../client/src/EnvironmentSettings.jsx', import.meta.url), 'utf8');
  assert.match(inspector, /const requested = inspectorTab\(tabState, initialTab, caseRequestKey\);\n  if \(requested !== tabState\) setTabState\(requested\);/);
  assert.doesNotMatch(inspector, /useEffect\(\(\) => \{ setTab/);
});
test('the runtime and Chromium show their install command; a configured runtime has none', () => {
  assert.equal(browserInstallCommand(null), '');
  assert.equal(browserInstallCommand({runtimeInstalled:true,browserInstalled:true,modelConfigured:false}), '');
  assert.equal(browserInstallCommand({runtimeInstalled:true,browserInstalled:false,modelConfigured:false}), 'uv run --project integrations/browser-use python -m playwright install chromium');
  assert.equal(browserInstallCommand({runtimeInstalled:false,browserInstalled:false,modelConfigured:true}), 'uv sync --project integrations/browser-use --frozen\nuv run --project integrations/browser-use python -m playwright install chromium');
  assert.equal(browserInstallCommand({runtimeInstalled:false,runtimeProject:'/opt/perpetual/integrations/browser-use'}).split('\n')[0], 'uv sync --project /opt/perpetual/integrations/browser-use --frozen');
  assert.match(browserInstallCommand({runtimeInstalled:false,runtimeProject:'/tmp/x; rm -rf ~'}), /^uv sync --project integrations\/browser-use /, 'An unsafe path never reaches a copyable command');
});
test('the first unmet prerequisite is primary and each disabled action lists every blocker', () => {
  const capabilities = {runtimeInstalled:true,browserInstalled:true,modelConfigured:true};
  const base = {readiness:browserReadiness(capabilities, true),caseCount:2,selectedCount:1,maxCases:60};
  assert.deepEqual(testToolbar({...base,readiness:browserReadiness(capabilities, false)}), {primary:'target',blockers:{target:'',generate:'Set a target URL',add:'',run:'Set a target URL'}});
  const nothing = testToolbar({...base,readiness:browserReadiness({runtimeInstalled:false,browserInstalled:false,modelConfigured:false}, false)});
  assert.equal(nothing.primary, 'target');
  assert.equal(nothing.blockers.generate, 'Set a target URL\nInstall the browser runtime\nAdd an OpenRouter API Key', 'A missing target URL never hides the other blockers');
  assert.equal(nothing.blockers.run, nothing.blockers.generate);
  assert.deepEqual(testToolbar({...base,readiness:browserReadiness({...capabilities,runtimeInstalled:false}, true)}).blockers, {target:'',generate:'Install the browser runtime',add:'',run:'Install the browser runtime'});
  assert.equal(testToolbar({...base,readiness:browserReadiness({...capabilities,runtimeInstalled:false}, true)}).primary, 'runtime');
  assert.equal(testToolbar({...base,readiness:browserReadiness({...capabilities,modelConfigured:false}, true)}).primary, 'model');
  assert.equal(testToolbar({...base,caseCount:0,selectedCount:0}).primary, 'generate');
  const unselected = testToolbar({...base,selectedCount:0});
  assert.deepEqual([unselected.primary,unselected.blockers.run,unselected.blockers.generate], ['','Select tests','']);
  assert.deepEqual(testToolbar(base), {primary:'run',blockers:{target:'',generate:'',add:'',run:''}});
  assert.deepEqual(testToolbar({...base,wait:'Run in progress'}).blockers, {target:'Run in progress',generate:'Run in progress',add:'Run in progress',run:'Run in progress'});
  assert.equal(testToolbar({...base,caseCount:60}).blockers.add, 'Limit of 60 tests');
});
test('blocked actions stay focusable Buttons with their own Tooltip; readiness hides once met', async () => {
  const { readFile } = await import('node:fs/promises');
  const panel = await readFile(new URL('../client/src/BrowserTestingPanel.jsx', import.meta.url), 'utf8');
  for (const action of ['generate', 'run']) assert.match(panel, new RegExp(`<BlockedButton reason=\\{toolbar\\.blockers\\.${action}\\} size="sm" variant=\\{emphasis\\('${action}'\\)\\}`));
  assert.match(panel, /<BlockedButton reason=\{toolbar\.blockers\.add\} size="sm" variant="outline"/);
  // A narrow inspector keeps the three actions and their labels on one filled row; a label that cannot fit takes a full row.
  assert.match(panel, /<div className="test-toolbar @container flex flex-wrap items-center gap-2">\s*<div className="flex flex-wrap items-center gap-2 @max-md:w-full">/);
  assert.match(panel, /const NARROW_TOOL = '@max-md:flex-1 @max-md:\[&>svg\]:hidden';/);
  for (const label of ['<Sparkles />Generate', '<Plus />Add test', '<Play />Run selected']) assert.match(panel, new RegExp(`className=\\{NARROW_TOOL\\}[^\\n]*>${label.replace(/[/]/g, '\\/')}`));
  assert.match(panel, /<BlockedButton reason=\{targetBlocker\} size="sm" variant=\{primary === 'target' \? 'default' : 'outline'\} onClick=\{onTarget\}>Set target URL<\/BlockedButton>/);
  const blocked = panel.slice(panel.indexOf('function BlockedButton'), panel.indexOf('function InstallCommand'));
  assert.match(blocked, /<TooltipTrigger asChild><Button \{\.\.\.props\} variant=\{variant\} aria-disabled=\{reason \? true : undefined\}/);
  assert.match(blocked, /onClick=\{event => \{ if \(reason\) event\.preventDefault\(\); else onClick\?\.\(event\); \}\}/);
  assert.match(blocked, /reason\.split\('\\n'\)/, 'The Tooltip lists each blocker on its own line');
  assert.doesNotMatch(panel, /tabIndex=\{reason \? 0/, 'No focusable wrapper without a role or name');
  assert.doesNotMatch(panel, /<span[^>]*tabIndex=\{/);
  const readiness = panel.slice(panel.indexOf('function Readiness'), panel.indexOf('// Run-only account'));
  assert.match(readiness, /<ItemGroup aria-label="Readiness"/);
  assert.match(readiness, /<span className="sr-only">\{item\.ready \? ': ready' : ': missing'\}<\/span>/);
  assert.match(readiness, /item\.id === 'model' && <ItemActions><Button[^\n]*?onClick=\{\(\) => onAppSettings\?\.\(\)\}>Settings<\/Button>/);
  assert.match(readiness, /item\.command && <ItemFooter><InstallCommand command=\{item\.command\} \/><\/ItemFooter>/);
  assert.match(panel, /const showReadiness = !loading && readiness\.some\(item => !item\.ready\);/);
  assert.match(panel, /\{showReadiness && <Readiness items=\{readiness\}/);
  assert.doesNotMatch(panel, /browserSetupFix|setupFix/);
  const install = panel.slice(panel.indexOf('function InstallCommand'), panel.indexOf('function Readiness'));
  assert.doesNotMatch(install, /break-all/, 'Tokens such as playwright never split mid-word');
  assert.match(install, /\[overflow-wrap:anywhere\]/);
  assert.match(install, /command\.split\('\/'\)\.map\(\(part, index\) => index \? <Fragment key=\{index\}>\/<wbr \/>\{part\}<\/Fragment> : part\)/);
});
test('cancelling a live run asks first with Keep running as the default', async () => {
  const { readFile } = await import('node:fs/promises');
  const viewer = await readFile(new URL('../client/src/BrowserAgentViewer.jsx', import.meta.url), 'utf8');
  assert.match(viewer, /<AlertDialogTrigger asChild><Button[^>]*>[^\n]*'Cancel run'/);
  assert.match(viewer, /<AlertDialogCancel>Keep running<\/AlertDialogCancel><AlertDialogAction variant="destructive" onClick=\{\(\) => \{ void stop\(\); \}\}>Cancel run<\/AlertDialogAction>/);
  assert.doesNotMatch(viewer, /onClick=\{stop\}/);
  // The viewer's own close is named apart from Cancel run.
  assert.match(viewer, /showCloseButton=\{false\}/);
  assert.match(viewer, /<DialogClose asChild><Button[^>]*aria-label="Close viewer"><X \/><\/Button><\/DialogClose>/);
});
test('a failed browser action names its failure in text', () => {
  assert.equal(browserActionFailure({type:'click',status:'failed',errorCode:'navigation_not_allowed'}),'Navigation blocked');
  assert.equal(browserActionFailure({type:'click',status:'failed',errorCode:'unknown_code'}),'Failed');
  assert.equal(browserActionFailure({type:'click',status:'failed'}),'Failed');
  assert.equal(browserActionFailure({type:'click',status:'passed',errorCode:'navigation_not_allowed'}),'');
  assert.equal(browserActionFailure(undefined),'');
});
test('journey status text is at least 12px and unreached final checks never read as failures', async () => {
  const { readFile } = await import('node:fs/promises');
  const source = file => readFile(new URL(`../client/src/${file}`, import.meta.url), 'utf8');
  for (const file of ['BrowserTestingPanel.jsx','BrowserAgentViewer.jsx','BrowserLiveFrame.jsx','JourneyCard.jsx','JourneyEvidence.jsx','JourneySteps.jsx','RunJourneyGallery.jsx','StageJourney.jsx','StageJourneyList.jsx']) assert.doesNotMatch(await source(file), /text-\[(?:[0-9]|1[01])px\]/, file);
  const viewer = await source('BrowserAgentViewer.jsx');
  assert.match(viewer, /journeyCheckState\(assertion\)/);
  assert.match(viewer, /assertions\?\.some\(journeyCheckFailed\)/);
  assert.doesNotMatch(viewer, /assertion\.passed \?/);
});

test('the exploration view shows the agent summary of a finished discovery beside its error, with no added copy', async () => {
  const { readFile } = await import('node:fs/promises');
  const viewer = await readFile(new URL('../client/src/BrowserAgentViewer.jsx', import.meta.url), 'utf8');
  assert.match(viewer, /\|\| run\?\.error\}<\/p>/, 'The run error stays in the viewer.');
  assert.match(viewer, /\{snapshot\?\.discovery\?\.summary && <p className="[^"]*whitespace-pre-wrap[^"]*">\{snapshot\.discovery\.summary\}<\/p>\}/);
});

test('Playwright is offered only when every chosen case has current code, and its evidence is never an agent claim', () => {
  const other = { ...journey, id: 'other' }, current = { hash: 'a'.repeat(64), approved: true, stale: false };
  assert.equal(playwrightReady([journey, other], { happy: current, other: current }), true);
  assert.equal(playwrightReady([journey, other], { happy: current, other: { ...current, approved: false } }), true, 'A person may run a current draft.');
  for (const specs of [undefined, {}, { happy: current }, { happy: current, other: { ...current, stale: true } }, { happy: current, other: { generation: { status: 'running' } } }]) assert.equal(playwrightReady([journey, other], specs), false, JSON.stringify(specs));
  assert.equal(playwrightReady([], { happy: current }), false);
  // Without a model only Playwright can run, and only cases with current approved specs.
  const noModel = { runtimeInstalled: true, modelConfigured: false };
  assert.deepEqual(runEngines(noModel, [journey, other], { happy: current, other: current }), { browserUse: false, playwright: true });
  assert.deepEqual(runEngines(noModel, [journey], {}), { browserUse: false, playwright: false });
  assert.deepEqual(runEngines({ runtimeInstalled: true, modelConfigured: true }, [journey], {}), { browserUse: true, playwright: false });
  // Only a final assertion evaluated on the reached end state fails the expected outcomes.
  const outcome = result => [checkedOutcome(result).label, checkedOutcome(result).variant];
  assert.deepEqual(outcome({ status: 'passed', assertions: [{ passed: true }] }), ['Checks · Passed', 'outline']);
  assert.deepEqual(outcome({ status: 'failed', assertions: [{ passed: false }] }), ['Checks · Failed', 'destructive']);
  assert.deepEqual(outcome({ status: 'failed', assertions: [] }), ['Checks · Not reached', 'outline'], 'A failed milestone check stopped the journey before its end state.');
  assert.deepEqual(outcome({ status: 'failed', assertions: [{ passed: false, reached: false }] }), ['Checks · Not reached', 'outline']);
  assert.deepEqual(outcome({ status: 'needs_review', assertions: [] }), ['Checks · Not confirmed', 'outline']);
  const steps = browserJourneySteps(journey, { steps: [{ id: 'login', status: 'completed', evidence: 'Reviewed checks passed.', provenance: 'playwright' }] }, 'passed');
  assert.equal(steps[0].provenance, 'playwright');
});

test('journey code reads as Draft, Approved or Stale, is approvable only after a passing run of the draft, and shows its generation', () => {
  const hash = 'a'.repeat(64);
  assert.deepEqual(journeyCode(undefined), { state: '', generating: false, error: '', approvable: false });
  assert.deepEqual(journeyCode({ hash, approved: false, stale: false }), { state: 'Draft', generating: false, error: '', approvable: false });
  assert.equal(journeyCode({ hash, approved: false, stale: false, verified: true }).approvable, true);
  assert.equal(journeyCode({ hash, approved: false, stale: true, verified: true }).approvable, false);
  assert.equal(journeyCode({ hash, approved: true, stale: false, verified: true }).state, 'Approved');
  assert.equal(journeyCode({ hash, approved: true, stale: true }).state, 'Stale');
  assert.deepEqual(journeyCode({ generation: { status: 'running', step: 'generating' } }), { state: '', generating: true, error: '', approvable: false });
  assert.equal(journeyCode({ hash, approved: false, stale: false, generation: { status: 'failed', error: 'The code generator stopped.' } }).error, 'The code generator stopped.');
});
