import { oai_settings, sendOpenAIRequest } from '../../../openai.js';

const EXTENSION_NAME = 'SystemMessageInjector';
const BUILD_TAG = '2026-10-25-bounded-diagnostics';
const RAW_CAPTURE_BODY_LIMIT = 50000;
const RAW_CAPTURE_HISTORY_LIMIT = 20;
const REQUEST_ENVELOPE_HISTORY_LIMIT = 50;
const REQUEST_HISTORY_BYTE_LIMIT = 256 * 1024;
const RAW_HISTORY_BYTE_LIMIT = 512 * 1024;
const DIAGNOSTIC_TTL_MS = 15 * 60 * 1000;
const RESPONSE_INSPECTION_BYTE_LIMIT = 128 * 1024;
let diagnosticsEnabled = false;
let diagnosticExpiryTimer = null;
// Functional fallback configuration is independent of optional debug history.
let lastWorkingNormalConfig = null;

function diagnosticString(value, limit = 2048) {
    if (typeof value !== 'string') return ['number', 'boolean'].includes(typeof value) ? value : null;
    return truncateText(value, limit);
}

function pruneDiagnosticHistory(history, byteLimit, countLimit) {
    const cutoff = Date.now() - DIAGNOSTIC_TTL_MS;
    let bytes = 0;
    let keep = 0;
    for (const item of history) {
        if (Date.parse(item.timestamp) < cutoff) break;
        const cost = 2 * JSON.stringify(item).length;
        if (keep >= countLimit || bytes + cost > byteLimit) break;
        bytes += cost;
        keep++;
    }
    history.length = keep;
    return history;
}

function refreshDiagnosticExpiry() {
    if (diagnosticExpiryTimer !== null) clearTimeout(diagnosticExpiryTimer);
    diagnosticExpiryTimer = null;
    const requests = pruneDiagnosticHistory(window.__SMI_REQUEST_ENVELOPE_HISTORY || [], REQUEST_HISTORY_BYTE_LIMIT, REQUEST_ENVELOPE_HISTORY_LIMIT);
    const raw = pruneDiagnosticHistory(window.__SMI_RAW_RESPONSE_HISTORY || [], RAW_HISTORY_BYTE_LIMIT, RAW_CAPTURE_HISTORY_LIMIT);
    window.__SMI_LAST_REQUEST_ENVELOPE = requests[0] || null;
    window.__SMI_LAST_RAW_RESPONSE = raw[0] || null;
    const oldest = Math.min(...[requests.at(-1), raw.at(-1)].filter(Boolean).map(item => Date.parse(item.timestamp)));
    if (Number.isFinite(oldest)) {
        diagnosticExpiryTimer = setTimeout(refreshDiagnosticExpiry, Math.max(1, oldest + DIAGNOSTIC_TTL_MS + 1 - Date.now()));
    }
}

async function readResponsePrefix(response, maxBytes = RESPONSE_INSPECTION_BYTE_LIMIT) {
    const clone = response.clone();
    const reader = clone.body?.getReader?.();
    if (!reader) return { text: '', truncated: false };
    const decoder = new TextDecoder();
    let text = '';
    let bytes = 0;
    let complete = false;
    try {
        while (bytes < maxBytes) {
            const { done, value } = await reader.read();
            if (done) { complete = true; break; }
            const part = value.subarray(0, maxBytes - bytes);
            bytes += part.byteLength;
            text += decoder.decode(part, { stream: true });
        }
        text += decoder.decode();
        return { text, truncated: !complete };
    } finally {
        if (!complete) reader.cancel().catch(() => {});
        reader.releaseLock?.();
    }
}

function prepareRequestCapture(body) {
    const workingConfig = {};
    // Only fields consumed by applyWorkingNormalConfig; no messages or tools.
    for (const key of ['chat_completion_source', 'model', 'custom_model_id', 'custom_url',
        'custom_include_body', 'custom_include_headers', 'custom_exclude_body',
        'custom_prompt_post_processing', 'user_name', 'char_name']) {
        const value = body?.[key];
        if (typeof value === 'string' || value == null) workingConfig[key] = value ?? null;
    }
    workingConfig.group_names_count = Array.isArray(body?.group_names) ? body.group_names.length : null;
    return { request: summarizeRequestBodyForCapture(body), request_shape: buildRequestShapeForDiff(body), workingConfig };
}

const MEMORYBOOKS_DELIMITERS = [
    '=== SCENE TRANSCRIPT ===',
    '=== SCENE TEXT ===',
    '=== MEMORIES ===',
    '=== ARC SUMMARY ===',
];

const MEMORYBOOKS_END_MARKERS = [
    '=== END SCENE ===',
    '=== END MEMORIES ===',
    '=== END SUMMARY ===',
];

const GENERIC_SECTION_MARKER_REGEX = /^=== [^\n=]+ ===$/m;

function getRequestUrl(target) {
    if (typeof target === 'string') return target;
    if (target instanceof URL) return target.href;
    if (typeof Request !== 'undefined' && target instanceof Request) return target.url;
    return '';
}

function isGenerateRequest(url, options, target) {
    const method = String(
        options?.method ||
        (typeof Request !== 'undefined' && target instanceof Request ? target.method : ''),
    ).toUpperCase();

    return method === 'POST' && url.includes('/api/backends/chat-completions/generate');
}

function looksLikeMemoryBooksPrompt(content, stack = '') {
    if (MEMORYBOOKS_DELIMITERS.some(d => content.includes(d))) return true;
    if (MEMORYBOOKS_END_MARKERS.some(d => content.includes(d))) return true;
    if (stack.includes('SillyTavern-MemoryBooks') && GENERIC_SECTION_MARKER_REGEX.test(content)) return true;
    return false;
}

function isMemoryBooksRequest(body, stack = '') {
    if (body?.messages?.length !== 1) return false;
    if (body.messages[0].role !== 'user') return false;
    const content = body.messages[0].content;
    if (typeof content !== 'string') return false;
    return looksLikeMemoryBooksPrompt(content, stack);
}

function isCustomEndpointRequest(body) {
    if (body?.chat_completion_source === 'custom') return true;
    if (typeof body?.custom_url === 'string' && body.custom_url.trim().length > 0) return true;
    return false;
}

function findSplitDelimiter(content) {
    const knownDelimiter = MEMORYBOOKS_DELIMITERS.find(d => content.includes(d));
    if (knownDelimiter) return knownDelimiter;

    const genericMarker = content.match(GENERIC_SECTION_MARKER_REGEX);
    if (genericMarker && typeof genericMarker.index === 'number' && genericMarker.index > 0) {
        return genericMarker[0];
    }

    return null;
}

function splitMemoryBooksPrompt(content, delimiter) {
    if (!delimiter) return null;

    const idx = content.indexOf(delimiter);
    if (idx > 0) {
        const systemContent = content.substring(0, idx).trim();
        const userContent = content.substring(idx).trim();
        if (systemContent && userContent) {
            return {
                systemContent,
                userContent,
            };
        }
    }

    return null;
}

