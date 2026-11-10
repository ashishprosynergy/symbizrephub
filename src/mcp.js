'use strict';
/**
 * Rep Hub for Claude (Jeremy, 28 Oct: "what do I need to do to give my
 * Claude access to the Rep Hub?").
 *
 * A Model Context Protocol server: Claude (claude.ai → Settings → Connectors
 * → Add custom connector) is given a private link, /api/mcp/<key>, made by
 * each person in Rep Hub (Access & security → Connect Claude). Every question
 * Claude asks is answered by Rep Hub's own API, signed in as that person, so
 * Claude sees exactly what they see in the app and nothing else. Read only:
 * Claude can look things up and summarise, never change anything.
 *
 * Streamable HTTP, stateless: each POST carries one JSON-RPC message (or a
 * batch) and gets a JSON answer. No sessions, so it suits Netlify Functions.
 */
const crypto = require('crypto');

const PROTOCOL = '2025-06-18';
const MAX_TEXT = 90000;

/* A list tool takes an optional search (matched against every text field)
   and a limit, so Claude can ask for just what it needs. */
const listArgs = (extra = {}) => ({
  type: 'object',
  properties: {
    search: { type: 'string', description: 'Only rows containing this text (a name, town, ring, business…). Case does not matter.' },
    limit: { type: 'integer', description: 'Most rows to return (default 100, at most 500).' },
    ...extra,
  },
});
const TOOLS = [
  { name: 'overview', path: '/stats', description: 'Headline numbers: active members, rings, members not in a ring, calls overdue and due, renewals. Start here for "how are we doing".' },
  { name: 'list_rings', path: '/rings', list: true, description: 'Growth Rings with their rep, facilitator, member count, status, meeting rhythm and last/next rep visit.' },
  { name: 'list_members', path: '/members', list: true, description: 'Members with their ring, rep, membership level (Seedling, Sapling, Mighty Oak, Bookshelf), phone, email, address and dates. Use search for a name or town.' },
  { name: 'members_not_in_a_ring', path: '/members/no-ring', list: true, description: 'Active members who are not in any Growth Ring.' },
  { name: 'onboarding', path: '/onboarding', description: 'Where each member without a ring is in onboarding (Not started, First call completed, Prospecting, Visiting a group, Group deciding…), keyed by member id. Pair with members_not_in_a_ring for names.' },
  { name: 'calls_and_visits_logged', path: '/activities', list: true, description: 'Calls, meetings and visits reps have logged, with the outcome, notes and next due date.' },
  { name: 'rep_visits', path: '/visits', list: true, description: 'Ring visits booked and done.' },
  { name: 'ring_meetings', path: '/meetings', list: true, description: 'Growth Ring meetings (held, planned, cancelled) with attendance where taken.' },
  { name: 'events', path: '/events', list: true, description: 'Events and summits shown in Rep Hub, with dates, places and registration counts.' },
  { name: 'event_registrations', path: a => `/events/${encodeURIComponent(String(a.event_id || '').replace(/[^0-9]/g, ''))}/registrations`, list: true,
    args: { event_id: { type: 'string', description: 'The event id, from the events tool.' } }, required: ['event_id'],
    description: 'Everyone registered for one event, with their guests, status and contact details.' },
  { name: 'reps_overview', path: '/manager/snapshot', description: 'How each rep is doing: calls logged, rings never visited, quiet rings, overdue members and the warnings the office sees. Office only.' },
  { name: 'ar_over_60_days', path: '/members/ar', list: true, description: 'Members with unpaid invoices more than 60 days old, matched to their rep, and whether they have been contacted.' },
  { name: 'hours', path: '/time', list: true, description: 'Hours reps have logged, with status (submitted, approved, sent).' },
  { name: 'expenses', path: '/expenses', list: true, description: 'Expenses, mileage and driver claims, with status. Receipts are not included.' },
  { name: 'reports', path: '/reports', description: 'The list of reports Rep Hub can run, by key.' },
  { name: 'run_report', path: a => `/reports/${encodeURIComponent(String(a.key || '').replace(/[^a-z0-9-]/gi, ''))}`, list: true,
    args: { key: { type: 'string', description: 'The report key, from the reports tool.' } }, required: ['key'], description: 'Run one report and get its rows.' },
  { name: 'member_development_handoffs', path: '/handoffs', list: true, description: 'Members reps have handed to Member Development, with the reason, status and call notes.' },
  { name: 'oak_tree_coaches', path: '/coaches', list: true, description: 'Mighty Oak (Oak Tree) members, who is willing to coach and their areas of strength.' },
  { name: 'rep_candidates', path: '/candidates', description: 'People who might become reps, with their stage and notes. Only for the people the office has chosen.' },
  { name: 'summits', path: '/summits', list: true, description: 'Summits with their planning checklists and progress.' },
  { name: 'symbiz_calendar', path: '/calendar/symbiz', description: 'L10, facilitator and forum calls from the Symbiz calendar for the next 45 days, with join links.' },
];

