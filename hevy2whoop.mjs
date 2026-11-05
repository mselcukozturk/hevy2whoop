#!/usr/bin/env node
// Copies Hevy strength workouts into WHOOP Strength Trainer.
// Hevy is read through its official API; WHOOP is written through the totem MCP server.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const HEVY_API_URL = process.env.HEVY_API_URL || 'https://api.hevyapp.com';
const MAPPING_FILE = fileURLToPath(new URL('./mapping.json', import.meta.url));
const MATCH_TOLERANCE_MS = 2 * 60 * 1000;
const SEARCH_MARGIN_MS = 60 * 60 * 1000;
const REQUEST_TIMEOUT_MS = 60 * 1000;
const USAGE = `Usage:
  hevy2whoop sync [--from YYYY-MM-DD --to YYYY-MM-DD] [--write]
  hevy2whoop catalog [search]

sync     Without dates, takes the latest Hevy workout. Without --write, only previews.
catalog  Lists WHOOP exercise IDs for editing mapping.json.`;

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
  if (Boolean(options.from) !== Boolean(options.to)) throw new UsageError('--from and --to must be given together.');
  if (options.from && options.from > options.to) throw new UsageError('--from must not be later than --to.');
  return options;
}

function readMapping() {
  try {
    return JSON.parse(fs.readFileSync(MAPPING_FILE, 'utf8'));
  } catch (error) {
    throw new Error(`Cannot read ${MAPPING_FILE}: ${error.message}`);
  }
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
    clientInfo: { name: 'hevy2whoop', version: '1.0.0' },
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

function formatPeriod(workout) {
  const local = value => new Date(value).toLocaleString('sv-SE', { dateStyle: 'short', timeStyle: 'short' });
  return `${local(workout.start_time)}–${local(workout.end_time).slice(11)}`;
}

async function sync(args) {
  const options = parseSyncArguments(args);
  if (!process.env.HEVY_API_KEY) throw new Error('HEVY_API_KEY is not set. Generate a key at https://hevy.com/settings?developer');
  const mapping = readMapping();
  const workouts = await readHevyWorkouts(options.from, options.to);
  if (workouts.length === 0) {
    console.log('No Hevy workout found.');
    return 0;
  }

  const whoop = await openWhoop();
  let failed = false;
  try {
    for (const workout of workouts) {
      console.log(`\n${formatPeriod(workout)}  ${workout.title}`);
      const { payload, unmapped, skipped } = buildLiftPayload(workout, mapping);
      for (const item of unmapped) console.log(`  unmapped: ${item.title} (template ${item.template_id})`);
      for (const title of skipped) console.log(`  skipped by mapping: ${title}`);
      if (!payload) {
        console.log('  nothing to write');
        continue;
      }
      const setCount = payload.exercises.reduce((sum, exercise) => sum + exercise.sets.length, 0);
      const summary = `${payload.exercises.length} exercises, ${setCount} sets`;
      try {
        const existing = await findExistingActivity(whoop, workout);
        if (existing) {
          console.log(`  already in WHOOP: activity ${existing.id}`);
        } else if (!options.write) {
          await whoop.call('whoop_lift_log', { ...payload, confirm: false });
          console.log(`  preview: would write ${summary} (run with --write to write)`);
        } else {
          const receipt = await whoop.call('whoop_lift_log', { ...payload, confirm: true });
          console.log(`  written: activity ${receipt.activity_id} (${summary})`);
        }
      } catch (error) {
        failed = true;
        console.log(`  error: ${error.message}`);
      }
    }
  } finally {
    whoop.close();
  }
  return failed ? 1 : 0;
}

async function catalog(args) {
  const whoop = await openWhoop();
  try {
    const result = await whoop.call('whoop_lift_catalog', { ...(args[0] ? { search: args[0] } : {}), limit: 372 });
    const exercises = Array.isArray(result) ? result : (result.exercises ?? []);
    for (const exercise of exercises) console.log(`${exercise.exercise_id}\t${exercise.name}`);
    return 0;
  } finally {
    whoop.close();
  }
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  try {
    if (command === 'sync') return await sync(args);
    if (command === 'catalog') return await catalog(args);
    throw new UsageError(command ? `Unknown command: ${command}` : 'No command given.');
  } catch (error) {
    console.error(error instanceof UsageError ? `${error.message}\n\n${USAGE}` : error.message);
    return 1;
  }
}

process.exitCode = await main();