function extractTextFromContent(content) {
    if (typeof content === 'string') {
        return content;
    }

    if (content && typeof content === 'object' && typeof content.text === 'string') {
        return content.text;
    }

    if (!Array.isArray(content)) {
        return null;
    }

    const parts = [];
    for (const item of content) {
        if (typeof item === 'string') {
            parts.push(item);
            continue;
        }

        if (!item || typeof item !== 'object') {
            continue;
        }

        if (typeof item.text === 'string') {
            parts.push(item.text);
            continue;
        }

        if (typeof item.content === 'string') {
            parts.push(item.content);
            continue;
        }

        if (Array.isArray(item.content)) {
            const nested = extractTextFromContent(item.content);
            if (nested) {
                parts.push(nested);
            }
        }
    }

    if (!parts.length) {
        return null;
    }

    return parts.join('');
}

function extractTextFromOutputArray(output) {
    if (!Array.isArray(output)) {
        return null;
    }

    const parts = [];
    for (const item of output) {
        if (!item || typeof item !== 'object') {
            continue;
        }

        const direct = extractTextFromContent(item.content);
        if (direct) {
            parts.push(direct);
            continue;
        }

        if (typeof item.text === 'string') {
            parts.push(item.text);
        }
    }

    if (!parts.length) {
        return null;
    }

    return parts.join('');
}

function extractTextFromResponsePayload(payload) {
    const choiceMessageText = extractTextFromContent(payload?.choices?.[0]?.message?.content);
    if (choiceMessageText) {
        return choiceMessageText;
    }

    const choiceText = payload?.choices?.[0]?.text;
    if (typeof choiceText === 'string' && choiceText) {
        return choiceText;
    }

    const contentText = extractTextFromContent(payload?.content);
    if (contentText) {
        return contentText;
    }

    if (typeof payload?.output_text === 'string' && payload.output_text) {
        return payload.output_text;
    }

    const outputText = extractTextFromOutputArray(payload?.output);
    if (outputText) {
        return outputText;
    }

    return null;
}

function truncateText(value, maxLength = RAW_CAPTURE_BODY_LIMIT) {
    if (typeof value !== 'string') {
        return '';
    }

    if (value.length <= maxLength) {
        return value;
    }

    return `${value.slice(0, maxLength)}\n\n...[truncated ${value.length - maxLength} chars]`;
}

function cloneHeadersAsObject(headers) {
    const result = {};
    if (!headers) {
        return result;
    }

    for (const [key, value] of Array.from(headers.entries()).slice(0, 32)) {
        if (key.toLowerCase() === 'authorization') {
            result[key] = '[redacted]';
        } else {
            result[truncateText(key, 128)] = truncateText(value, 512);
        }
    }

    return result;
}

function summarizeRequestBodyForCapture(requestBody) {
    const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
    return {
        model: diagnosticString(requestBody?.model),
        custom_model_id: diagnosticString(requestBody?.custom_model_id),
        custom_url: diagnosticString(requestBody?.custom_url),
        chat_completion_source: diagnosticString(requestBody?.chat_completion_source),
        max_tokens: diagnosticString(requestBody?.max_tokens),
        max_completion_tokens: diagnosticString(requestBody?.max_completion_tokens),
        max_output_tokens: diagnosticString(requestBody?.max_output_tokens),
        stream: diagnosticString(requestBody?.stream),
        message_count: messages.length,
        messages: (diagnosticsEnabled ? messages.slice(-64) : []).map((m, index) => ({
            index: Math.max(0, messages.length - 64) + index,
            role: diagnosticString(m?.role, 64),
            content_length: typeof m?.content === 'string' ? m.content.length : null,
            content_preview: typeof m?.content === 'string'
                ? truncateText(m.content, 300)
                : null,
        })),
    };
}

function buildRequestShapeForDiff(requestBody) {
    const messages = Array.isArray(requestBody?.messages) ? requestBody.messages : [];
    return {
        chat_completion_source: diagnosticString(requestBody?.chat_completion_source),
        model: diagnosticString(requestBody?.model),
        custom_model_id: diagnosticString(requestBody?.custom_model_id),
        custom_url: diagnosticString(requestBody?.custom_url),
        temperature: diagnosticString(requestBody?.temperature),
        max_tokens: diagnosticString(requestBody?.max_tokens),
        max_completion_tokens: diagnosticString(requestBody?.max_completion_tokens),
        max_output_tokens: diagnosticString(requestBody?.max_output_tokens),
        stream: diagnosticString(requestBody?.stream),
        custom_prompt_post_processing: diagnosticString(requestBody?.custom_prompt_post_processing),
        custom_include_body: diagnosticString(requestBody?.custom_include_body),
        custom_include_headers: diagnosticString(requestBody?.custom_include_headers),
        custom_exclude_body: diagnosticString(requestBody?.custom_exclude_body),
        user_name: diagnosticString(requestBody?.user_name),
        char_name: diagnosticString(requestBody?.char_name),
        group_names_count: Array.isArray(requestBody?.group_names) ? requestBody.group_names.length : null,
        stop_count: Array.isArray(requestBody?.stop) ? requestBody.stop.length : null,
        tool_count: Array.isArray(requestBody?.tools) ? requestBody.tools.length : null,
        message_count: messages.length,
        messages: (diagnosticsEnabled ? messages.slice(-64) : []).map((message, index) => ({
            index: Math.max(0, messages.length - 64) + index,
            role: diagnosticString(message?.role, 64),
            name: diagnosticString(message?.name, 256),
            content_type: Array.isArray(message?.content) ? 'array' : typeof message?.content,
            content_length: typeof message?.content === 'string' ? message.content.length : null,
        })),
    };
}

function flattenForDiff(value, prefix = '', out = {}) {
    const key = prefix || '(root)';
    if (value === null || value === undefined || typeof value !== 'object') {
        out[key] = value;
        return out;
    }

    if (Array.isArray(value)) {
        out[`${key}.length`] = value.length;
        for (let i = 0; i < value.length; i++) {
            flattenForDiff(value[i], `${key}[${i}]`, out);
        }
        return out;
    }

    const entries = Object.entries(value);
    if (!entries.length) {
        out[key] = {};
        return out;
    }

    for (const [childKey, childValue] of entries) {
        const childPath = prefix ? `${prefix}.${childKey}` : childKey;
        flattenForDiff(childValue, childPath, out);
    }

    return out;
}

function diffRequestShapes(leftShape, rightShape) {
    const left = flattenForDiff(leftShape);
    const right = flattenForDiff(rightShape);
    const keys = new Set([...Object.keys(left), ...Object.keys(right)]);
    const diffs = [];

    for (const key of Array.from(keys).sort()) {
        const leftValue = left[key];
        const rightValue = right[key];
        if (JSON.stringify(leftValue) !== JSON.stringify(rightValue)) {
            diffs.push({
                path: key,
                memorybooks: leftValue,
                normal_chat: rightValue,
            });
        }
    }

    return diffs;
}

