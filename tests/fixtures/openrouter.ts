import type { BrowserContext } from '@playwright/test';
import { defaultSettings } from '../../ui/settings';

export function settings(overrides: Partial<ReturnType<typeof defaultSettings>> = {}) {
  return { ...defaultSettings(), apiKey: 'fixture-not-a-real-key', forceBrowser: true, ...overrides };
}
export async function seed(context: BrowserContext, overrides = {}) {
  await context.addInitScript(value => {
    localStorage.setItem('agentworld.settings.v1', JSON.stringify(value));
  }, settings(overrides));
}
interface Question { criteria: Record<string, unknown> }
interface Candidate { id?: string; type?: string; content?: string }
function answers(questions: Record<string, Question>, state: { selected_elements?: Candidate[] } = {}) {
  const byId = new Map((state.selected_elements ?? []).map(x => [x.id, x]));
  return { answers: Object.fromEntries(Object.entries(questions).map(([name, q]) => {
    const keys = Object.keys(q.criteria); let choice = keys[0]!;
    if (name === 'root') choice = keys.find(k => k !== 'unavailable') ?? choice;
    else if (name.startsWith('select_')) choice = keys.find(k => k.startsWith('use:')) ?? (keys.includes('1') ? '1' : choice);
    else if (name.startsWith('parent_')) {
      const child = byId.get(name.slice(7)); const text = (child?.content ?? '').toLowerCase();
      if (child?.type === 'Link') {
        const wanted = text.includes('related search') ? 'related' : text.includes('outgoing navigation') ? 'outgoing' : 'search result';
        choice = Object.entries(q.criteria).find(([k, description]) => byId.get(k.split(':')[0])?.type === 'Links' && String(description).toLowerCase().includes(wanted))?.[0] ?? choice;
      } else choice = keys.find(k => byId.get(k.split(':')[0])?.type === 'Surface') ?? choice;
    } else if (name.startsWith('order_')) choice = keys.includes('1') ? '1' : choice;
    return [name, { type: 'choice', choice, confidence: 1, probabilities: Object.fromEntries(keys.map(k => [k, k === choice ? 1 : 0])) }];
  })) };
}
export async function mockOpenRouter(context: BrowserContext) {
  const calls: Array<{ path: string; model?: string; task?: string }> = [];
  await context.route('https://openrouter.ai/**', async route => {
    const request = route.request(); const path = new URL(request.url()).pathname;
    const headers = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization,content-type', 'Access-Control-Allow-Methods': 'POST,GET,OPTIONS' };
    if (request.method() === 'OPTIONS') { await route.fulfill({ status: 204, headers }); return; }
    if (path === '/api/v1/models') {
      await route.fulfill({ headers, json: { data: [{ id: 'ordinary/chat-model' }, { id: settings().decisionsModel }] } }); return;
    }
    const body = request.postDataJSON();
    const state = body.messages ? JSON.parse(body.messages[1].content) : body.state;
    calls.push({ path, model: body.model, task: state?.task });
    if (path === '/api/alpha/decisions') {
      if (body.model !== settings().decisionsModel) throw new Error('chat model reached native Decisions');
      await route.fulfill({ headers, json: answers(body.questions, state) }); return;
    }
    if (path !== '/api/v1/chat/completions') throw new Error(`Unexpected provider endpoint: ${path}`);
    const document = state.task === 'page' ? {
      title: 'Fixture page', siteName: 'Fixture', summary: 'Local-only generated fixture.', imageAlt: '',
      sections: [{ heading: 'Overview', kind: 'text', body: 'Fixture overview.' }, { heading: 'Details', kind: 'text', body: 'Fixture details.' }],
      links: [1, 2, 3].map(i => ({ label: `Next ${i}`, url: `https://fixture.example/next-${i}` })),
    } : {
      results: [1, 2, 3, 4].map(i => ({ title: `Result ${i}`, url: `https://fixture.example/page-${i}`, snippet: `Detail ${i}` })),
      related: ['related fixture'],
    };
    await route.fulfill({ headers, json: { choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(document) } }] } });
  });
  return calls;
}
