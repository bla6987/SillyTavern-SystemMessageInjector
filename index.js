import { oai_settings, sendOpenAIRequest } from '../../../openai.js';

const EXTENSION_NAME = 'SystemMessageInjector';

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
        Math.min(current, 4096),
        Math.min(current, 2048),
        Math.min(current, 1536),
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

async function trySendWithSillyTavernWorkflow(requestBody) {
    try {
        const patch = getSettingsPatchForMemoryBooks(requestBody);
        const data = await withPatchedOpenAISettings(patch, async () => {
            return await sendOpenAIRequest('quiet', requestBody.messages, undefined, {});
        });

        const normalized = normalizeResponsePayload(data);
        if (normalized.changed) {
            console.log(`[${EXTENSION_NAME}] Normalized MemoryBooks response payload (ST workflow)`);
        }

        return toJsonResponse(normalized.payload);
    } catch (error) {
        console.warn(`[${EXTENSION_NAME}] ST workflow failed, falling back:`, error);
        return null;
    }
}

async function sendWithFallback(target, options, requestBody) {
    const tokenRetries = buildTokenRetryValues(requestBody);
    let lastResponse = null;

    for (let i = 0; i < tokenRetries.length; i++) {
        const maxTokens = tokenRetries[i];
        const bodyForAttempt = applyMaxTokensForAttempt(requestBody, maxTokens);

        if (i > 0) {
            console.warn(`[${EXTENSION_NAME}] Retrying MemoryBooks request with max_tokens=${maxTokens}`);
        }

        const response = await originalFetch(target, {
            ...options,
            body: JSON.stringify(bodyForAttempt),
        });
        lastResponse = response;

        const payload = await tryParseJsonResponse(response);
        const providerErrorMessage = getProviderErrorMessage(payload);
        const hasRetrySlot = i < tokenRetries.length - 1;

        if (hasRetrySlot && (response.status >= 500 || isRetryableProviderError(providerErrorMessage))) {
            continue;
        }

        if (payload && providerErrorMessage && response.ok) {
            console.error(`[${EXTENSION_NAME}] Upstream returned error payload: ${providerErrorMessage}`);
            return createProviderErrorResponse(response, payload);
        }

        return response;
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

window.fetch = async function (target, options) {
    const url = getRequestUrl(target);

    if (!isGenerateRequest(url, options, target)) {
        return originalFetch(target, options);
    }

    try {
        if (typeof options?.body !== 'string') {
            return originalFetch(target, options);
        }

        const body = JSON.parse(options.body);
        const stack = new Error().stack || '';
        if (!isMemoryBooksRequest(body, stack)) {
            return originalFetch(target, options);
        }
        if (!isCustomEndpointRequest(body)) {
            return originalFetch(target, options);
        }

        const enriched = enrichRequestBody(body);
        if (!enriched.didSplit) {
            return originalFetch(target, options);
        }
        const splitInfo = enriched.didSplit
            ? `split at "${enriched.delimiter}"`
            : 'no split marker found';

        console.log(`[${EXTENSION_NAME}] Intercepted MemoryBooks request (${splitInfo})`);

        const stWorkflowResponse = await trySendWithSillyTavernWorkflow(enriched.body);
        if (stWorkflowResponse) {
            return stWorkflowResponse;
        }

        const response = await sendWithFallback(target, options, enriched.body);
        return normalizeMemoryBooksResponse(response);
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Error enriching request, falling back:`, err);
    }

    return originalFetch(target, options);
};

console.log(`[${EXTENSION_NAME}] Active`);