function publishRequestEnvelope(envelope) {
    if (!diagnosticsEnabled) {
        envelope.request.messages = [];
        envelope.request_shape.messages = [];
    }
    const history = Array.isArray(window.__SMI_REQUEST_ENVELOPE_HISTORY)
        ? window.__SMI_REQUEST_ENVELOPE_HISTORY
        : [];
    history.unshift(envelope);
    pruneDiagnosticHistory(history, REQUEST_HISTORY_BYTE_LIMIT, REQUEST_ENVELOPE_HISTORY_LIMIT);
    window.__SMI_REQUEST_ENVELOPE_HISTORY = history;
    window.__SMI_LAST_REQUEST_ENVELOPE = history[0] || null;
    refreshDiagnosticExpiry();
}

async function recordRequestEnvelope({
    isMemoryBooks,
    stage,
    variant,
    requestBody,
    requestCapture = null,
    response = null,
    responsePayload = null,
}) {
    const capture = requestCapture || prepareRequestCapture(requestBody);
    requestBody = null;
    const envelope = {
        id: `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`,
        timestamp: new Date().toISOString(),
        is_memorybooks: Boolean(isMemoryBooks),
        stage: String(stage || ''),
        variant: String(variant || ''),
        request: capture.request,
        request_shape: capture.request_shape,
        response: null,
    };

    if (response) {
        const contentType = String(response.headers.get('content-type') || '').toLowerCase();
        const summary = {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            content_type: contentType,
            has_error_payload: false,
            error_message: null,
        };

        if (responsePayload && typeof responsePayload === 'object') {
            const errorMessage = responsePayload?.error?.message;
            if (typeof errorMessage === 'string' && errorMessage.trim()) {
                summary.has_error_payload = true;
                summary.error_message = truncateText(errorMessage.trim(), 1000);
            }
        } else if (response.ok && !capture.request.stream && contentType.includes('application/json')) {
            try {
                const prefix = await readResponsePrefix(response);
                summary.inspection_truncated = prefix.truncated;
                const parsed = prefix.truncated ? null : JSON.parse(prefix.text);
                const errorMessage = parsed?.error?.message;
                if (typeof errorMessage === 'string' && errorMessage.trim()) {
                    summary.has_error_payload = true;
                    summary.error_message = truncateText(errorMessage.trim(), 1000);
                }
            } catch {
                // ignore parse errors for envelope summaries
            }
        }

        envelope.response = summary;
    }

    if (!isMemoryBooks && envelope.response?.ok && !envelope.response.has_error_payload
        && !envelope.response.inspection_truncated && capture.workingConfig.chat_completion_source === 'custom') {
        lastWorkingNormalConfig = capture.workingConfig;
    }
    publishRequestEnvelope(envelope);
}

function findLastEnvelope(predicate) {
    refreshDiagnosticExpiry();
    const history = Array.isArray(window.__SMI_REQUEST_ENVELOPE_HISTORY)
        ? window.__SMI_REQUEST_ENVELOPE_HISTORY
        : [];
    return history.find(predicate) || null;
}

function getLastMemoryBooksEnvelope() {
    return findLastEnvelope(item => item?.is_memorybooks === true);
}

function getLastNormalEnvelope() {
    return findLastEnvelope(item =>
        item?.is_memorybooks === false
        && item?.response?.ok === true
        && item?.response?.has_error_payload === false
        && item?.request_shape?.chat_completion_source === 'custom',
    ) || findLastEnvelope(item =>
        item?.is_memorybooks === false
        && item?.response?.ok === true
        && item?.response?.has_error_payload === false,
    );
}

function diffLastMemoryBooksVsNormal() {
    const memoryBooks = getLastMemoryBooksEnvelope();
    const normal = getLastNormalEnvelope();

    if (!memoryBooks || !normal) {
        return {
            ok: false,
            message: 'Need both one MemoryBooks envelope and one successful normal-chat envelope.',
            memorybooks_found: Boolean(memoryBooks),
            normal_found: Boolean(normal),
        };
    }

    const diffs = diffRequestShapes(memoryBooks.request_shape, normal.request_shape);
    return {
        ok: true,
        memorybooks_id: memoryBooks.id,
        normal_id: normal.id,
        memorybooks_timestamp: memoryBooks.timestamp,
        normal_timestamp: normal.timestamp,
        diff_count: diffs.length,
        diffs,
    };
}

function getWorkingNormalShape() {
    return lastWorkingNormalConfig;
}

function applyWorkingNormalConfig(body) {
    const working = getWorkingNormalShape();
    if (!working) {
        return body;
    }

    const next = { ...body };
    next.chat_completion_source = 'custom';

    if (typeof working.model === 'string' && working.model.trim()) {
        next.model = working.model;
    }
    if (typeof working.custom_url === 'string' && working.custom_url.trim()) {
        next.custom_url = working.custom_url;
    }
    if (typeof working.custom_include_body === 'string') {
        next.custom_include_body = working.custom_include_body;
    }
    if (typeof working.custom_include_headers === 'string') {
        next.custom_include_headers = working.custom_include_headers;
    }
    if (typeof working.custom_exclude_body === 'string') {
        next.custom_exclude_body = working.custom_exclude_body;
    }
    if (typeof working.custom_prompt_post_processing === 'string') {
        next.custom_prompt_post_processing = working.custom_prompt_post_processing;
    }
    if (typeof working.user_name === 'string' && working.user_name) {
        next.user_name = working.user_name;
    }
    if (typeof working.char_name === 'string' && working.char_name) {
        next.char_name = working.char_name;
    }
    if (!Array.isArray(next.group_names) && Number.isFinite(working.group_names_count)) {
        next.group_names = [];
    }

    if (working.custom_model_id === null || working.custom_model_id === undefined) {
        delete next.custom_model_id;
    } else if (typeof working.custom_model_id === 'string' && working.custom_model_id.trim()) {
        next.custom_model_id = working.custom_model_id;
    }

    return next;
}

function publishRawCapture(capture) {
    const history = Array.isArray(window.__SMI_RAW_RESPONSE_HISTORY)
        ? window.__SMI_RAW_RESPONSE_HISTORY
        : [];
    history.unshift(capture);
    pruneDiagnosticHistory(history, RAW_HISTORY_BYTE_LIMIT, RAW_CAPTURE_HISTORY_LIMIT);

    window.__SMI_RAW_RESPONSE_HISTORY = history;
    window.__SMI_LAST_RAW_RESPONSE = history[0] || null;
    refreshDiagnosticExpiry();
}

