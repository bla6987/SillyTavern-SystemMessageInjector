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
                const content = body.messages[0].content;
                const idx = content.indexOf(SCENE_DELIMITER);

                const systemContent = content.substring(0, idx).trim();
                const userContent = content.substring(idx).trim();

                if (systemContent && userContent) {
                    body.messages = [
                        { role: 'system', content: systemContent },
                        { role: 'user', content: userContent },
                    ];

                    options = { ...options, body: JSON.stringify(body) };
                    console.log(`[${EXTENSION_NAME}] Split into system + user messages`);
                }
            }
        } catch {
            // Don't break the original request
        }
    }

    return originalFetch.call(this, url, options);
};

console.log(`[${EXTENSION_NAME}] Active`);
