// End-to-end run of hevy2whoop against a fake Hevy API and a fake totem MCP server.
// Covers docs/failure-scenarios.md (CLI and MCP server) and writes artifacts/e2e-result.json.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ARTIFACT = path.join(ROOT, 'artifacts', 'e2e-result.json');
const API_KEY = 'test-key';
const VALID_IDS = ['BENCHPRESS_BARBELL', 'SIDEPLANKELBOWLEFT', 'SIDEPLANKELBOWRIGHT', 'PUSHUP_CLASSIC'];
const MAPPING = {
  BENCH: { hevy: 'Bench Press (Barbell)', whoop: ['BENCHPRESS_BARBELL'], approximate: false, note: '' },
  WARM: { hevy: 'Warm Up', whoop: [], approximate: false, note: 'not logged' },
  SIDEPLANK: { hevy: 'Side Plank', whoop: ['SIDEPLANKELBOWLEFT', 'SIDEPLANKELBOWRIGHT'], approximate: false, note: '' },
  PUSHUP: { hevy: 'Push Up', whoop: ['PUSHUP_CLASSIC'], approximate: false, note: '' },
  BAD: { hevy: 'Broken Entry', whoop: ['NOT_A_WHOOP_EXERCISE'], approximate: false, note: '' },
};

const BASE = Date.parse('2026-10-30T15:00:00Z');
const DAY = 24 * 60 * 60 * 1000;
const set = (type, weight_kg, reps) => ({ type, weight_kg, reps });
const exercise = (exercise_template_id, title, sets) => ({ exercise_template_id, title, sets });
const bench = exercise('BENCH', 'Bench Press (Barbell)', [set('warmup', 40, 10), set('normal', 80, 8), set('failure', 80, 6)]);
function workout(id, title, daysAgo, exercises) {
  const start = BASE - daysAgo * DAY;
  return { id, title, start_time: new Date(start).toISOString(), end_time: new Date(start + 60 * 60 * 1000).toISOString(), exercises };
}

const hevy = { workouts: [], status: 200, requests: [] };
const server = http.createServer((request, response) => {
  const url = new URL(request.url, 'http://localhost');
  hevy.requests.push(url.pathname + url.search);
  if (hevy.status !== 200 || request.headers['api-key'] !== API_KEY) {
    response.writeHead(hevy.status === 200 ? 401 : hevy.status, { 'content-type': 'application/json' });
    return response.end('{"error":"Unauthorized"}');
  }
  const page = Number(url.searchParams.get('page'));
  const pageSize = Number(url.searchParams.get('pageSize'));
  const pageCount = Math.max(1, Math.ceil(hevy.workouts.length / pageSize));
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify({ page, page_count: pageCount, workouts: hevy.workouts.slice((page - 1) * pageSize, page * pageSize) }));
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));

const work = fs.mkdtempSync(path.join(os.tmpdir(), 'hevy2whoop-e2e-'));
const binWithTotem = path.join(work, 'bin');
const binWithoutTotem = path.join(work, 'empty-bin');
fs.mkdirSync(binWithTotem);
fs.mkdirSync(binWithoutTotem);
fs.writeFileSync(path.join(binWithTotem, 'totem'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(ROOT, 'test', 'fake-totem.mjs')}" "$@"\n`, { mode: 0o755 });
const toolDir = path.join(work, 'tool');
fs.mkdirSync(toolDir);
fs.copyFileSync(path.join(ROOT, 'hevy2whoop.mjs'), path.join(toolDir, 'hevy2whoop.mjs'));
const stateFile = path.join(work, 'totem-state.json');
const home = path.join(work, 'home');

function prepare({ workouts = [], hevyStatus = 200, activities = [], mode = 'ok', failNames = [], mapping = JSON.stringify(MAPPING) } = {}) {
  fs.rmSync(home, {recursive: true, force: true});
  fs.mkdirSync(home);
  hevy.workouts = workouts;
  hevy.status = hevyStatus;
  hevy.requests = [];
  fs.writeFileSync(path.join(toolDir, 'mapping.json'), mapping);
  fs.writeFileSync(stateFile, JSON.stringify({ activities, validIds: VALID_IDS, mode, failNames, calls: [], started: 0 }));
}

function environment({ apiKey = API_KEY, totem = true, extra = {} } = {}) {
  return {
    PATH: totem ? `${binWithTotem}:${process.env.PATH}` : binWithoutTotem,
    HEVY_API_URL: `http://127.0.0.1:${server.address().port}`,
    FAKE_TOTEM_STATE: stateFile,
    TZ: 'Europe/Istanbul',
    HOME: home,
    ...(apiKey ? { HEVY_API_KEY: apiKey } : {}),
    ...extra,
  };
}

const readTotemState = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));