async function recordRawCapture({
    channel,
    attempt,
    variant,
    requestBody,
    response = null,
    payload = null,
    error = null,
}) {
    if (!diagnosticsEnabled) return;
    const capture = {
        timestamp: new Date().toISOString(),
        channel,
        attempt,
        variant,
        request: summarizeRequestBodyForCapture(requestBody),
        response: null,
        error: null,
    };

    if (response) {
        let bodyText = '';
        let truncated = false;
        try {
            const prefix = await readResponsePrefix(response, RAW_CAPTURE_BODY_LIMIT);
            bodyText = prefix.text;
            truncated = prefix.truncated;
        } catch { /* diagnostics must not interfere with generation */ }

        capture.response = {
            ok: response.ok,
            status: response.status,
            statusText: response.statusText,
            headers: cloneHeadersAsObject(response.headers),
            body_text: truncateText(bodyText),
            body_truncated: truncated,
        };
        // A bounded textual preview is enough. Retaining payload as body_json
        // would keep the entire response alive despite the preview limit.
    }

    if (error) {
        capture.error = {
            message: truncateText(String(error?.message || error), 1000),
            stack: truncateText(String(error?.stack || ''), 2000),
        };
    }

    if (diagnosticsEnabled) publishRawCapture(capture);
    // Do not pin diagnostic objects in the developer console.
}

function normalizeResponsePayload(payload) {
    if (!payload || typeof payload !== 'object') {
        return { changed: false, payload };
    }

    if (typeof payload?.choices?.[0]?.message?.content === 'string') {
        return { changed: false, payload };
    }

    const text = extractTextFromResponsePayload(payload);
    if (!text) {
        return { changed: false, payload };
    }

    const normalized = { ...payload };
    if (Array.isArray(payload.choices) && payload.choices[0]?.message) {
        normalized.choices = payload.choices.map((choice, index) => {
            if (index !== 0) return choice;
            return {
                ...choice,
                message: {
                    ...choice.message,
                    content: text,
                },
            };
        });
        return { changed: true, payload: normalized };
    }

    normalized.choices = [{
        index: 0,
        message: {
            role: 'assistant',
            content: text,
        },
        finish_reason: payload?.finish_reason || 'stop',
    }];

    return { changed: true, payload: normalized };
}

function extractTextFromStreamingChunk(payload) {
    if (!payload || typeof payload !== 'object') {
        return '';
    }

    const deltaContent = payload?.choices?.[0]?.delta?.content;
    if (typeof deltaContent === 'string') {
        return deltaContent;
    }

    if (Array.isArray(deltaContent)) {
        const joined = deltaContent
            .map(part => {
                if (typeof part === 'string') return part;
                if (typeof part?.text === 'string') return part.text;
                return '';
            })
            .join('');
        if (joined) {
            return joined;
        }
    }

    const deltaText = payload?.choices?.[0]?.text;
    if (typeof deltaText === 'string') {
        return deltaText;
    }

    const claudeDeltaText = payload?.delta?.text;
    if (typeof claudeDeltaText === 'string') {
        return claudeDeltaText;
    }

    const geminiParts = payload?.candidates?.[0]?.content?.parts;
    if (Array.isArray(geminiParts)) {
        const geminiText = geminiParts
            .map(part => (typeof part?.text === 'string' ? part.text : ''))
            .join('');
        if (geminiText) {
            return geminiText;
        }
    }

    return '';
}

function buildJsonPayloadFromText(text, template = null) {
    const source = (template && typeof template === 'object' && !Array.isArray(template))
        ? template
        : {};
    const payload = {
        ...source,
        id: source.id || `chatcmpl-memorybooks-${Date.now()}`,
        object: source.object || 'chat.completion',
        created: Number.isFinite(source.created) ? source.created : Math.floor(Date.now() / 1000),
        choices: [{
            index: 0,
            message: {
                role: 'assistant',
                content: text,
            },
            finish_reason: 'stop',
        }],
    };

    if (!payload.usage || typeof payload.usage !== 'object') {
        payload.usage = {
            prompt_tokens: 0,
            completion_tokens: 0,
            total_tokens: 0,
        };
    }

    return payload;
}

function splitSseEventBlocks(buffer) {
    const blocks = [];
    let start = 0;

    for (let i = 0; i < buffer.length - 1; i++) {
        if (buffer[i] === '\n' && buffer[i + 1] === '\n') {
            blocks.push(buffer.slice(start, i));
            start = i + 2;
            i += 1;
        }
    }

    return {
        blocks,
        remainder: buffer.slice(start),
    };
}

function parseSseDataBlock(block) {
    const lines = String(block || '').split('\n');
    const dataLines = lines
        .filter(line => line.startsWith('data:'))
        .map(line => line.slice(5).trimStart());

    if (!dataLines.length) {
        return '';
    }

    return dataLines.join('\n').trim();
}

async function convertStreamingResponseToJson(response) {
    if (!response?.ok || !response.body) {
        return response;
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('text/event-stream')) {
        return response;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let text = '';
    let lastPayload = null;
    let errorMessage = '';

    function processBlock(block) {
        const rawData = parseSseDataBlock(block);
        if (!rawData || rawData === '[DONE]') {
            return;
        }

        let parsed = null;
        try {
            parsed = JSON.parse(rawData);
        } catch {
            return;
        }

        lastPayload = parsed;
        const providerError = getProviderErrorMessage(parsed);
        if (providerError) {
            errorMessage = providerError;
            return;
        }

        const chunkText = extractTextFromStreamingChunk(parsed);
        if (chunkText) {
            text += chunkText;
        }
    }

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) {
                break;
            }

            buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
            const { blocks, remainder } = splitSseEventBlocks(buffer);
            buffer = remainder;

            for (const block of blocks) {
                processBlock(block);
            }
        }

        const tail = decoder.decode();
        if (tail) {
            buffer += tail.replace(/\r\n/g, '\n');
        }
        if (buffer.trim()) {
            processBlock(buffer);
        }
    } catch (error) {
        return toJsonResponse({
            error: { message: String(error?.message || error || 'Failed to parse streaming response') },
            quota_error: false,
        }, 502, 'Bad Gateway');
    }

    if (errorMessage) {
        return toJsonResponse({
            error: { message: errorMessage },
            quota_error: false,
        }, 502, 'Bad Gateway');
    }

    if (!text && lastPayload) {
        text = extractTextFromResponsePayload(lastPayload) || '';
    }

    if (!text) {
        return toJsonResponse({
            error: { message: 'Streaming response contained no text output' },
            quota_error: false,
        }, 502, 'Bad Gateway');
    }

    const payload = buildJsonPayloadFromText(text, lastPayload);
    return toJsonResponse(payload);
}

function getProviderErrorMessage(payload) {
    const message = payload?.error?.message;
    if (typeof message === 'string' && message.trim()) {
        return message.trim();
    }

    return '';
}

function isRetryableProviderError(message) {
    const normalized = String(message || '').toLowerCase();
    if (!normalized) {
        return false;
    }

    return [
        'internal server error',
        'bad gateway',
        'gateway timeout',
        'timeout',
        'upstream',
        'temporarily unavailable',
        'overload',
        'rate limit',
    ].some(token => normalized.includes(token));
}