const textOf = v => typeof v === 'string' ? v : JSON.stringify(v);
function trimRows(data, args) {
  let rows = Array.isArray(data) ? data : (data && Array.isArray(data.rows) ? data.rows : null);
  if (!rows) return data;
  const want = String(args.search || '').trim().toLowerCase();
  if (want) rows = rows.filter(r => textOf(r).toLowerCase().includes(want));
  const limit = Math.min(500, Math.max(1, parseInt(args.limit, 10) || 100));
  const out = { total: rows.length, returned: Math.min(limit, rows.length), rows: rows.slice(0, limit) };
  if (!Array.isArray(data)) return { ...data, ...out };
  return out;
}
function asText(data) {
  let text = JSON.stringify(data, null, 1);
  if (text.length > MAX_TEXT) text = text.slice(0, MAX_TEXT) + '\n… (cut short: ask with a search or a smaller limit)';
  return text;
}

/**
 * Answer one JSON-RPC message. `callApi(path)` asks Rep Hub's API as the
 * person who owns the link and resolves to { status, data }.
 */
async function handleMessage(msg, { callApi, who }) {
  const reply = result => ({ jsonrpc: '2.0', id: msg.id, result });
  const fail = (code, message) => ({ jsonrpc: '2.0', id: msg.id ?? null, error: { code, message } });
  if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string') return fail(-32600, 'Invalid request');
  const isNotice = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case 'initialize':
      return reply({
        protocolVersion: (msg.params && msg.params.protocolVersion) || PROTOCOL,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: 'symbiz-rep-hub', title: 'Symbiz Rep Hub', version: '1.0.0' },
        instructions: `Symbiz Network's Rep Hub: Growth Rings, members, reps, calls, events and summits, read from Zoho CRM and Rep Hub. ` +
          `You are signed in as ${who}, and see what they see in the app. Read only. Member numbers follow the name (e.g. "Amos Zook #0901"). ` +
          `Use search and limit on list tools rather than fetching everything.`,
      });
    case 'ping': return reply({});
    case 'tools/list':
      return reply({ tools: TOOLS.map(t => {
        const inputSchema = t.list ? listArgs(t.args) : { type: 'object', properties: { ...(t.args || {}) } };
        if (t.required) inputSchema.required = t.required;
        return { name: t.name, title: t.name.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase()), description: t.description,
          inputSchema, annotations: { readOnlyHint: true, openWorldHint: false } };
      }) });
    case 'tools/call': {
      const p = msg.params || {}, args = p.arguments || {};
      const tool = TOOLS.find(t => t.name === p.name);
      if (!tool) return fail(-32602, `Unknown tool: ${p.name}`);
      for (const k of tool.required || []) if (!args[k]) return reply({ isError: true, content: [{ type: 'text', text: `Missing ${k}` }] });
      const path = typeof tool.path === 'function' ? tool.path(args) : tool.path;
      try {
        const { status, data } = await callApi(path);
        if (status >= 400) return reply({ isError: true, content: [{ type: 'text', text: (data && data.error) || `Rep Hub answered ${status}` }] });
        return reply({ content: [{ type: 'text', text: asText(tool.list ? trimRows(data, args) : data) }] });
      } catch (e) {
        return reply({ isError: true, content: [{ type: 'text', text: 'Rep Hub could not answer: ' + e.message }] });
      }
    }
    default:
      if (isNotice || msg.method.startsWith('notifications/')) return null;     // nothing to answer
      return fail(-32601, `Method not found: ${msg.method}`);
  }
}

const newKey = () => crypto.randomBytes(24).toString('hex');
const hashKey = k => crypto.createHash('sha256').update(String(k)).digest('hex');

module.exports = { TOOLS, handleMessage, newKey, hashKey, trimRows, PROTOCOL };