function run(args, options) {
  const env = environment(options);
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(toolDir, 'hevy2whoop.mjs'), ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      const totemState = readTotemState();
      resolve({ args, code, stdout, stderr, hevyRequests: [...hevy.requests], totemStarted: totemState.started, whoopCalls: totemState.calls, activities: totemState.activities });
    });
  });
}

// Sends the requests to `hevy2whoop mcp`, closes stdin and waits for the server to exit.
function mcpSession(requests, options) {
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(toolDir, 'hevy2whoop.mjs'), 'mcp'], { env: environment(options) });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      const lines = stdout.split('\n').filter(Boolean);
      const parsed = lines.map(line => { try { return JSON.parse(line); } catch { return null; } });
      const totemState = readTotemState();
      const aliveTotems = (totemState.pids || []).filter(pid => { try { process.kill(pid, 0); return true; } catch { return false; } });
      const responses = Object.fromEntries(parsed.filter(Boolean).map(message => [message.id, message]));
      resolve({ args: ['mcp'], requests, code, stdout, stderr, onlyJsonRpc: parsed.every(message => message?.jsonrpc === '2.0'), responses,
        hevyRequests: [...hevy.requests], totemStarted: totemState.started, aliveTotems, whoopCalls: totemState.calls, activities: totemState.activities });
    });
    for (const request of requests) child.stdin.write(JSON.stringify({ jsonrpc: '2.0', ...request }) + '\n');
    child.stdin.end();
  });
}
const initialize = { id: 0, method: 'initialize', params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'e2e', version: '0' } } };
const initialized = { method: 'notifications/initialized' };
const toolCall = (id, name, args) => ({ id, method: 'tools/call', params: { name, arguments: args } });
const toolValue = response => JSON.parse(response.result.content[0].text);

const logCalls = result => result.whoopCalls.filter(call => call.name === 'whoop_lift_log');
const writes = result => logCalls(result).filter(call => call.arguments.confirm === true);
const results = [];
async function scenario(id, description, steps) {
  const runs = [];
  const checks = [];
  const expect = (condition, label) => checks.push({ label, passed: Boolean(condition) });
  try {
    await steps({
      run: async (...args) => { const result = await run(...args); runs.push(result); return result; },
      mcp: async (...args) => { const result = await mcpSession(...args); runs.push(result); return result; },
      expect,
    });
  } catch (error) {
    checks.push({ label: `no exception (${error.message})`, passed: false });
  }
  const passed = checks.length > 0 && checks.every(check => check.passed);
  results.push({ id, description, passed, checks, runs });
  console.log(`${passed ? 'PASS' : 'FAIL'} ${id} ${description}`);
  for (const check of checks.filter(check => !check.passed)) console.log(`     failed: ${check.label}`);
}

const latest = workout('w1', 'Push Day', 0, [bench]);

await scenario('F1', 'HEVY_API_KEY not set', async ({ run, expect }) => {
  prepare({ workouts: [latest] });
  const r = await run(['sync'], { apiKey: null });
  expect(r.code === 1, 'exit 1');
  expect(r.stderr.includes('HEVY_API_KEY'), 'message names HEVY_API_KEY');
  expect(r.hevyRequests.length === 0 && r.totemStarted === 0, 'Hevy and WHOOP not contacted');
});

await scenario('F2', 'Hevy API returns 401 or 500', async ({ run, expect }) => {
  for (const status of [401, 500]) {
    prepare({ workouts: [latest], hevyStatus: status });
    const r = await run(['sync', '--write']);
    expect(r.code === 1, `exit 1 on ${status}`);
    expect(r.stderr.includes(String(status)), `message shows ${status}`);
    expect(r.totemStarted === 0, `WHOOP not contacted on ${status}`);
  }
});

await scenario('F3', 'No workout, or none in range', async ({ run, expect }) => {
  prepare({ workouts: [] });
  const empty = await run(['sync']);
  expect(empty.code === 0 && empty.stdout.includes('No Hevy workout found.'), 'empty account: exit 0 with message');
  prepare({ workouts: [latest] });
  const outside = await run(['sync', '--from', '2026-01-01', '--to', '2026-01-31']);
  expect(outside.code === 0 && outside.stdout.includes('No Hevy workout found.'), 'empty range: exit 0 with message');
});

