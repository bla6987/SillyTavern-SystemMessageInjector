import { oai_settings } from '../../../openai.js';

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

        return originalFetch(target, {
            ...options,
            body: JSON.stringify(enriched.body),
        });
    } catch (err) {
        console.error(`[${EXTENSION_NAME}] Error enriching request, falling back:`, err);
    }

    return originalFetch(target, options);
};

console.log(`[${EXTENSION_NAME}] Active`);
