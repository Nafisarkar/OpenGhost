'use strict';

// Command Code's Provider API: one key for the models of many companies. Which of its two shapes a request takes is the
// models list's to say — a Claude model answers only on the Messages endpoint and is handed to the Anthropic engine with
// this API's own address, every other model takes the Chat Completions shape this app's history already has.
const Claude = require('./anthropic');
const API_URL = 'https://api.commandcode.ai/provider/v1';
const NO_VISION = '[A picture was here, but the selected model can\'t see pictures]';
// The effort levels a model is given, least thinking to most. The API names no levels of its own, so every model gets
// the three that every endpoint behind it takes and nothing more.
const EFFORTS = ['none', 'low', 'high'];
const THINKING_ROOM = 2048;
const FINISH = new Set(['stop', 'tool_calls', 'length', 'content_filter']);

const error = (message, status = 0, code = '') => Object.assign(new Error(message), { status, code });
const headers = key => ({ Authorization: `Bearer ${key}` });

async function failure(response) {
 let detail = '', code = '';
 try {
  const body = await response.json();
  detail = body.error?.message || body.message || '';
  code = String(body.error?.code || body.error?.type || '');
 } catch {}
 return error(detail || `Command Code returned error ${response.status}`, response.status, code);
}

// No model is named in this file. The list says of each its name, its window and the endpoints that serve it; what it
// doesn't say (pictures, tools) is the company behind the model's to refuse, as the API documents it.

// A company's name for the picker's rows: an id that is author/model carries its own, a bare one belongs to a family the
// start of its id knows. What neither says is the author's id made readable.
const VENDORS = {
 anthropic: 'Anthropic', deepseek: 'DeepSeek', google: 'Google', inclusionai: 'Inclusion AI', meituan: 'Meituan',
 meta: 'Meta', minimaxai: 'MiniMax', mistral: 'Mistral', moonshotai: 'Moonshot', nvidia: 'NVIDIA', openai: 'OpenAI',
 poolside: 'Poolside', qwen: 'Qwen', sakana: 'Sakana', stepfun: 'StepFun', tencent: 'Tencent',
 thinkingmachines: 'Thinking Machines', xai: 'xAI', xiaomi: 'Xiaomi', 'z-ai': 'Z.AI', 'zai-org': 'Z.AI',
};
const FAMILIES = [['claude', 'Anthropic'], ['gpt', 'OpenAI']];
const titled = slug => slug.split(/[-_]/).filter(Boolean).map(word => word.charAt(0).toUpperCase() + word.slice(1)).join(' ');

function groupOf(model) {
 const id = String(model.id || ''), head = id.split('/')[0].toLowerCase();
 if (id.includes('/')) return VENDORS[head] || titled(head);
 const family = FAMILIES.find(([start]) => id.toLowerCase().startsWith(start));
 return family ? family[1] : titled(String(model.name || id).split(/\s+/)[0]);
}

// Which endpoint a model answers on, kept from the list as it is read: a request carries no more than the model's id.
const wires = new Map();
const wireOf = model => wires.get(model) || (/^claude/i.test(model) ? 'messages' : 'chat');

function described(list) {
 return list.filter(model => model?.id).map(model => {
  const routes = Array.isArray(model.supported_endpoints) ? model.supported_endpoints : [];
  // A Claude model is served on the Messages endpoint alone; every other model takes Chat Completions.
  const wire = routes.includes('/messages') && !routes.includes('/chat/completions') ? 'messages' : 'chat';
  wires.set(model.id, wire);
  return {
   id: `commandcode:${model.id}`,
   provider: 'commandcode',
   api: model.id,
   name: model.name || model.id,
   group: groupOf(model),
   context: Number(model.context_length) || 200000,
   vision: true,
   tools: true,
   efforts: EFFORTS.slice(),
   defaultEffort: 'high',
   thinking: wire === 'messages' ? 'budget' : 'levels',
  };
 });
}

// The list of models answers anyone at all and says nothing of the key behind a request, so the key is checked with a
// request that names a model the catalog doesn't hold. It costs nothing either way: a key that isn't taken is turned
// back before the model is looked at, and a working one gets the plain 400 the unknown name earns.
async function checked(key, { apiUrl }) {
 if (!key) return;
 let response;
 try {
  response = await fetch(`${apiUrl}/chat/completions`, {
   method: 'POST',
   headers: { ...headers(key), 'Content-Type': 'application/json' },
   body: JSON.stringify({ model: '__openghost_key_check__', messages: [] }),
  });
 } catch {
  throw error('network', 0, 'network');
 }
 if (!response.ok && [401, 402, 403].includes(response.status)) throw await failure(response);
}

