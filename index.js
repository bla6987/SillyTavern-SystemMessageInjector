import { generateQuietPrompt } from '../../../script.js';

const EXTENSION_NAME = 'SystemMessageInjector';
const SCENE_DELIMITER = '=== SCENE TRANSCRIPT ===';

const originalFetch = window.fetch;

window.fetch = async function (url, options) {
    if (
        options?.method === 'POST' &&
        typeof url === 'string' &&
        url.includes('/api/backends/chat-completions/generate')
    ) {
        try {
            const body = JSON.parse(options.body);

            if (
                body.messages?.length === 1 &&
                body.messages[0].role === 'user' &&
                typeof body.messages[0].content === 'string' &&
                body.messages[0].content.includes(SCENE_DELIMITER)
            ) {
                const promptContent = body.messages[0].content;

                // Extract max_tokens from whichever field MemoryBooks set
                const maxTokens = body.max_tokens
                    ?? body.max_completion_tokens
                    ?? body.max_output_tokens
                    ?? null;

                const responseLength = (typeof maxTokens === 'number' && maxTokens > 0)
                    ? maxTokens
                    : null;

                console.log(`[${EXTENSION_NAME}] Redirecting through generateQuietPrompt`
                    + (responseLength ? ` (maxTokens=${responseLength})` : ''));

                const resultText = await generateQuietPrompt({
                    quietPrompt: promptContent,
                    responseLength,
                    skipWIAN: true,
                    removeReasoning: false,
                });

                // Wrap in OpenAI-format response that MemoryBooks expects
                const fakeBody = JSON.stringify({
                    choices: [{
                        message: { content: resultText || '' },
                        finish_reason: 'stop',
                    }],
                });

                return new Response(fakeBody, {
                    status: 200,
                    statusText: 'OK',
                    headers: { 'Content-Type': 'application/json' },
                });
            }
        } catch (err) {
            console.error(`[${EXTENSION_NAME}] Error during redirect, falling back to raw fetch:`, err);
        }
    }

    return originalFetch.call(this, url, options);
};

console.log(`[${EXTENSION_NAME}] Active`);
