import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const source = readFileSync(new URL('../index.js', import.meta.url), 'utf8').replace(/^import .*;\n/gm, '');
const endpoint = '/api/backends/chat-completions/generate';

function runtime(mode = 'none', responseFactory = () => Response.json({ choices: [{ message: { content: 'hello' } }] })) {
    let interceptor;
    let parseCount = 0;
    const timers = new Map();
    let timerId = 0;
    const calls = [];
    const window = { fetch: async (target, options) => { calls.push({ target, options }); return responseFactory(); } };
    if (mode !== 'none') window.STRuntimeBus = { fetch: { registerInterceptor(spec) { interceptor = spec; return () => {}; } } };
    const context = vm.createContext({ window, oai_settings: {}, URL, Request, Response, Headers, TextDecoder,
        console: { log() {}, warn() {}, error() {} },
        JSON: { parse: value => { parseCount++; return JSON.parse(value); }, stringify: JSON.stringify },
        sendOpenAIRequest() { throw new Error('unexpected ST workflow'); },
        setTimeout: fn => { timers.set(++timerId, fn); return timerId; }, clearTimeout: id => timers.delete(id),
    });
    vm.runInContext(source, context);
    return { context, window, timers, calls, parses: () => parseCount,
        async send(body, url = endpoint) {
            const options = { method: 'POST', body: JSON.stringify(body) };
            if (!interceptor) return window.fetch(url, options);
            const ctx = { target: url, options, meta: {}, baseFetch: window.fetch };
            if (mode === 'new') ctx.getRequestJson = () => body;
            const patch = await interceptor.requestTransform(ctx);
            if (patch?.meta) ctx.meta = patch.meta;
            const response = patch?.shortCircuitResponse || await window.fetch(url, options);
            const res = { request: ctx, response };
            res.response = await interceptor.responseTransform(res);
            await interceptor.responseObserve(res);
            return { response: res.response, context: ctx };
        },
    };
}

for (const mode of ['none', 'old', 'new']) {
    test(`${mode} bus: normal request metadata is compact and response remains readable`, async () => {
        const r = runtime(mode);
        const body = { stream: true, model: 'normal-model', chat_completion_source: 'custom',
            messages: Array.from({ length: 1000 }, () => ({ role: 'user', content: 'large prompt '.repeat(100) })) };
        const result = await r.send(body);
        const response = result.response || result;
        assert.equal((await response.json()).choices[0].message.content, 'hello');
        assert.equal(r.parses(), mode === 'new' ? 0 : 1);
        const envelope = r.window.SystemMessageInjector.getLastRequestEnvelope();
        assert.equal(envelope.request.message_count, 1000);
        assert.equal(envelope.request.messages.length, 0);
        assert.equal(envelope.request_shape.messages.length, 0);
        if (result.context) {
            assert.equal(result.context.meta.smi, undefined, 'finished request metadata is released');
            assert.equal(JSON.stringify(result.context.meta).includes('large prompt'), false);
        }
        r.window.SystemMessageInjector.clearRequestEnvelopeHistory();
        assert.equal(r.context.getWorkingNormalShape().model, 'normal-model', 'debug clearing must preserve fallback config');
    });
}