async function models({ key }, { apiUrl = API_URL } = {}) {
 let response;
 try {
  response = await fetch(`${apiUrl}/models`, { headers: headers(key) });
 } catch {
  throw error('network', 0, 'network');
 }
 if (!response.ok) throw await failure(response);
 const list = (await response.json()).data;
 if (!Array.isArray(list)) throw error('Command Code sent no list of models');
 await checked(key, { apiUrl });
 return described(list);
}

const text = content => typeof content === 'string' ? content : (content || []).filter(part => part.type === 'text').map(part => part.text).join('\n');

function parts(content, vision) {
 if (!Array.isArray(content)) return content || '';
 return content.map(part => part.type !== 'image_url' ? { type: 'text', text: part.text || '' }
  : vision ? { type: 'image_url', image_url: { url: part.image_url.url } } : { type: 'text', text: NO_VISION });
}

function turn(message, { vision }) {
 if (message.role === 'tool') return { role: 'tool', tool_call_id: message.tool_call_id, content: message.content || '' };
 if (message.role !== 'assistant') return { role: message.role === 'system' ? 'system' : 'user', content: parts(message.content, vision) };
 const calls = (message.tool_calls || []).map(call => ({ id: call.id, type: 'function', function: { name: call.function.name, arguments: call.function.arguments || '{}' } }));
 const out = { role: 'assistant', content: message.content || (calls.length ? null : '') };
 if (calls.length) out.tool_calls = calls;
 return out;
}

// The system prompt's parts open the request as one message.
function convert(messages, { vision = true } = {}) {
 const lead = messages.findIndex(message => message.role !== 'system'), count = lead < 0 ? messages.length : lead;
 const system = messages.slice(0, count).map(message => text(message.content)).filter(Boolean), out = [];
 if (system.length) out.push({ role: 'system', content: system.join('\n\n') });
 for (const message of messages.slice(count)) out.push(turn(message, { vision }));
 return out;
}

// The one word of this app's effort the wire takes: a level saying how hard to think, and silence for 'none'.
function thinking({ thinking: mode, effort }) {
 if (mode !== 'levels' || !effort || effort === 'none') return {};
 return { reasoning_effort: effort };
}

function build(request, extras = { effort: true }) {
 const { model, vision = true, messages, tools, maxTokens, output, once = false } = request;
 const body = {
  model,
  messages: convert(messages, { vision }),
  stream: true,
  stream_options: { include_usage: true },
  ...(extras.effort ? thinking(request) : {}),
 };
 // A model that thinks even when nothing asks it to spends its room on thinking first, so a side request gets room for both.
 const room = maxTokens && once ? Math.max(maxTokens, THINKING_ROOM) : maxTokens;
 if (room) body.max_tokens = output ? Math.min(room, output) : room;
 // Which tool to call is the model's to choose: a request says so by itself by carrying tools and no word of a choice.
 if (tools?.length) {
  body.tools = tools.map(tool => ({ type: 'function', function: { name: tool.function.name, description: tool.function.description, parameters: tool.function.parameters } }));
 }
 return body;
}

async function* events(body) {
 const decoder = new TextDecoder();
 let buffer = '';
 for await (const chunk of body) {
  buffer += decoder.decode(chunk, { stream: true });
  const lines = buffer.split('\n');
  buffer = lines.pop();
  for (const raw of lines) {
   // Lines that begin with a colon only keep the connection open.
   const line = raw.trimEnd();
   if (!line.startsWith('data:')) continue;
   const data = line.slice(5).trim();
   if (!data || data === '[DONE]') continue;
   let event;
   try { event = JSON.parse(data); } catch { continue; }
   yield event;
  }
 }
}

async function post(request, body, { signal, apiUrl }) {
 try {
  return await fetch(`${apiUrl}/chat/completions`, {
   method: 'POST', signal,
   headers: { ...headers(request.key), 'Content-Type': 'application/json', Accept: 'text/event-stream' },
   body: JSON.stringify(body),
  });
 } catch (cause) {
  if (cause.name === 'AbortError') throw cause;
  throw error('network', 0, 'network');
 }
}

