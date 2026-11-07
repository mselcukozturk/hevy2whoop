#!/usr/bin/env node
// Copies Hevy strength workouts into WHOOP Strength Trainer.
// Hevy is read through its official API; WHOOP is written through the totem MCP server.
// Runs as a command-line tool or, with `hevy2whoop mcp`, as an MCP server over stdio.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { homedir } from 'node:os';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';

const VERSION = '1.1.0';
const HEVY_API_URL = process.env.HEVY_API_URL || 'https://api.hevyapp.com';
const MAPPING_FILE = fileURLToPath(new URL('./mapping.json', import.meta.url));
const MATCH_TOLERANCE_MS = 2 * 60 * 1000;
const SEARCH_MARGIN_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const USAGE = `Usage:
  hevy2whoop sync [--from YYYY-MM-DD --to YYYY-MM-DD] [--write]
  hevy2whoop catalog [search]
  hevy2whoop mcp

sync     Without dates, takes the latest Hevy workout. Without --write, only previews.
catalog  Lists WHOOP exercise IDs for editing mapping.json.
mcp      Runs an MCP server over stdio with the same two functions.`;

class UsageError extends Error {}

function parseDate(value, endOfDay) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value || '')) throw new UsageError(`Invalid date: ${value}`);
  const date = new Date(`${value}T${endOfDay ? '23:59:59.999' : '00:00:00'}`);
  if (Number.isNaN(date.getTime())) throw new UsageError(`Invalid date: ${value}`);
  return date;
}

function parseSyncArguments(args) {
  const options = { write: false };
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--write') options.write = true;
    else if (args[i] === '--from') options.from = parseDate(args[++i], false);
    else if (args[i] === '--to') options.to = parseDate(args[++i], true);
    else throw new UsageError(`Unknown argument: ${args[i]}`);
  }
  return checkRange(options);
}

function checkRange(options) {
  if (Boolean(options.from) !== Boolean(options.to)) throw new UsageError('--from and --to must be given together.');
  if (options.from && options.from > options.to) throw new UsageError('--from must not be later than --to.');
  return options;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${file}: ${error.message}`);
  }
}

// Entries in the user's file (HEVY2WHOOP_MAPPING) add to and replace bundled entries.
function readMapping() {
  const mapping = readJson(MAPPING_FILE);
  return process.env.HEVY2WHOOP_MAPPING ? { ...mapping, ...readJson(process.env.HEVY2WHOOP_MAPPING) } : mapping;
}

async function readHevyPage(page) {
  const response = await fetch(`${HEVY_API_URL}/v1/workouts?page=${page}&pageSize=10`, {
    headers: { 'api-key': process.env.HEVY_API_KEY },
    signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Hevy API error: ${response.status} ${response.statusText}`);
  return response.json();
}

// Hevy returns workouts newest first. Result is oldest first.
async function readHevyWorkouts(from, to) {
  const first = await readHevyPage(1);
  if (!from) return (first.workouts || []).slice(0, 1);
  const selected = [];
  let data = first;
  for (let page = 1; ; page++) {
    if (page > 1) data = await readHevyPage(page);
    const workouts = data.workouts || [];
    for (const workout of workouts) {
      const start = new Date(workout.start_time);
      if (start >= from && start <= to) selected.push(workout);
    }
    const oldest = workouts.at(-1);
    if (!oldest || new Date(oldest.start_time) < from || page >= (data.page_count || 1)) break;
  }
  return selected.reverse();
}