test('direct image routes and multimodal arrays are not treated as MemoryBooks requests', async () => {
    const r = runtime();
    await r.send({ messages: [{ role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,large' } }] }] },
        'https://openrouter.ai/api/v1/chat/completions');
    assert.equal(r.parses(), 0);
    assert.equal(r.window.SystemMessageInjector.getRequestEnvelopeHistory().length, 0);
    assert.equal(r.context.isMemoryBooksRequest({ messages: [{ role: 'user', content: [] }] }), false);
});

test('raw capture is opt-in, bounded, and never retains full payload objects', async () => {
    const r = runtime();
    const huge = 'x'.repeat(2 * 1024 * 1024);
    await r.context.recordRawCapture({ channel: 'test', requestBody: {}, response: { clone() { throw new Error('disabled'); } } });
    assert.equal(r.window.SystemMessageInjector.getRawResponseHistory().length, 0);
    r.window.SystemMessageInjector.setDiagnosticsEnabled(true);
    const response = new Response(huge);
    await r.context.recordRawCapture({ channel: 'test', requestBody: {}, response, payload: { huge } });
    const capture = r.window.SystemMessageInjector.getLastRawResponse();
    assert.ok(capture.response.body_text.length <= 50000);
    assert.equal(capture.response.body_truncated, true);
    assert.equal('body_json' in capture.response, false);
    assert.equal((await response.text()).length, huge.length);
});

test('diagnostic histories obey byte/count/age limits and release last pointers', async () => {
    const r = runtime();
    r.window.SystemMessageInjector.setDiagnosticsEnabled(true);
    const body = { messages: Array.from({ length: 1000 }, () => ({ role: 'user', content: 'x'.repeat(2000) })) };
    for (let i = 0; i < 80; i++) await r.context.recordRequestEnvelope({ requestBody: body, stage: 'test' });
    const history = r.window.SystemMessageInjector.getRequestEnvelopeHistory();
    assert.ok(history.length <= 50);
    assert.ok(history.reduce((sum, item) => sum + JSON.stringify(item).length * 2, 0) <= 256 * 1024);
    assert.equal(history[0].request.messages.length, 64);
    assert.equal(history[0].request.messages[0].index, 936);
    for (const item of r.window.__SMI_REQUEST_ENVELOPE_HISTORY) item.timestamp = '2000-01-01T00:00:00Z';
    [...r.timers.values()][0]();
    assert.equal(r.window.SystemMessageInjector.getLastRequestEnvelope(), null);
    assert.equal(r.window.SystemMessageInjector.getRequestEnvelopeHistory().length, 0);
});

test('fallback variants build only on demand, preserving the first two layouts', () => {
    const r = runtime();
    const originalSplit = r.context.splitTextIntoChunks;
    let splits = 0;
    r.context.splitTextIntoChunks = (...args) => { splits++; return originalSplit(...args); };
    const body = { messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'paragraph\n\n'.repeat(2000) }] };
    const iterator = r.context.iterateBodyVariants(body, 2);
    const first = iterator.next().value;
    assert.match(first.name, /^split-active-config-stream$/);
    assert.equal(splits, 0, 'a successful first attempt never creates chunk/merged variants');
    const second = iterator.next().value;
    assert.match(second.name, /^chunked-\d+-stream$/);
    assert.equal(splits, 1);
    assert.equal(iterator.next().done, true);
    assert.equal(r.context.equalJsonBody({ a: 1, b: undefined }, { a: 1 }), true);
});

test('fallback sends one successful attempt, or at most two ordered variants on retryable errors', async () => {
    const r = runtime();
    r.context.sleep = async () => {};
    const request = { messages: [{ role: 'system', content: 'rules' }, { role: 'user', content: 'paragraph\n\n'.repeat(2000) }] };
    let attempts = [];
    let splitCalls = 0;
    const originalSplit = r.context.splitTextIntoChunks;
    r.context.splitTextIntoChunks = (...args) => { splitCalls++; return originalSplit(...args); };
    const success = await r.context.sendWithFallback(async (url, options) => {
        attempts.push(JSON.parse(options.body));
        return Response.json({ choices: [{ message: { content: 'done' } }] });
    }, endpoint, { method: 'POST' }, request);
    assert.equal((await success.json()).choices[0].message.content, 'done');
    assert.equal(attempts.length, 1);
    assert.equal(splitCalls, 0);
    attempts = [];
    const failed = await r.context.sendWithFallback(async (url, options) => {
        attempts.push(JSON.parse(options.body));
        return Response.json({ error: { message: 'upstream overload' } });
    }, endpoint, { method: 'POST' }, request);
    assert.equal(attempts.length, 2);
    assert.equal(attempts[0].messages.length, 2);
    assert.ok(attempts[1].messages.length > 2);
    assert.equal(failed.status, 502);
    assert.equal((await failed.json()).error.message, 'upstream overload');
});
