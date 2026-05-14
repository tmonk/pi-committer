# pi-committer

Conventional commit automation for the pi coding agent.

The extension lives at `extensions/pi-committer/`. See [its README](extensions/pi-committer/README.md) for full documentation.

```
extensions/
  pi-committer/
    index.ts         — extension entry point
    config.ts        — configuration loading and types
    package.json     — npm dependencies and pi manifest
    README.md        — full documentation
tests/
  e2e-test.sh        — end-to-end test suite
```

## Quick start

```bash
cd extensions/pi-committer
npm install
pi -e ./index.ts
```
