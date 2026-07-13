# Contributing

Issues and focused pull requests are welcome.

## Principles

- Preserve the no-silent-downgrade quality contract.
- Use documented provider signals and public plugin surfaces.
- Do not add credential scraping, browser-cookie access, account rotation, or quota bypass behavior.
- Do not store prompts, transcripts, source code, or diffs.
- Treat every quota bucket as optional and provider-defined.
- Add tests for new provider payload shapes and policy changes.

## Local checks

```bash
npm install
npm run check
npm test
```

Provider integration tests should use a temporary `USAGE_GUARD_HOME` unless the test explicitly targets the user's local state.
