// Fake `totem start`: an MCP stdio server with the four WHOOP tools hevy2whoop uses.
// State (existing activities, valid exercise IDs, failure mode) and the call log live in FAKE_TOTEM_STATE.
import fs from 'node:fs';

const stateFile = process.env.FAKE_TOTEM_STATE;
const load = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const save = state => fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));

const state = load();
state.started = (state.started || 0) + 1;
state.pids = [...(state.pids || []), process.pid];
save(state);

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const text = (value, isError = false) => ({ content: [{ type: 'text', text: JSON.stringify(value) }], ...(isError ? { isError: true } : {}) });

function callTool(name, args) {
  const current = load();
  current.calls.push({ name, arguments: args });
  let result;
  if (current.mode === 'expired') {
    result = text({ error: 'WHOOP API 401 Unauthorized' }, true);
  } else if (name === 'whoop_workouts') {
    const start = new Date(args.start), end = new Date(args.end);
    result = text({ workouts: current.activities.filter(a => new Date(a.start) >= start && new Date(a.start) <= end) });
  } else if (name === 'whoop_lift_catalog') {
    result = text({ exercises: current.validIds
      .filter(id => !args.search || id.toLowerCase().includes(args.search.toLowerCase()))
      .map(id => ({ exercise_id: id, name: `Name of ${id}` })) });
  } else if (name === 'whoop_lift_log') {
    const unknown = args.exercises.map(e => e.exercise_id).filter(id => !current.validIds.includes(id));
    if (unknown.length) result = text({ error: 'Unknown exercise IDs', unknown_exercises: unknown }, true);
    else if (current.failNames.includes(args.name)) result = text({ error: 'WHOOP API 500 Internal Server Error' }, true);
    else if (!args.confirm) result = text({ preview: true });
    else {
      const id = `activity-${current.activities.length + 1}`;
      current.activities.push({ id, sport_name: 'weightlifting_msk', start: args.start, end: args.end });
      result = current.mode === 'lost_receipt' ? text({error: 'Response lost after acceptance'}, true) : text({ logged: true, activity_id: id });
    }
  } else {
    result = text({ error: `Unknown tool ${name}` }, true);
  }
  save(current);
  return result;
}

let buffer = '';
process.stdin.on('data', chunk => {
  buffer += chunk;
  let index;
  while ((index = buffer.indexOf('\n')) >= 0) {
    const message = JSON.parse(buffer.slice(0, index));
    buffer = buffer.slice(index + 1);
    if (message.method === 'initialize') reply(message.id, { protocolVersion: '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-totem', version: '0' } });
    else if (message.method === 'tools/call') reply(message.id, callTool(message.params.name, message.params.arguments));
  }
});