function openWhoop() {
  const server = spawn('totem', ['start'], { stdio: ['pipe', 'pipe', 'pipe'] });
  const waiters = new Map();
  let buffer = '', stderr = '', nextId = 0, failure = null;
  const failAll = error => {
    failure ??= error;
    for (const waiter of waiters.values()) waiter.reject(failure);
    waiters.clear();
  };
  server.on('error', error => failAll(error.code === 'ENOENT'
    ? new Error('totem is not installed. Run: npm install -g @thebriangao/totem && totem auth')
    : error));
  server.on('exit', code => failAll(new Error(`totem exited with code ${code}. ${stderr.trim().split('\n').at(-1) || ''}`.trim())));
  server.stdin.on('error', () => {});
  server.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-2000); });
  server.stdout.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index);
      buffer = buffer.slice(index + 1);
      let message;
      try { message = JSON.parse(line); } catch { continue; }
      waiters.get(message.id)?.resolve(message);
      waiters.delete(message.id);
    }
  });
  const request = (method, params) => new Promise((resolve, reject) => {
    if (failure) return reject(failure);
    const id = ++nextId;
    const timer = setTimeout(() => {
      waiters.delete(id);
      reject(new Error(`totem did not answer ${method} within ${REQUEST_TIMEOUT_MS / 1000} seconds`));
    }, REQUEST_TIMEOUT_MS);
    waiters.set(id, {
      resolve: message => { clearTimeout(timer); resolve(message); },
      reject: error => { clearTimeout(timer); reject(error); },
    });
    server.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
  });
  const call = async (name, args) => {
    const message = await request('tools/call', { name, arguments: args });
    const text = message.result?.content?.[0]?.text ?? message.error?.message ?? '';
    if (message.error || message.result?.isError) {
      const hint = /401|403|auth|token|cognito/i.test(text) ? ' Run `totem auth` to sign in to WHOOP again.' : '';
      throw new Error(`${name}: ${text.slice(0, 300)}${hint}`);
    }
    return JSON.parse(text);
  };
  const ready = request('initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'hevy2whoop', version: VERSION },
  }).then(() => server.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n'));
  return ready.then(() => ({
    call,
    close: () => { server.removeAllListeners('exit'); server.kill(); },
  }));
}

function buildLiftPayload(workout, mapping) {
  const movements = [], unmapped = [], skipped = [];
  for (const exercise of workout.exercises || []) {
    const sets = (exercise.sets || []).filter(set => set.type !== 'warmup');
    if (sets.length === 0) continue;
    const entry = mapping[exercise.exercise_template_id];
    if (!entry) {
      unmapped.push({ title: exercise.title, template_id: exercise.exercise_template_id });
      continue;
    }
    if (entry.whoop.length === 0) {
      skipped.push(exercise.title);
      continue;
    }
    for (const exerciseId of entry.whoop) movements.push({ exercise_id: exerciseId, sets });
  }
  const setCount = movements.reduce((sum, movement) => sum + movement.sets.length, 0);
  if (setCount === 0) return { payload: null, unmapped, skipped };

  const durationSeconds = Math.max(1, Math.round((new Date(workout.end_time) - new Date(workout.start_time)) / 1000));
  const secondsPerSet = Math.round(durationSeconds / setCount);
  const exercises = movements.map(movement => ({
    exercise_id: movement.exercise_id,
    sets: movement.sets.map(set => {
      const result = { reps: set.reps ?? 0 };
      if (set.weight_kg !== null && set.weight_kg !== undefined) result.weight = set.weight_kg;
      result.time_seconds = secondsPerSet;
      return result;
    }),
  }));
  return {
    payload: { name: workout.title, start: workout.start_time, end: workout.end_time, exercises },
    unmapped,
    skipped,
  };
}

async function findExistingActivity(whoop, workout) {
  const start = new Date(workout.start_time).getTime();
  const end = new Date(workout.end_time).getTime();
  const result = await whoop.call('whoop_workouts', {
    start: new Date(start - SEARCH_MARGIN_MS).toISOString(),
    end: new Date(end + SEARCH_MARGIN_MS).toISOString(),
    limit: 25,
  });
  const activities = Array.isArray(result) ? result : (result.workouts ?? []);
  return activities.find(activity => activity.sport_name === 'weightlifting_msk'
    && Math.abs(new Date(activity.start).getTime() - start) <= MATCH_TOLERANCE_MS
    && Math.abs(new Date(activity.end).getTime() - end) <= MATCH_TOLERANCE_MS);
}