function buildTokenRetryValues(body) {
    const tokenFields = ['max_tokens', 'max_completion_tokens', 'max_output_tokens'];
    let current = 0;

    for (const field of tokenFields) {
        const value = Number(body?.[field]);
        if (Number.isFinite(value) && value > 0) {
            current = Math.max(current, Math.floor(value));
        }
    }

    if (!current) {
        return [0];
    }

    const candidates = [
        current,
        Math.min(current, 2048),
        Math.min(current, 1024),
        Math.min(current, 768),
        Math.min(current, 512),
    ];

    const unique = [];
    for (const value of candidates) {
        if (value > 0 && !unique.includes(value)) {
            unique.push(value);
        }
    }

    return unique.length ? unique : [current];
}

function applyMaxTokensForAttempt(body, maxTokens) {
    if (!maxTokens || maxTokens <= 0) {
        return body;
    }

    const next = { ...body };

    if (next.max_tokens != null) {
        next.max_tokens = maxTokens;
    }
    if (next.max_completion_tokens != null) {
        next.max_completion_tokens = maxTokens;
    }
    if (next.max_output_tokens != null) {
        next.max_output_tokens = Math.min(maxTokens, Number(next.max_output_tokens) || maxTokens);
    }

    return next;
}

async function tryParseJsonResponse(response) {
    try {
        return await response.clone().json();
    } catch {
        return null;
    }
}

function createProviderErrorResponse(response, payload) {
    const headers = new Headers(response.headers);
    headers.set('content-type', 'application/json; charset=utf-8');
    headers.delete('content-length');

    return new Response(JSON.stringify(payload), {
        status: 502,
        statusText: 'Bad Gateway',
        headers,
    });
}

function splitTextIntoChunks(text, maxChunkLength = 2400) {
    if (typeof text !== 'string' || !text) {
        return [];
    }

    const paragraphs = text.split(/\n{2,}/).map(x => x.trim()).filter(Boolean);
    if (!paragraphs.length) {
        return [text];
    }

    const chunks = [];
    let current = '';

    for (const paragraph of paragraphs) {
        if (!current) {
            current = paragraph;
            continue;
        }

        if ((current.length + 2 + paragraph.length) <= maxChunkLength) {
            current += `\n\n${paragraph}`;
            continue;
        }

        chunks.push(current);
        current = paragraph;
    }

    if (current) {
        chunks.push(current);
    }

    return chunks.length ? chunks : [text];
}

function equalJsonBody(left, right) {
    if (left === right) return true;
    if (!left || !right || typeof left !== 'object' || typeof right !== 'object') return false;
    if (Array.isArray(left) !== Array.isArray(right)) return false;
    if (Array.isArray(left) && left.length !== right.length) return false;
    const keys = Object.keys(left).filter(key => left[key] !== undefined);
    const other = Object.keys(right).filter(key => right[key] !== undefined);
    return keys.length === other.length && keys.every(key => Object.hasOwn(right, key) && equalJsonBody(left[key], right[key]));
}

function* iterateBodyVariants(requestBody, limit = 2) {
    const seen = [];

    function* addVariant(name, body) {
        if (seen.some(previous => equalJsonBody(previous, body))) return;
        seen.push(body);
        yield { name, body };
    }

    const hasWorkingNormal = Boolean(getWorkingNormalShape());
    const workingConfigBody = hasWorkingNormal
        ? applyWorkingNormalConfig(requestBody)
        : requestBody;
    const activeConfigBody = applyActiveCustomConfig(workingConfigBody);

    const primaryBody = hasWorkingNormal ? workingConfigBody : activeConfigBody;
    const secondaryBody = hasWorkingNormal ? activeConfigBody : workingConfigBody;
    const primaryName = hasWorkingNormal ? 'split-working-normal' : 'split-active-config';
    const secondaryName = hasWorkingNormal ? 'split-active-config' : 'split-working-normal';

    const streamPrimaryBody = {
        ...primaryBody,
        stream: true,
    };

    yield* addVariant(`${primaryName}-stream`, streamPrimaryBody);
    if (seen.length >= limit) return;

    const messages = primaryBody?.messages;
    if (Array.isArray(messages) && messages.length === 2
        && messages[0]?.role === 'system'
        && messages[1]?.role === 'user'
        && typeof messages[0]?.content === 'string'
        && typeof messages[1]?.content === 'string') {
        const system = messages[0].content;
        const user = messages[1].content;

        if (user.length > 2800) {
            const chunks = splitTextIntoChunks(user, 2400);
            if (chunks.length > 1) {
                yield* addVariant(`chunked-${chunks.length}-stream`, {
                    ...streamPrimaryBody,
                    messages: [
                        { role: 'system', content: system },
                        ...chunks.map(chunk => ({ role: 'user', content: chunk })),
                    ],
                });
                if (seen.length >= limit) return;
                yield* addVariant(`chunked-${chunks.length}`, {
                    ...primaryBody,
                    messages: [
                        { role: 'system', content: system },
                        ...chunks.map(chunk => ({ role: 'user', content: chunk })),
                    ],
                });
                if (seen.length >= limit) return;
            }
        }

        const merged = `${system}\n\n${user}`.trim();
        if (merged) {
            yield* addVariant('single-user-merged', {
                ...primaryBody,
                messages: [{ role: 'user', content: merged }],
            });
            if (seen.length >= limit) return;
        }
    }

    yield* addVariant(primaryName, primaryBody);
    if (seen.length >= limit) return;
    yield* addVariant(`${secondaryName}-stream`, {
        ...secondaryBody,
        stream: true,
    });
    if (seen.length >= limit) return;
    yield* addVariant(secondaryName, secondaryBody);
    if (seen.length >= limit) return;
    yield* addVariant('split', requestBody);

}

function applyActiveCustomConfig(body) {
    const next = { ...body };
    next.chat_completion_source = 'custom';

    const activeUrl = String(oai_settings.custom_url || '').trim();
    if (activeUrl) {
        next.custom_url = activeUrl;
    }

    const activeModel = String(oai_settings.custom_model || '').trim();
    if (activeModel) {
        next.model = activeModel;
        next.custom_model_id = activeModel;
    }

    next.custom_include_body = String(oai_settings.custom_include_body ?? next.custom_include_body ?? '');
    next.custom_include_headers = String(oai_settings.custom_include_headers ?? next.custom_include_headers ?? '');
    next.custom_exclude_body = String(oai_settings.custom_exclude_body ?? next.custom_exclude_body ?? '');
    if (typeof oai_settings.custom_prompt_post_processing === 'string') {
        next.custom_prompt_post_processing = oai_settings.custom_prompt_post_processing;
    }

    return next;
}

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

function getTokenBudgetFromBody(body) {
    const values = [
        Number(body?.max_tokens),
        Number(body?.max_completion_tokens),
        Number(body?.max_output_tokens),
    ].filter(v => Number.isFinite(v) && v > 0).map(v => Math.floor(v));

    if (!values.length) {
        return null;
    }

    return Math.max(...values);
}

