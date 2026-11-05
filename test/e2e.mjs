// End-to-end run of hevy2whoop against a fake Hevy API and a fake totem MCP server.
// Covers docs/failure-scenarios.md and writes artifacts/e2e-result.json.
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

function prepare({ workouts = [], hevyStatus = 200, activities = [], mode = 'ok', failNames = [], mapping = JSON.stringify(MAPPING) } = {}) {
  hevy.workouts = workouts;
  hevy.status = hevyStatus;
  hevy.requests = [];
  fs.writeFileSync(path.join(toolDir, 'mapping.json'), mapping);
  fs.writeFileSync(stateFile, JSON.stringify({ activities, validIds: VALID_IDS, mode, failNames, calls: [], started: 0 }));
}

function run(args, { apiKey = API_KEY, totem = true } = {}) {
  const env = {
    PATH: totem ? `${binWithTotem}:${process.env.PATH}` : binWithoutTotem,
    HEVY_API_URL: `http://127.0.0.1:${server.address().port}`,
    FAKE_TOTEM_STATE: stateFile,
    TZ: 'Europe/Istanbul',
    ...(apiKey ? { HEVY_API_KEY: apiKey } : {}),
  };
  return new Promise(resolve => {
    const child = spawn(process.execPath, [path.join(toolDir, 'hevy2whoop.mjs'), ...args], { env });
    let stdout = '', stderr = '';
    child.stdout.on('data', chunk => { stdout += chunk; });
    child.stderr.on('data', chunk => { stderr += chunk; });
    child.on('close', code => {
      const totemState = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
      resolve({ args, code, stdout, stderr, hevyRequests: [...hevy.requests], totemStarted: totemState.started, whoopCalls: totemState.calls, activities: totemState.activities });
    });
  });
}

const logCalls = result => result.whoopCalls.filter(call => call.name === 'whoop_lift_log');
const writes = result => logCalls(result).filter(call => call.arguments.confirm === true);
const results = [];
async function scenario(id, description, steps) {
  const runs = [];
  const checks = [];
  const expect = (condition, label) => checks.push({ label, passed: Boolean(condition) });
  try {
    await steps({ run: async (...args) => { const result = await run(...args); runs.push(result); return result; }, expect });
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

server.close();
fs.rmSync(work, { recursive: true, force: true });
const passed = results.filter(result => result.passed).length;
fs.mkdirSync(path.dirname(ARTIFACT), { recursive: true });
fs.writeFileSync(ARTIFACT, JSON.stringify({ node: process.version, passed, failed: results.length - passed, scenarios: results }, null, 2) + '\n');
console.log(`\n${passed}/${results.length} scenarios passed. Details: ${path.relative(ROOT, ARTIFACT)}`);
process.exitCode = passed === results.length ? 0 : 1;