await scenario('F4', 'totem not installed', async ({ run, expect }) => {
  prepare({ workouts: [latest] });
  const r = await run(['sync'], { totem: false });
  expect(r.code === 1, 'exit 1');
  expect(r.stderr.includes('npm install -g @thebriangao/totem'), 'installation instructions shown');
});

await scenario('F5', 'WHOOP token expired', async ({ run, expect }) => {
  prepare({ workouts: [latest], mode: 'expired' });
  const r = await run(['sync', '--write']);
  expect(r.code === 1, 'exit 1');
  expect(r.stdout.includes('401') && r.stdout.includes('totem auth'), 'WHOOP error and `totem auth` hint shown');
});

await scenario('F6', 'Workout already in WHOOP; repeated --write is idempotent', async ({ run, expect }) => {
  const start = Date.parse(latest.start_time), end = Date.parse(latest.end_time);
  prepare({ workouts: [latest], activities: [{ id: 'existing-1', sport_name: 'weightlifting_msk', start: new Date(start + 60000).toISOString(), end: new Date(end - 90000).toISOString() }] });
  const existing = await run(['sync', '--write']);
  expect(existing.stdout.includes('already in WHOOP: activity existing-1'), 'existing activity reported');
  expect(logCalls(existing).length === 0, 'log tool not called');
  prepare({ workouts: [latest], activities: [{ id: 'other-sport', sport_name: 'running', start: latest.start_time, end: latest.end_time }] });
  const first = await run(['sync', '--write']);
  const second = await run(['sync', '--write']);
  expect(first.stdout.includes('written: activity activity-2'), 'first run writes');
  expect(second.stdout.includes('already in WHOOP: activity activity-2'), 'second run finds the written activity');
  expect(writes(second).length === 1, 'exactly one write across both runs');
});

await scenario('F7 F8 F11 F12 F13', 'Unmapped, skipped, two-sided, warm-up and bodyweight sets', async ({ run, expect }) => {
  prepare({ workouts: [workout('w2', 'Mixed Day', 0, [
    bench,
    exercise('CABLEFLY', 'Cable Fly', [set('normal', 20, 12)]),
    exercise('WARM', 'Warm Up', [set('normal', null, null)]),
    exercise('SIDEPLANK', 'Side Plank', [set('normal', null, null)]),
    exercise('PUSHUP', 'Push Up', [set('normal', null, 15)]),
  ])] });
  const r = await run(['sync', '--write']);
  const payload = writes(r)[0]?.arguments;
  expect(r.code === 0, 'exit 0');
  expect(r.stdout.includes('unmapped: Cable Fly (template CABLEFLY)'), 'F7 unmapped exercise reported with template ID');
  expect(r.stdout.includes('skipped by mapping: Warm Up'), 'F8 skipped exercise reported');
  expect(JSON.stringify(payload?.exercises.map(e => e.exercise_id)) === JSON.stringify(['BENCHPRESS_BARBELL', 'SIDEPLANKELBOWLEFT', 'SIDEPLANKELBOWRIGHT', 'PUSHUP_CLASSIC']), 'F7 F11 mapped exercises written, side plank to both sides');
  expect(payload?.exercises[0].sets.length === 2 && payload.exercises[0].sets[0].weight === 80, 'F12 warm-up set excluded');
  const sidePlankSet = payload?.exercises[1].sets[0];
  const pushUpSet = payload?.exercises[3].sets[0];
  expect(sidePlankSet?.reps === 0 && !('weight' in sidePlankSet), 'F13 set without reps sends reps 0 and no weight');
  expect(pushUpSet?.reps === 15 && !('weight' in pushUpSet), 'F13 bodyweight set has no weight');
  expect(r.stdout.includes('written: activity activity-1 (4 exercises, 5 sets)'), 'summary counts exercises and sets');
});

await scenario('F9', 'Nothing writable in the workout', async ({ run, expect }) => {
  prepare({ workouts: [workout('w3', 'Warm-up Only', 0, [
    exercise('BENCH', 'Bench Press (Barbell)', [set('warmup', 40, 10)]),
    exercise('WARM', 'Warm Up', [set('normal', null, null)]),
    exercise('CABLEFLY', 'Cable Fly', [set('normal', 20, 12)]),
  ])] });
  const r = await run(['sync', '--write']);
  expect(r.code === 0 && r.stdout.includes('nothing to write'), 'nothing to write reported');
  expect(r.whoopCalls.length === 0, 'no WHOOP tool called');
});

