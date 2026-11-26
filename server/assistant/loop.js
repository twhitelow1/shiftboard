// One turn of Ask ShiftBoard: Claude reads with the person's tools until it can answer, and stops at the first tool
// that would change something, which comes back as a proposal (an action card) instead of running.
//
// Reads run in the loop, as the person (server/tools/ runTool: role, plan ∩ Roles & features, privacy), at most
// MAX_ROUNDS rounds and within the time the function has left. Writes never run here: only the person's tap on
// Confirm runs one (server/assistant/index.js).
import { runTool, toolInputSchema, isPreviewCall } from '../tools/registry.js';
import { aiMessage } from '../ai/messages.js';

export const MAX_ROUNDS = 6;
const RESULT_CHARS = 16_000; // a tool's answer as the model sees it, at most
const MAX_TOKENS = 2048; // per round (adaptive thinking included)

const resultText = (r) => {
  const s = r.ok ? `${r.summary}\n\n${JSON.stringify(r.data)}` : r.error;
  return s.length > RESULT_CHARS ? `${s.slice(0, RESULT_CHARS)}… (cut short: ask about a shorter time span)` : s;
};

/**
 * @param o.ai        aiFor(…) for the restaurant
 * @param o.user      the person
 * @param o.lang      'en' | 'es'
 * @param o.system    system blocks (prompt.js)
 * @param o.tools     the person's visible registry tools; o.claudeTools: the same for the API
 * @param o.ctx       createToolContext(…) as the person (reads only in the loop)
 * @param o.messages  the conversation so far (history.js contextOf), ending with the person's message
 * @param o.on        { text(delta), status(toolName) } for streaming
 * @param o.deadline  ms timestamp: no new round after it
 * @returns {Promise<{ text, proposals: [{ tool, args }], usage: [], rounds, stop }>}
 */
export async function runTurn({ ai, user, lang, system, tools, claudeTools, ctx, messages: start, on = {}, deadline = Infinity, now = () => Date.now() }) {
  const byName = new Map(tools.map((t) => [t.name, t]));
  const messages = [...start];
  let text = '';
  const usage = [];
  const say = (s) => { text += s; on.text?.(s); };
  for (let round = 1; round <= MAX_ROUNDS; round++) {
    if (round > 1 && now() > deadline) { say(`${text ? '\n\n' : ''}${aiMessage('long', lang)}`); return { text, proposals: [], usage, rounds: round - 1, stop: 'deadline' }; }
    let sep = round > 1 && text && !/\s$/.test(text);
    const res = await ai.stream({ purpose: 'assistant', system, messages, tools: claudeTools, maxTokens: MAX_TOKENS, user, effort: 'low', cacheConversation: true, lang }, {
      text: (d) => { if (sep) { say('\n\n'); sep = false; } say(d); },
    });
    usage.push(res.usage);
    if (res.stopReason === 'refusal') {
      if (!res.text) say(aiMessage('refusal', lang));
      return { text, proposals: [], usage, rounds: round, stop: 'refusal' };
    }
    const uses = res.content.filter((b) => b.type === 'tool_use');
    // A tool call cut off by max_tokens may be incomplete: never act on it.
    if (!uses.length || res.stopReason !== 'tool_use') return { text, proposals: [], usage, rounds: round, stop: res.stopReason };

    // A change: check its input, then stop and hand it to the person. Reads in the same answer aren't needed then.
    // An import's first call (no confirm) only shows what would change: it runs here like a read.
    const writes = uses.filter((u) => byName.get(u.name)?.write && !isPreviewCall(byName.get(u.name), u.input));
    const results = [];
    if (writes.length) {
      const proposals = [];
      for (const u of writes) {
        const parsed = toolInputSchema(byName.get(u.name)).safeParse(u.input ?? {});
        if (parsed.success) proposals.push({ tool: u.name, args: Object.fromEntries(Object.entries(parsed.data).filter(([k]) => k !== 'confirm')) });
        else results.push({ type: 'tool_result', tool_use_id: u.id, is_error: true, content: `Some details weren't right: ${parsed.error.issues.map((i) => `${i.path.join('.') || 'input'}: ${i.message}`).join('; ')}` });
      }
      if (proposals.length) return { text, proposals, usage, rounds: round, stop: 'proposal' };
      for (const u of uses.filter((x) => !writes.includes(x))) results.push({ type: 'tool_result', tool_use_id: u.id, content: 'Not run: fix the change first.' });
    } else {
      await Promise.all(uses.map(async (u) => {
        const tool = byName.get(u.name);
        on.status?.(u.name);
        const r = tool ? await runTool(tool, u.input, ctx) : { ok: false, error: aiMessage('role', 'en') };
        results.push({ type: 'tool_result', tool_use_id: u.id, ...(r.ok ? {} : { is_error: true }), content: resultText(r) });
      }));
      results.sort((a, b) => uses.findIndex((u) => u.id === a.tool_use_id) - uses.findIndex((u) => u.id === b.tool_use_id));
    }
    // The whole answer goes back (thinking blocks included, unchanged), then every result in one message.
    messages.push({ role: 'assistant', content: res.content }, { role: 'user', content: results });
  }
  say(`${text ? '\n\n' : ''}${aiMessage('loop', lang)}`);
  return { text, proposals: [], usage, rounds: MAX_ROUNDS, stop: 'rounds' };
}
