import { name1, name2 } from '../../../../script.js';
import { oai_settings } from '../../../openai.js';

const EXTENSION_NAME = 'SystemMessageInjector';

const MEMORYBOOKS_DELIMITERS = [
    '=== SCENE TRANSCRIPT ===',
    '=== SCENE TEXT ===',
    '=== MEMORIES ===',
    '=== ARC SUMMARY ===',
];

function isMemoryBooksRequest(body) {
    if (body?.messages?.length !== 1) return false;
    if (body.messages[0].role !== 'user') return false;
    const content = body.messages[0].content;
    if (typeof content !== 'string') return false;
    return MEMORYBOOKS_DELIMITERS.some(d => content.includes(d));
}

function enrichRequestBody(body, delimiter) {
    const enriched = { ...body };

    // Split at the delimiter into system (instructions) + user (data)
    const content = body.messages[0].content;
    const idx = content.indexOf(delimiter);
    if (idx > 0) {
        const systemContent = content.substring(0, idx).trim();
        const userContent = content.substring(idx).trim();
        if (systemContent && userContent) {
            enriched.messages = [
                { role: 'system', content: systemContent },
                { role: 'user', content: userContent },
            ];
        }
    }

    // Add fields the ST backend needs for custom source formatting
    if (body.chat_completion_source === 'custom') {
        enriched.custom_include_body ??= oai_settings.custom_include_body || '';
        enriched.custom_exclude_body ??= oai_settings.custom_exclude_body || '';
        enriched.custom_include_headers ??= oai_settings.custom_include_headers || '';
    }

    // Post-processing (message merging) — applies to all sources
    enriched.custom_prompt_post_processing ??= oai_settings.custom_prompt_post_processing || '';

    // Metadata for getPromptNames() used in message post-processing
    enriched.user_name ??= name1;
    enriched.char_name ??= name2;
    enriched.group_names ??= [];

    return enriched;
}

const originalFetch = window.fetch;

window.fetch = async function (url, options) {
    if (
        options?.method === 'POST' &&
        typeof url === 'string' &&
        url.includes('/api/backends/chat-completions/generate')
    ) {
        try {
            const body = JSON.parse(options.body);

            if (isMemoryBooksRequest(body)) {
                const matched = MEMORYBOOKS_DELIMITERS.find(d =>
                    body.messages[0].content.includes(d));
                console.log(`[${EXTENSION_NAME}] Enriching + splitting at (${matched})`);

                const enriched = enrichRequestBody(body, matched);
                return originalFetch.call(this, url, {
                    ...options,
                    body: JSON.stringify(enriched),
                });
            }
        } catch (err) {
            console.error(`[${EXTENSION_NAME}] Error enriching request, falling back:`, err);
        }
    }

    return originalFetch.call(this, url, options);
};

console.log(`[${EXTENSION_NAME}] Active`);