await scenario('F10', 'Mapping names an unknown WHOOP exercise ID', async ({ run, expect }) => {
  prepare({ workouts: [workout('w4', 'Broken Day', 0, [exercise('BAD', 'Broken Entry', [set('normal', 10, 10)])])] });
  const r = await run(['sync']);
  expect(r.code === 1, 'exit 1');
  expect(r.stdout.includes('Unknown exercise IDs') && r.stdout.includes('NOT_A_WHOOP_EXERCISE'), 'totem error shown');
});

await scenario('F14', 'Preview without --write', async ({ run, expect }) => {
  prepare({ workouts: [latest] });
  const r = await run(['sync']);
  expect(r.code === 0 && r.stdout.includes('preview: would write 1 exercises, 2 sets'), 'preview reported');
  expect(logCalls(r).length === 1 && writes(r).length === 0, 'log tool called only with confirm false');
  expect(r.activities.length === 0, 'no activity created');
});

await scenario('F15', 'Invalid date arguments', async ({ run, expect }) => {
  prepare({ workouts: [latest] });
  for (const args of [['--from', '2026-13-01', '--to', '2026-12-01'], ['--from', '2026-10-01'], ['--from', '2026-10-20', '--to', '2026-10-10'], ['--since', '2026-10-01']]) {
    const r = await run(['sync', ...args]);
    expect(r.code === 1 && r.stderr.includes('Usage:'), `exit 1 with usage for ${args.join(' ')}`);
    expect(r.hevyRequests.length === 0, `Hevy not contacted for ${args.join(' ')}`);
  }
});

await scenario('F16', 'Range across Hevy pages', async ({ run, expect }) => {
  prepare({ workouts: Array.from({ length: 25 }, (_, day) => workout(`d${day}`, `Day ${day}`, day, [bench])) });
  const r = await run(['sync', '--from', '2026-10-15', '--to', '2026-10-18']);
  const titles = [...r.stdout.matchAll(/ {2}(Day \d+)\n/g)].map(match => match[1]);
  expect(JSON.stringify(titles) === JSON.stringify(['Day 15', 'Day 14', 'Day 13', 'Day 12']), 'exactly the four workouts in range, oldest first');
  expect(JSON.stringify(r.hevyRequests) === JSON.stringify(['/v1/workouts?page=1&pageSize=10', '/v1/workouts?page=2&pageSize=10']), 'reads pages 1 and 2, stops before page 3');
});

await scenario('F17', 'One workout fails, the next is still written', async ({ run, expect }) => {
  prepare({ workouts: [workout('w6', 'Second', 1, [bench]), workout('w5', 'First', 2, [bench])], failNames: ['First'] });
  const r = await run(['sync', '--from', '2026-10-28', '--to', '2026-10-29', '--write']);
  expect(r.code === 1, 'exit 1');
  expect(/First\n {2}error: whoop_lift_log: .*500/.test(r.stdout), 'failure of the first workout reported');
  expect(/Second\n {2}written: activity/.test(r.stdout), 'second workout written');
});

await scenario('F18', 'mapping.json is not valid JSON', async ({ run, expect }) => {
  prepare({ workouts: [latest], mapping: '{ "BENCH": ' });
  const r = await run(['sync']);
  expect(r.code === 1 && r.stderr.includes('mapping.json'), 'exit 1 naming mapping.json');
  expect(r.totemStarted === 0, 'WHOOP not contacted');
});

await scenario('C1', 'catalog lists WHOOP exercise IDs', async ({ run, expect }) => {
  prepare();
  const r = await run(['catalog', 'plank']);
  expect(r.code === 0, 'exit 0');
  expect(r.stdout === 'SIDEPLANKELBOWLEFT\tName of SIDEPLANKELBOWLEFT\nSIDEPLANKELBOWRIGHT\tName of SIDEPLANKELBOWRIGHT\n', 'filtered ID list printed');
});