// Returns one result per workout, oldest first. Errors of single workouts are recorded, not thrown.
async function syncWorkouts({ from, to, write }) {
  if (!process.env.HEVY_API_KEY) throw new Error('HEVY_API_KEY is not set. Generate a key at https://hevy.com/settings?developer');
  const mapping = readMapping();
  const workouts = await readHevyWorkouts(from, to);
  if (workouts.length === 0) return [];

  const whoop = await openWhoop();
  const results = [];
  try {
    for (const workout of workouts) {
      const { payload, unmapped, skipped } = buildLiftPayload(workout, mapping);
      const result = { title: workout.title, start: workout.start_time, end: workout.end_time, unmapped, skipped };
      results.push(result);
      if (!payload) {
        result.status = 'nothing_to_write';
        continue;
      }
      result.exercise_count = payload.exercises.length;
      result.set_count = payload.exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0);
      try {
        const existing = await findExistingActivity(whoop, workout);
        if (existing) {
          Object.assign(result, { status: 'already_in_whoop', activity_id: existing.id });
        } else if (!write) {
          await whoop.call('whoop_lift_log', { ...payload, confirm: false });
          result.status = 'preview';
        } else {
          const directory = path.join(homedir(), '.local', 'state', 'hevy2whoop');
          fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
          const identity = createHash('sha256').update(JSON.stringify([HEVY_API_URL, workout.id])).digest('hex');
          const record = path.join(directory, identity + '.json');
          try {
            fs.writeFileSync(record, JSON.stringify({ status: 'reserved', workout_id: workout.id }), { flag: 'wx', mode: 0o600 });
          } catch (error) {
            if (error.code === 'EEXIST') throw new Error('A previous write is pending or unconfirmed; reconcile WHOOP before writing again.');
            throw error;
          }
          const receipt = await whoop.call('whoop_lift_log', { ...payload, confirm: true });
          if (!receipt.activity_id) throw new Error('WHOOP did not return an activity ID; write remains unconfirmed.');
          const temporary = record + '.' + process.pid + '.tmp';
          fs.writeFileSync(temporary, JSON.stringify({ status: 'written', workout_id: workout.id, activity_id: receipt.activity_id }), { mode: 0o600 });
          fs.renameSync(temporary, record);
          Object.assign(result, { status: 'written', activity_id: receipt.activity_id });
        }
      } catch (error) {
        Object.assign(result, { status: 'error', error: error.message });
      }
    }
  } finally {
    whoop.close();
  }
  return results;
}

async function readCatalog(search) {
  const whoop = await openWhoop();
  try {
    const result = await whoop.call('whoop_lift_catalog', { ...(search ? { search } : {}), limit: 372 });
    const exercises = Array.isArray(result) ? result : (result.exercises ?? []);
    return exercises.map(exercise => ({ exercise_id: exercise.exercise_id, name: exercise.name }));
  } finally {
    whoop.close();
  }
}

function formatPeriod(result) {
  const local = value => new Date(value).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
  return `${local(result.start)}–${local(result.end).slice(11)}`;
}

async function sync(args) {
  const results = await syncWorkouts(parseSyncArguments(args));
  if (results.length === 0) console.log('No Hevy workout found.');
  for (const result of results) {
    console.log(`\n${formatPeriod(result)}  ${result.title}`);
    for (const item of result.unmapped) console.log(`  unmapped: ${item.title} (template ${item.template_id})`);
    for (const title of result.skipped) console.log(`  skipped by mapping: ${title}`);
    const summary = `${result.exercise_count} exercises, ${result.set_count} sets`;
    if (result.status === 'nothing_to_write') console.log('  nothing to write');
    else if (result.status === 'already_in_whoop') console.log(`  already in WHOOP: activity ${result.activity_id}`);
    else if (result.status === 'preview') console.log(`  preview: would write ${summary} (run with --write to write)`);
    else if (result.status === 'written') console.log(`  written: activity ${result.activity_id} (${summary})`);
    else console.log(`  error: ${result.error}`);
  }
  return results.some(result => result.status === 'error') ? 1 : 0;
}