function getSettingsPatchForMemoryBooks(requestBody) {
    const tokenBudget = getTokenBudgetFromBody(requestBody);
    const temperature = Number(requestBody?.temperature);

    return {
        chat_completion_source: 'custom',
        custom_url: String(requestBody?.custom_url || oai_settings.custom_url || ''),
        custom_model: String(requestBody?.custom_model_id || requestBody?.model || oai_settings.custom_model || ''),
        custom_include_body: String(requestBody?.custom_include_body ?? oai_settings.custom_include_body ?? ''),
        custom_exclude_body: String(requestBody?.custom_exclude_body ?? oai_settings.custom_exclude_body ?? ''),
        custom_include_headers: String(requestBody?.custom_include_headers ?? oai_settings.custom_include_headers ?? ''),
        temp_openai: Number.isFinite(temperature) ? temperature : Number(oai_settings.temp_openai ?? 1),
        openai_max_tokens: Number.isFinite(tokenBudget) ? tokenBudget : Number(oai_settings.openai_max_tokens ?? 512),
        stream_openai: false,
        // Preserve system/user split for MemoryBooks payloads.
        custom_prompt_post_processing: '',
        request_images: false,
        enable_web_search: false,
    };
}

function getSettingsPatchFromCurrentCustomConfig(requestBody) {
    const tokenBudget = getTokenBudgetFromBody(requestBody);
    const temperature = Number(requestBody?.temperature);

    return {
        chat_completion_source: 'custom',
        custom_url: String(oai_settings.custom_url || requestBody?.custom_url || ''),
        custom_model: String(oai_settings.custom_model || requestBody?.custom_model_id || requestBody?.model || ''),
        custom_include_body: String(oai_settings.custom_include_body ?? ''),
        custom_exclude_body: String(oai_settings.custom_exclude_body ?? ''),
        custom_include_headers: String(oai_settings.custom_include_headers ?? ''),
        temp_openai: Number.isFinite(temperature) ? temperature : Number(oai_settings.temp_openai ?? 1),
        openai_max_tokens: Number.isFinite(tokenBudget) ? tokenBudget : Number(oai_settings.openai_max_tokens ?? 512),
        stream_openai: false,
        // Preserve system/user split for MemoryBooks payloads.
        custom_prompt_post_processing: '',
        request_images: false,
        enable_web_search: false,
    };
}

function getSettingsPatchFromWorkingNormalEnvelope(requestBody) {
    const working = getWorkingNormalShape();
    if (!working) {
        return null;
    }

    const tokenBudget = getTokenBudgetFromBody(requestBody);
    const temperature = Number(requestBody?.temperature);

    return {
        chat_completion_source: 'custom',
        custom_url: String(working.custom_url || requestBody?.custom_url || oai_settings.custom_url || ''),
        custom_model: String(working.model || requestBody?.custom_model_id || requestBody?.model || oai_settings.custom_model || ''),
        custom_include_body: String(working.custom_include_body ?? requestBody?.custom_include_body ?? oai_settings.custom_include_body ?? ''),
        custom_exclude_body: String(working.custom_exclude_body ?? requestBody?.custom_exclude_body ?? oai_settings.custom_exclude_body ?? ''),
        custom_include_headers: String(working.custom_include_headers ?? requestBody?.custom_include_headers ?? oai_settings.custom_include_headers ?? ''),
        temp_openai: Number.isFinite(temperature) ? temperature : Number(oai_settings.temp_openai ?? 1),
        openai_max_tokens: Number.isFinite(tokenBudget) ? tokenBudget : Number(oai_settings.openai_max_tokens ?? 512),
        stream_openai: false,
        custom_prompt_post_processing: typeof working.custom_prompt_post_processing === 'string'
            ? working.custom_prompt_post_processing
            : '',
        request_images: false,
        enable_web_search: false,
    };
}

let settingsPatchQueue = Promise.resolve();

async function withPatchedOpenAISettings(patch, fn) {
    const run = async () => {
        const keys = Object.keys(patch);
        const original = {};

        for (const key of keys) {
            original[key] = oai_settings[key];
            oai_settings[key] = patch[key];
        }

        try {
            return await fn();
        } finally {
            for (const key of keys) {
                oai_settings[key] = original[key];
            }
        }
    };

    settingsPatchQueue = settingsPatchQueue.then(run, run);
    return settingsPatchQueue;
}

function toJsonResponse(payload, status = 200, statusText = 'OK') {
    return new Response(JSON.stringify(payload), {
        status,
        statusText,
        headers: {
            'content-type': 'application/json; charset=utf-8',
        },
    });
}

function shouldTrySillyTavernWorkflow() {
    return window.__SMI_FORCE_ST_WORKFLOW === true;
}

async function trySendWithSillyTavernWorkflow(requestBody) {
    const attempts = [];
    const seen = new Set();
    const MAX_ST_WORKFLOW_ATTEMPTS = 1;

    function addAttempt(name, patch) {
        if (!patch) {
            return;
        }
        const key = JSON.stringify(patch);
        if (seen.has(key)) {
            return;
        }
        seen.add(key);
        attempts.push({ name, patch });
    }

    addAttempt('working-normal-config', getSettingsPatchFromWorkingNormalEnvelope(requestBody));
    addAttempt('request-payload-config', getSettingsPatchForMemoryBooks(requestBody));
    addAttempt('active-st-config', getSettingsPatchFromCurrentCustomConfig(requestBody));

    const selectedAttempts = attempts.slice(0, MAX_ST_WORKFLOW_ATTEMPTS);

    for (let i = 0; i < selectedAttempts.length; i++) {
        const attemptName = selectedAttempts[i].name;
        try {
            if (i > 0) {
                console.warn(`[${EXTENSION_NAME}] Retrying ST workflow with ${attemptName}`);
            }

            const data = await withPatchedOpenAISettings(selectedAttempts[i].patch, async () => {
                return await sendOpenAIRequest('quiet', requestBody.messages, undefined, {});
            });
            await recordRequestEnvelope({
                isMemoryBooks: true,
                stage: 'st-workflow',
                variant: attemptName,
                requestBody: requestBody,
                responsePayload: data,
            });
            await recordRawCapture({
                channel: 'st-workflow',
                attempt: i + 1,
                variant: attemptName,
                requestBody: requestBody,
                payload: data,
            });

            const normalized = normalizeResponsePayload(data);
            if (normalized.changed) {
                console.log(`[${EXTENSION_NAME}] Normalized MemoryBooks response payload (ST workflow)`);
            }

            return toJsonResponse(normalized.payload);
        } catch (error) {
            await recordRequestEnvelope({
                isMemoryBooks: true,
                stage: 'st-workflow-error',
                variant: attemptName,
                requestBody: requestBody,
            });
            await recordRawCapture({
                channel: 'st-workflow-error',
                attempt: i + 1,
                variant: attemptName,
                requestBody: requestBody,
                error,
            });
            if (i === selectedAttempts.length - 1) {
                console.warn(`[${EXTENSION_NAME}] ST workflow failed, falling back:`, error);
            } else {
                console.warn(`[${EXTENSION_NAME}] ST workflow attempt failed:`, error);
            }
        }
    }

    return null;
}