// The models that turned the effort word down, remembered while the app runs, and the words a refusal names it by.
const refused = new Set();
const NAMED = /reason|think|effort|parameter|unknown|unrecognized/i;

async function chat(request, { signal, onEvent = () => {}, apiUrl = API_URL } = {}) {
 const model = request.model, extras = { effort: !refused.has(model) };
 // The request goes with the effort word unless the model is known to turn it down; turned down before anything was
 // answered, it goes again without it, and that model is not asked again.
 let response, dropped = false;
 for (;;) {
  const body = build(request, extras);
  response = await post(request, body, { signal, apiUrl });
  if (response.ok) break;
  const problem = await failure(response);
  const extra = problem.status === 400 && body.reasoning_effort && NAMED.test(problem.message) ? 'effort' : '';
  if (!extra) throw problem;
  extras.effort = false;
  dropped = true;
 }
 if (dropped) refused.add(model);
 const calls = [];
 const result = { content: '', reasoning: '', toolCalls: [], finishReason: null, usage: null };
 try {
  for await (const event of events(response.body)) {
   // A model can fail mid-answer: the stream then carries the error instead of an HTTP status.
   if (event.error) throw error(event.error.message || 'Command Code stopped the answer', Number(event.error.code) || 0, String(event.error.code || event.error.type || ''));
   if (event.usage) {
    const usage = event.usage, sent = usage.prompt_tokens_details || {};
    result.usage = {
     prompt_tokens: usage.prompt_tokens || 0,
     completion_tokens: usage.completion_tokens || 0,
     total_tokens: usage.total_tokens || (usage.prompt_tokens || 0) + (usage.completion_tokens || 0),
     cached_tokens: sent.cached_tokens || usage.prompt_cache_hit_tokens || 0,
     written_tokens: sent.cache_write_tokens || 0,
    };
   }
   const choice = event.choices?.[0];
   if (!choice) continue;
   const delta = choice.delta || {};
   const thought = typeof delta.reasoning === 'string' ? delta.reasoning : delta.reasoning_content;
   if (thought) {
    result.reasoning += thought;
    onEvent({ type: 'reasoning', delta: thought });
   }
   if (typeof delta.content === 'string' && delta.content) {
    result.content += delta.content;
    onEvent({ type: 'content', delta: delta.content });
   }
   for (const part of delta.tool_calls || []) {
    // A piece says which call it belongs to by its index; one that doesn't belongs to the last call, unless it brings
    // a new id.
    const last = calls.length - 1, fresh = part.id && last >= 0 && calls[last].id && calls[last].id !== part.id;
    const call = calls[part.index ?? (fresh ? last + 1 : Math.max(0, last))] ||= { id: '', type: 'function', function: { name: '', arguments: '' } };
    if (part.id) call.id = part.id;
    if (part.function?.name) call.function.name += part.function.name;
    if (part.function?.arguments) call.function.arguments += part.function.arguments;
   }
   if (choice.finish_reason) result.finishReason = choice.finish_reason;
  }
 } catch (cause) {
  if (cause.name === 'AbortError' || cause.status !== undefined) throw cause;
  throw error('network', 0, 'network');
 }
 result.toolCalls = calls.filter(call => call?.function.name);
 // A tool call cut off at the length limit is never run.
 if (result.finishReason === 'length') result.toolCalls = [];
 if (!FINISH.has(result.finishReason)) result.finishReason = result.toolCalls.length ? 'tool_calls' : 'stop';
 return result;
}

// A thinking block is signed for the account that wrote it, so only the provider that got one ever gets it back. On the
// way to the Anthropic engine a Claude model sees this provider's blocks as its own and any other's not at all, and
// what comes back is stored as this provider's again.
const towards = message => {
 const native = message.native;
 if (native?.provider === 'commandcode') return { ...message, native: { ...native, provider: 'anthropic' } };
 if (native?.provider === 'anthropic') return { ...message, native: null };
 return message;
};

async function stream(request, context = {}) {
 const { apiUrl = API_URL } = context;
 if (wireOf(request.model) !== 'messages') return chat(request, context);
 // The SDK builds its route from the root, without the /v1.
 const asked = { ...request, messages: request.messages.map(towards) };
 const result = await Claude.stream(asked, { ...context, baseURL: apiUrl.replace(/\/v1$/, '') });
 if (result.native) result.native = { ...result.native, provider: 'commandcode' };
 return result;
}

module.exports = { models, stream, convert, build, described };