await scenario('M1 M8 M10', 'MCP tools/list; stdout is JSON-RPC only; server exits on stdin close', async ({ mcp, expect }) => {
  prepare({ workouts: [latest] });
  const r = await mcp([initialize, initialized, { id: 1, method: 'tools/list' }, toolCall(2, 'hevy2whoop_sync', {})]);
  expect(r.responses[0]?.result?.serverInfo?.name === 'hevy2whoop', 'initialize answered');
  const tools = r.responses[1]?.result?.tools || [];
  expect(JSON.stringify(tools.map(tool => tool.name)) === JSON.stringify(['hevy2whoop_sync', 'hevy2whoop_catalog']), 'M1 both tools listed');
  expect(tools.every(tool => tool.inputSchema?.type === 'object'), 'M1 input schemas present');
  expect(r.onlyJsonRpc, 'M8 every stdout line is a JSON-RPC message');
  expect(r.code === 0, 'M10 server exits with code 0 after stdin closes');
  expect(r.totemStarted === 1 && r.aliveTotems.length === 0, 'M10 no totem process left running');
});

await scenario('M2', 'MCP sync preview', async ({ mcp, expect }) => {
  prepare({ workouts: [workout('w7', 'Preview Day', 0, [bench, exercise('CABLEFLY', 'Cable Fly', [set('normal', 20, 12)]), exercise('WARM', 'Warm Up', [set('normal', null, null)])])] });
  const r = await mcp([initialize, toolCall(1, 'hevy2whoop_sync', {})]);
  const result = toolValue(r.responses[1]).workouts[0];
  expect(r.responses[1].result.isError === false, 'not an error');
  expect(result?.status === 'preview' && result.exercise_count === 1 && result.set_count === 2, 'status preview with counts');
  expect(JSON.stringify(result?.unmapped) === JSON.stringify([{ title: 'Cable Fly', template_id: 'CABLEFLY' }]), 'unmapped exercise listed');
  expect(JSON.stringify(result?.skipped) === JSON.stringify(['Warm Up']), 'skipped exercise listed');
  expect(writes(r).length === 0 && r.activities.length === 0, 'nothing written');
});

await scenario('M3', 'MCP sync with write, called twice', async ({ mcp, expect }) => {
  prepare({ workouts: [latest] });
  const r = await mcp([initialize, toolCall(1, 'hevy2whoop_sync', { write: true }), toolCall(2, 'hevy2whoop_sync', { write: true })]);
  const first = toolValue(r.responses[1]).workouts[0];
  const second = toolValue(r.responses[2]).workouts[0];
  expect(first?.status === 'written' && first.activity_id === 'activity-1', 'first call writes');
  expect(second?.status === 'already_in_whoop' && second.activity_id === 'activity-1', 'second call finds the activity');
  expect(writes(r).length === 1, 'one write in total');
});

await scenario('M4', 'MCP sync where WHOOP fails for one workout', async ({ mcp, expect }) => {
  prepare({ workouts: [workout('w9', 'Second', 1, [bench]), workout('w8', 'First', 2, [bench])], failNames: ['First'] });
  const r = await mcp([initialize, toolCall(1, 'hevy2whoop_sync', { from: '2026-10-28', to: '2026-10-29', write: true }), { id: 2, method: 'ping' }]);
  const [first, second] = toolValue(r.responses[1]).workouts;
  expect(r.responses[1].result.isError === true, 'result marked isError');
  expect(first?.status === 'error' && first.error.includes('500'), 'error of the first workout reported');
  expect(second?.status === 'written', 'second workout written');
  expect(r.responses[2]?.result !== undefined, 'server still answers');
});

await scenario('M5', 'MCP sync without HEVY_API_KEY or with invalid dates', async ({ mcp, expect }) => {
  prepare({ workouts: [latest] });
  const missingKey = await mcp([initialize, toolCall(1, 'hevy2whoop_sync', {})], { apiKey: null });
  expect(missingKey.responses[1]?.result?.isError === true && missingKey.responses[1].result.content[0].text.includes('HEVY_API_KEY'), 'missing key reported');
  const invalid = await mcp([initialize,
    toolCall(1, 'hevy2whoop_sync', { from: '2026-10-20' }),
    toolCall(2, 'hevy2whoop_sync', { from: '2026-10-20', to: '2026-10-10' }),
    toolCall(3, 'hevy2whoop_sync', { from: 'yesterday', to: '2026-10-10' }),
    toolCall(4, 'hevy2whoop_sync', { write: 'yes' })]);
  expect([1, 2, 3, 4].every(id => invalid.responses[id]?.result?.isError === true), 'each invalid call returns isError');
  expect(invalid.hevyRequests.length === 0, 'Hevy not contacted');
});