async function sendWithFallback(fetchFn, target, options, requestBody) {
    const MAX_TOTAL_ATTEMPTS = 2;
    const MAX_VARIANTS = 2;
    const MAX_TOKEN_STEPS = 1;
    const RETRY_BACKOFF_MS = [500];

    let lastResponse = null;
    let lastPayload = null;
    let totalAttempts = 0;
    let variantIndex = -1;

    for (const variant of iterateBodyVariants(requestBody, MAX_VARIANTS)) {
        variantIndex++;
        // Once another variant exists, the previous response will not be
        // returned. Release its clone-backed body before the next network wait.
        lastResponse?.body?.cancel?.().catch(() => {});
        lastResponse = null;
        lastPayload = null;
        const tokenRetries = buildTokenRetryValues(variant.body).slice(0, MAX_TOKEN_STEPS);

        if (variantIndex > 0) {
            console.warn(`[${EXTENSION_NAME}] Retrying with message variant: ${variant.name}`);
        }

        for (let tokenIndex = 0; tokenIndex < tokenRetries.length; tokenIndex++) {
            if (totalAttempts >= MAX_TOTAL_ATTEMPTS) {
                return lastResponse;
            }

            if (totalAttempts > 0) {
                const backoffIndex = Math.min(totalAttempts - 1, RETRY_BACKOFF_MS.length - 1);
                await sleep(RETRY_BACKOFF_MS[backoffIndex]);
            }

            totalAttempts += 1;
            const maxTokens = tokenRetries[tokenIndex];
            const bodyForAttempt = applyMaxTokensForAttempt(variant.body, maxTokens);

            if (tokenIndex > 0) {
                console.warn(`[${EXTENSION_NAME}] Retrying MemoryBooks request with max_tokens=${maxTokens}`);
            }

            let response = await fetchFn(target, {
                ...options,
                body: JSON.stringify(bodyForAttempt),
            });
            if (bodyForAttempt.stream === true && response.ok) {
                response = await convertStreamingResponseToJson(response);
            }
            lastResponse = response;

            const payload = await tryParseJsonResponse(response);
            lastPayload = payload;
            await recordRequestEnvelope({
                isMemoryBooks: true,
                stage: 'fallback-fetch',
                variant: variant.name,
                requestBody: bodyForAttempt,
                response,
                responsePayload: payload,
            });
            await recordRawCapture({
                channel: 'fallback-fetch',
                attempt: totalAttempts,
                variant: variant.name,
                requestBody: bodyForAttempt,
                response,
                payload,
            });
            const providerErrorMessage = getProviderErrorMessage(payload);
            const hasRetrySlot = tokenIndex < tokenRetries.length - 1;

            if (hasRetrySlot && (response.status >= 500 || isRetryableProviderError(providerErrorMessage))) {
                continue;
            }

            if (payload && providerErrorMessage && response.ok) {
                const hasVariantSlot = variantIndex < MAX_VARIANTS - 1;
                if (hasVariantSlot && isRetryableProviderError(providerErrorMessage)) {
                    break;
                }

                console.error(`[${EXTENSION_NAME}] Upstream returned error payload: ${providerErrorMessage}`);
                return createProviderErrorResponse(response, payload);
            }

            return response;
        }
    }

    if (lastResponse?.ok && getProviderErrorMessage(lastPayload)) {
        return createProviderErrorResponse(lastResponse, lastPayload);
    }
    return lastResponse;
}

async function normalizeMemoryBooksResponse(response) {
    if (!response?.ok) {
        return response;
    }

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    if (!contentType.includes('application/json')) {
        return response;
    }

    try {
        const payload = await response.clone().json();
        const normalized = normalizeResponsePayload(payload);
        if (!normalized.changed) {
            return response;
        }

        const headers = new Headers(response.headers);
        headers.set('content-type', 'application/json; charset=utf-8');
        headers.delete('content-length');

        console.log(`[${EXTENSION_NAME}] Normalized MemoryBooks response payload`);
        return new Response(JSON.stringify(normalized.payload), {
            status: response.status,
            statusText: response.statusText,
            headers,
        });
    } catch {
        return response;
    }
}

function enrichRequestBody(body) {
    const enriched = { ...body };
    const content = body.messages[0].content;
    const delimiter = findSplitDelimiter(content);
    const splitPrompt = splitMemoryBooksPrompt(content, delimiter);

    if (splitPrompt) {
        enriched.messages = [
            { role: 'system', content: splitPrompt.systemContent },
            { role: 'user', content: splitPrompt.userContent },
        ];
    }

    // MemoryBooks parses JSON responses and cannot consume streamed chunks.
    enriched.stream = false;

    // Add custom-source fields used by the ST backend/proxy merge path.
    if (body.chat_completion_source === 'custom') {
        enriched.custom_url ??= oai_settings.custom_url || '';
        enriched.custom_include_body ??= oai_settings.custom_include_body || '';
        enriched.custom_exclude_body ??= oai_settings.custom_exclude_body || '';
        enriched.custom_include_headers ??= oai_settings.custom_include_headers || '';
    }

    return {
        body: enriched,
        delimiter,
        didSplit: Boolean(splitPrompt),
    };
}

const originalFetch = window.fetch.bind(window);
let unregisterRuntimeBusInterceptor = null;

window.SystemMessageInjector = {
    getBuildInfo: () => ({ extension: EXTENSION_NAME, build: BUILD_TAG }),
    setDiagnosticsEnabled: (enabled) => {
        diagnosticsEnabled = enabled === true;
        window.__SMI_RAW_RESPONSE_HISTORY = [];
        window.__SMI_LAST_RAW_RESPONSE = null;
        window.__SMI_REQUEST_ENVELOPE_HISTORY = [];
        window.__SMI_LAST_REQUEST_ENVELOPE = null;
        refreshDiagnosticExpiry();
        return diagnosticsEnabled;
    },
    getDiagnosticsInfo: () => ({ enabled: diagnosticsEnabled, ttlMs: DIAGNOSTIC_TTL_MS,
        requestByteLimit: REQUEST_HISTORY_BYTE_LIMIT, rawByteLimit: RAW_HISTORY_BYTE_LIMIT,
        maxPreviewMessages: 64 }),
    getLastRawResponse: () => { refreshDiagnosticExpiry(); return window.__SMI_LAST_RAW_RESPONSE || null; },
    getRawResponseHistory: () => Array.isArray(window.__SMI_RAW_RESPONSE_HISTORY)
        ? [...pruneDiagnosticHistory(window.__SMI_RAW_RESPONSE_HISTORY, RAW_HISTORY_BYTE_LIMIT, RAW_CAPTURE_HISTORY_LIMIT)]
        : [],
    getLastRequestEnvelope: () => { refreshDiagnosticExpiry(); return window.__SMI_LAST_REQUEST_ENVELOPE || null; },
    getRequestEnvelopeHistory: () => Array.isArray(window.__SMI_REQUEST_ENVELOPE_HISTORY)
        ? [...pruneDiagnosticHistory(window.__SMI_REQUEST_ENVELOPE_HISTORY, REQUEST_HISTORY_BYTE_LIMIT, REQUEST_ENVELOPE_HISTORY_LIMIT)]
        : [],
    getLastMemoryBooksEnvelope,
    getLastNormalEnvelope,
    diffLastMemoryBooksVsNormal,
    clearRawResponseHistory: () => {
        window.__SMI_RAW_RESPONSE_HISTORY = [];
        window.__SMI_LAST_RAW_RESPONSE = null;
        refreshDiagnosticExpiry();
    },
    clearRequestEnvelopeHistory: () => {
        window.__SMI_REQUEST_ENVELOPE_HISTORY = [];
        window.__SMI_LAST_REQUEST_ENVELOPE = null;
        refreshDiagnosticExpiry();
    },
};