async function catalog(args) {
  for (const exercise of await readCatalog(args[0])) console.log(`${exercise.exercise_id}\t${exercise.name}`);
  return 0;
}

const DATE_PROPERTY = { type: 'string', pattern: '^\\d{4}-\\d{2}-\\d{2}$' };
const MCP_TOOLS = [
  {
    name: 'hevy2whoop_sync',
    description: 'Copy Hevy strength workouts into WHOOP Strength Trainer. Without from/to, takes the latest Hevy workout. '
      + 'Without write: true, only previews. With write: true, WRITES the workouts to WHOOP; workouts already in WHOOP are not written again. '
      + 'Reports exercises that have no entry in the exercise mapping.',
    inputSchema: {
      type: 'object',
      properties: {
        from: { ...DATE_PROPERTY, description: 'First local date (YYYY-MM-DD) of the range. Requires to.' },
        to: { ...DATE_PROPERTY, description: 'Last local date (YYYY-MM-DD) of the range, included. Requires from.' },
        write: { type: 'boolean', default: false, description: 'true writes to WHOOP; false or missing only previews.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'hevy2whoop_catalog',
    description: 'List WHOOP Strength Trainer exercise IDs and names, optionally filtered by a search text. Use it to find IDs for the exercise mapping.',
    inputSchema: {
      type: 'object',
      properties: { search: { type: 'string', description: 'Part of the exercise name or ID.' } },
      additionalProperties: false,
    },
  },
];

async function callMcpTool(name, args = {}) {
  if (name === 'hevy2whoop_sync') {
    if (args.write !== undefined && typeof args.write !== 'boolean') throw new UsageError('write must be true or false.');
    const range = checkRange({
      from: args.from === undefined ? undefined : parseDate(args.from, false),
      to: args.to === undefined ? undefined : parseDate(args.to, true),
    });
    const results = await syncWorkouts({ ...range, write: args.write === true });
    return { value: { workouts: results }, isError: results.some(result => result.status === 'error') };
  }
  return { value: { exercises: await readCatalog(args.search) }, isError: false };
}

async function handleMcpMessage(message) {
  const respond = body => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, ...body }) + '\n');
  if (message.id === undefined) return;
  if (message.method === 'initialize') {
    return respond({ result: {
      protocolVersion: '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'hevy2whoop', version: VERSION },
    } });
  }
  if (message.method === 'ping') return respond({ result: {} });
  if (message.method === 'tools/list') return respond({ result: { tools: MCP_TOOLS } });
  if (message.method !== 'tools/call') return respond({ error: { code: -32601, message: `Method not found: ${message.method}` } });
  const { name, arguments: args } = message.params || {};
  if (!MCP_TOOLS.some(tool => tool.name === name)) return respond({ error: { code: -32602, message: `Unknown tool: ${name}` } });
  try {
    const { value, isError } = await callMcpTool(name, args);
    respond({ result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError } });
  } catch (error) {
    respond({ result: { content: [{ type: 'text', text: error.message }], isError: true } });
  }
}

// Requests are handled one at a time so that two sync calls cannot write the same workout.
function serveMcp() {
  let buffer = '', queue = Promise.resolve();
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); } catch {
        process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } }) + '\n');
        continue;
      }
      queue = queue.then(() => handleMcpMessage(message));
    }
  });
  return new Promise(resolve => process.stdin.on('end', () => queue.then(() => resolve(0))));
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'sync') return await sync(args);
    if (command === 'catalog') return await catalog(args);
    if (command === 'mcp') return await serveMcp();
    throw new UsageError(command ? `Unknown command: ${command}` : 'No command given.');
  } catch (error) {
    console.error(error instanceof UsageError ? `${error.message}\n\n${USAGE}` : error.message);
    return 1;
  }
}

process.exitCode = await main();