await scenario('M6', 'MCP catalog search', async ({ mcp, expect }) => {
  prepare();
  const r = await mcp([initialize, toolCall(1, 'hevy2whoop_catalog', { search: 'bench' })]);
  expect(JSON.stringify(toolValue(r.responses[1]).exercises) === JSON.stringify([{ exercise_id: 'BENCHPRESS_BARBELL', name: 'Name of BENCHPRESS_BARBELL' }]), 'matching exercise returned');
});

await scenario('M7', 'MCP unknown tool and unknown method', async ({ mcp, expect }) => {
  prepare();
  const r = await mcp([initialize, toolCall(1, 'delete_everything', {}), { id: 2, method: 'resources/list' }, { id: 3, method: 'tools/list' }]);
  expect(r.responses[1]?.error?.code === -32602, 'unknown tool returns JSON-RPC error');
  expect(r.responses[2]?.error?.code === -32601, 'unknown method returns JSON-RPC error');
  expect(r.responses[3]?.result?.tools?.length === 2, 'later request still answered');
});

await scenario('M9', 'User mapping file from HEVY2WHOOP_MAPPING', async ({ run, mcp, expect }) => {
  const userMapping = path.join(work, 'my-mapping.json');
  fs.writeFileSync(userMapping, JSON.stringify({
    CABLEFLY: { hevy: 'Cable Fly', whoop: ['PUSHUP_CLASSIC'], approximate: true, note: 'test' },
    BENCH: { hevy: 'Bench Press (Barbell)', whoop: [], approximate: false, note: 'replaced by user' },
  }));
  const day = workout('w10', 'User Mapping Day', 0, [bench, exercise('CABLEFLY', 'Cable Fly', [set('normal', 20, 12)])]);
  prepare({ workouts: [day] });
  const cli = await run(['sync', '--write'], { extra: { HEVY2WHOOP_MAPPING: userMapping } });
  const payload = writes(cli)[0]?.arguments;
  expect(JSON.stringify(payload?.exercises.map(e => e.exercise_id)) === JSON.stringify(['PUSHUP_CLASSIC']), 'CLI: user entry added, bundled entry replaced');
  expect(cli.stdout.includes('skipped by mapping: Bench Press (Barbell)'), 'CLI: replaced entry skips bench');
  prepare({ workouts: [day] });
  const server = await mcp([initialize, toolCall(1, 'hevy2whoop_sync', {})], { extra: { HEVY2WHOOP_MAPPING: userMapping } });
  expect(toolValue(server.responses[1]).workouts[0]?.unmapped.length === 0, 'MCP: user mapping applied');
  const broken = path.join(work, 'broken-mapping.json');
  fs.writeFileSync(broken, '[');
  const bad = await run(['sync'], { extra: { HEVY2WHOOP_MAPPING: broken } });
  expect(bad.code === 1 && bad.stderr.includes('broken-mapping.json'), 'invalid user file named in the error');
});

await scenario('F19', 'Concurrent writers reserve the same workout once', async ({ run, expect }) => {
  prepare({ workouts: [latest] });
  await Promise.all([run(['sync', '--write']), run(['sync', '--write'])]);
  expect(readTotemState().calls.filter(c => c.name === 'whoop_lift_log' && c.arguments.confirm).length === 1, 'one remote write across processes');
  expect(readTotemState().activities.length === 1, 'one activity');
});
await scenario('F20', 'Lost receipt is reconciled without another write', async ({ run, expect }) => {
  prepare({ workouts: [latest], mode: 'lost_receipt' });
  await run(['sync', '--write']);
  const retry = await run(['sync', '--write']);
  expect(retry.stdout.includes('already in WHOOP'), 'accepted remote activity reconciled');
  expect(readTotemState().calls.filter(c => c.name === 'whoop_lift_log' && c.arguments.confirm).length === 1, 'uncertain write not repeated');
});

server.close();
fs.rmSync(work, { recursive: true, force: true });
const passed = results.filter(result => result.passed).length;
fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
fs.writeFileSync(ARTIFACT, JSON.stringify({ node: process.version, passed, failed: results.length - passed, scenarios: results }, null, 2) + '\n');
console.log(`\n${passed}/${results.length} scenarios passed. Details: ${path.relative(ROOT, ARTIFACT)}`);
process.exitCode = passed === results.length ? 0 : 1;
