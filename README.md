# System Message Injector

Splits supported MemoryBooks prompts into system/user messages for custom chat
completion endpoints and keeps the existing bounded provider fallback sequence.
It works on its own and can use Runtime Signal Bus when present.

## Memory and diagnostics

Normal operation keeps compact request/configuration summaries. Full per-message
debug detail and raw response previews are disabled by default. The last successful
custom-endpoint configuration is kept separately, so clearing or expiring debug
history does not disable the working-configuration fallback.

For a temporary debugging session, use the browser console:

```js
SystemMessageInjector.setDiagnosticsEnabled(true);
SystemMessageInjector.getDiagnosticsInfo();
// Reproduce the request, then inspect:
SystemMessageInjector.getRequestEnvelopeHistory();
SystemMessageInjector.getRawResponseHistory();
// Disable detailed capture and clear its history:
SystemMessageInjector.setDiagnosticsEnabled(false);
```

Detailed capture includes at most the last 64 message previews (300 characters
each). Raw responses are read only up to a 50,000-byte prefix, with an explicit
truncation flag; the full parsed `body_json` is not retained. Request history is
limited to 50 entries and 256 KiB of estimated serialized UTF-16 content; raw
history is limited to 20 entries and 512 KiB. Both expire after 15 minutes, including
while idle. These are content budgets, not exact measurements of browser heap
overhead. Saved references in developer tools are outside these histories.

The normal-response error check reads at most 128 KiB. An oversized diagnostic
response does not become a new known-working configuration. The original response
remains readable by SillyTavern. Functional MemoryBooks stream-to-JSON conversion
still reads the generated result needed by MemoryBooks.

Fallback variants are generated only as each attempt is needed, with the existing
two-attempt limit and ordering. A successful first attempt does not build unused
chunked or merged prompt copies.

Runtime Signal Bus 1.1 shares one read-only request parse. Older buses and standalone
installs parse locally. A bus 1.0 already underneath another fetch wrapper uses the
standalone path to avoid that version's re-wrapping issue. No bus is required.

## Tests

```sh
node --test tests/*.test.mjs
```
