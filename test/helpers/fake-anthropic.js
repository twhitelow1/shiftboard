// A stand-in for the Anthropic SDK client (no network): messages.create and messages.stream answer from a script,
// and every request is kept for the test to look at.
//
//   const fake = fakeAnthropic();
//   fake.reply(text('Hi!'));                                    // the next answer
//   fake.reply(toolUse('get_my_shifts', {}), text('You work Friday.'));
//   createApp({ …, aiClient: fake.factory })                    // or aiFor({ client: fake.client })
//   fake.calls[0].params.tools, fake.keys                        // what was sent, and with which key

let n = 0;
const usageOf = (u = {}) => ({ input_tokens: 1200, output_tokens: 80, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, ...u });

/** An answer with text. */
export const text = (s, usage) => ({ content: [{ type: 'text', text: s }], stop_reason: 'end_turn', usage: usageOf(usage) });
/** An answer that calls tools: toolUse('name', input) or toolUse([['a', {}], ['b', {}]]), with optional text before. */
export function toolUse(nameOrList, input = {}, { say = '', usage } = {}) {
  const list = Array.isArray(nameOrList) ? nameOrList : [[nameOrList, input]];
  return {
    content: [
      { type: 'thinking', thinking: '', signature: 'sig' }, // as Haiku 5.5 sends it (thinking omitted): must be passed back as is
      ...(say ? [{ type: 'text', text: say }] : []),
      ...list.map(([name, inp]) => ({ type: 'tool_use', id: `toolu_${++n}`, name, input: inp })),
    ],
    stop_reason: 'tool_use', usage: usageOf(usage),
  };
}
/** A refusal. */
export const refusal = () => ({ content: [], stop_reason: 'refusal', usage: usageOf({ output_tokens: 0 }) });

export function fakeAnthropic() {
  const queue = [];
  const calls = [];
  const keys = [];
  const take = (params, mode) => {
    calls.push({ mode, params: JSON.parse(JSON.stringify(params)) });
    const next = queue.shift();
    if (!next) throw new Error('fake Anthropic: no answer scripted for this call');
    if (next instanceof Error) throw next;
    const m = typeof next === 'function' ? next(params) : next;
    return { id: `msg_${++n}`, type: 'message', role: 'assistant', model: params.model, ...m };
  };
  const client = {
    messages: {
      async create(params) { return take(params, 'create'); },
      stream(params) {
        let msg;
        let err = null;
        try { msg = take(params, 'stream'); } catch (e) { err = e; }
        return {
          async *[Symbol.asyncIterator]() {
            if (err) throw err;
            for (const [i, b] of msg.content.entries()) {
              if (b.type !== 'text') continue;
              for (const piece of b.text.match(/.{1,12}/gs) || []) yield { type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: piece } };
            }
          },
          async finalMessage() { if (err) throw err; return msg; },
        };
      },
    },
  };
  return {
    client, calls, keys,
    factory: ({ apiKey }) => { keys.push(apiKey ? `…${String(apiKey).slice(-4)}` : null); return client; },
    reply: (...answers) => { queue.push(...answers); },
    pending: () => queue.length,
    clear: () => { queue.length = 0; calls.length = 0; keys.length = 0; },
  };
}