function installLegacyFetchInterceptor() {
    window.fetch = async function (target, options) {
        const url = getRequestUrl(target);

        if (!isGenerateRequest(url, options, target)) {
            return originalFetch(target, options);
        }

        try {
            if (typeof options?.body !== 'string') {
                return originalFetch(target, options);
            }

            let body = JSON.parse(options.body);
            const stack = new Error().stack || '';
            const memoryBooksDetected = isMemoryBooksRequest(body, stack);
            const customEndpointDetected = isCustomEndpointRequest(body);

            if (!memoryBooksDetected || !customEndpointDetected) {
                const requestCapture = prepareRequestCapture(body);
                body = null;
                const passthroughResponse = await originalFetch(target, options);
                await recordRequestEnvelope({
                    isMemoryBooks: memoryBooksDetected,
                    stage: 'passthrough',
                    variant: memoryBooksDetected ? 'non-custom-or-unhandled' : 'normal',
                    requestCapture,
                    response: passthroughResponse,
                });
                return passthroughResponse;
            }

            const enriched = enrichRequestBody(body);
            if (!enriched.didSplit) {
                return originalFetch(target, options);
            }
            const splitInfo = enriched.didSplit
                ? `split at "${enriched.delimiter}"`
                : 'no split marker found';

            console.log(`[${EXTENSION_NAME}] Intercepted MemoryBooks request (${splitInfo})`);
            await recordRequestEnvelope({
                isMemoryBooks: true,
                stage: 'transformed',
                variant: enriched.didSplit ? 'split' : 'no-split',
                requestBody: enriched.body,
            });

            if (shouldTrySillyTavernWorkflow()) {
                const stWorkflowResponse = await trySendWithSillyTavernWorkflow(enriched.body);
                if (stWorkflowResponse) {
                    return stWorkflowResponse;
                }
            } else {
                console.log(`[${EXTENSION_NAME}] Skipping ST workflow: normal chat uses streaming`);
            }

            const response = await sendWithFallback(originalFetch, target, options, enriched.body);
            return normalizeMemoryBooksResponse(response);
        } catch (err) {
            console.error(`[${EXTENSION_NAME}] Error enriching request, falling back:`, err);
        }

        return originalFetch(target, options);
    };
}

function installRuntimeBusFetchInterceptor() {
    const runtimeBus = window.STRuntimeBus;
    if (!runtimeBus?.fetch?.registerInterceptor) return false;
    if (!runtimeBus.fetch.preservesOuterWrappers && runtimeBus.fetch.getChainInfo?.().installed
        && window.fetch?.__fetchInterceptorName !== 'runtime_signal_bus') return false;

    if (unregisterRuntimeBusInterceptor) {
        try {
            unregisterRuntimeBusInterceptor();
        } catch {
            // ignore stale unregister failures
        }
        unregisterRuntimeBusInterceptor = null;
    }

    unregisterRuntimeBusInterceptor = runtimeBus.fetch.registerInterceptor({
        id: EXTENSION_NAME,
        priority: 40,
        requestTransform: async (reqCtx) => {
            const { target, options } = reqCtx;
            const url = getRequestUrl(target);
            if (!isGenerateRequest(url, options, target)) return null;
            if (typeof options?.body !== 'string') return null;

            try {
                const body = typeof reqCtx.getRequestJson === 'function'
                    ? reqCtx.getRequestJson() : JSON.parse(options.body);
                const stack = new Error().stack || '';
                const memoryBooksDetected = isMemoryBooksRequest(body, stack);
                const customEndpointDetected = isCustomEndpointRequest(body);

                if (!memoryBooksDetected || !customEndpointDetected) {
                    return {
                        meta: {
                            smi: {
                                passthrough: true,
                                memoryBooksDetected,
                                variant: memoryBooksDetected ? 'non-custom-or-unhandled' : 'normal',
                                requestCapture: prepareRequestCapture(body),
                            },
                        },
                    };
                }

                const enriched = enrichRequestBody(body);
                if (!enriched.didSplit) {
                    return null;
                }

                const splitInfo = enriched.didSplit
                    ? `split at "${enriched.delimiter}"`
                    : 'no split marker found';
                console.log(`[${EXTENSION_NAME}] Intercepted MemoryBooks request (${splitInfo})`);
                await recordRequestEnvelope({
                    isMemoryBooks: true,
                    stage: 'transformed',
                    variant: enriched.didSplit ? 'split' : 'no-split',
                    requestBody: enriched.body,
                });

                reqCtx.releaseRequestJson?.();
                if (shouldTrySillyTavernWorkflow()) {
                    const stWorkflowResponse = await trySendWithSillyTavernWorkflow(enriched.body);
                    if (stWorkflowResponse) {
                        return {
                            shortCircuitResponse: stWorkflowResponse,
                            meta: {
                                smi: {
                                    usedStWorkflow: true,
                                },
                            },
                        };
                    }
                } else {
                    console.log(`[${EXTENSION_NAME}] Skipping ST workflow: normal chat uses streaming`);
                }

                const response = await sendWithFallback(reqCtx.baseFetch, target, options, enriched.body);
                return {
                    shortCircuitResponse: response,
                    meta: {
                        smi: {
                            shouldNormalize: true,
                        },
                    },
                };
            } catch (error) {
                console.error(`[${EXTENSION_NAME}] Runtime bus transform failed, passing through`, error);
                return null;
            }
        },
        responseTransform: async (resCtx) => {
            if (resCtx?.request?.meta?.smi?.shouldNormalize) {
                return normalizeMemoryBooksResponse(resCtx.response);
            }
            return resCtx.response;
        },
        responseObserve: async (resCtx) => {
            const smiMeta = resCtx?.request?.meta?.smi;
            if (!smiMeta?.passthrough) return;
            delete resCtx.request.meta.smi;
            await recordRequestEnvelope({
                isMemoryBooks: Boolean(smiMeta.memoryBooksDetected),
                stage: 'passthrough',
                variant: smiMeta.variant || 'normal',
                requestCapture: smiMeta.requestCapture,
                response: resCtx.response,
            });
        },
    });

    return true;
}

if (!installRuntimeBusFetchInterceptor()) {
    installLegacyFetchInterceptor();
}

console.log(`[${EXTENSION_NAME}] Active build=${BUILD_TAG}`);
