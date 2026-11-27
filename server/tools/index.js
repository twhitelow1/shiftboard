// Every tool, by feature. To add tools for a new feature, write server/tools/<feature>.js exporting an array of
// defineTool({...}) (see registry.js) and add it to FEATURE_TOOLS below. That's all: the Claude connector lists them
// (filtered by role, plan and scope) and an in-app assistant can use them too.
//
// Coming from other branches, in a few lines each when they merge:
//   reports.js        get_report (Reports: role: 'manager', feature: the reports feature, write: false)
//   announcements.js  get_announcements; send_announcement (write: true, confirm: true: "ask the user first")
//   trades.js         the new Trades & pickups RPCs (today's swaps.* tools are in requests.js)
import me from './me.js';
import schedule from './schedule.js';
import requests from './requests.js';
import eightySix from './eighty-six.js';
import training from './training.js';
import events from './events.js';
import team from './team.js';
import importTools from './import.js';
import stock from './stock.js';
import programming from './programming.js'; // regular programming and staffing pars (core/programming.js)

// The Feedback box (core/feedback.js) has no tools, on purpose: people write to it anonymously, and its entries and
// replies stay inside ShiftBoard's own screens. Neither the Claude connector nor Ask ShiftBoard reads, sends or
// summarizes them (no AI processing of entries in this version). Don't add feedback tools without a privacy review.
const FEATURE_TOOLS = [me, schedule, requests, eightySix, stock, training, events, programming, team, importTools];

export const TOOLS = Object.freeze(FEATURE_TOOLS.flat());

const names = new Set();
for (const t of TOOLS) {
  if (names.has(t.name)) throw new Error(`Two tools are called ${t.name}`);
  names.add(t.name);
}

export const toolByName = (name) => TOOLS.find((t) => t.name === name) || null;
export { visibleTools, toolAllowed, runTool, createToolContext, toolJsonSchema, toClaudeTool, setRoleFeatureCheck, isPreviewCall, READ, WRITE } from './registry.js';
