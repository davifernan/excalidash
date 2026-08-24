# ExcaliDash E2E Tests

Browser-based end-to-end tests for ExcaliDash using Playwright.

## Prerequisites

- Node.js 18+
- npm
- Docker (optional, for containerized testing)

## Quick Start

### Local Testing

```bash
# Install dependencies
npm install
npx playwright install chromium

# Run tests (will start servers automatically)
npm test

# Run tests with visible browser
npm run test:headed

# Run tests in debug mode
npm run test:debug
```

### With Existing Servers

If you already have the backend and frontend running:

```bash
# Backend at http://localhost:8000
# Frontend at http://localhost:5173
NO_SERVER=true npm test
```

### Docker Testing

Run tests in an isolated Docker environment:

```bash
npm run docker:test

# Or using docker-compose directly
docker-compose -f docker-compose.e2e.yml up --build --abort-on-container-exit
```

## Test Suites

### Image Persistence (Issue #17 Regression)

Tests for the bug where images wouldn't load fully when reopening files.

- **should preserve large image data through save/reload cycle** - Core regression test
- **should display drawing in editor view** - Browser UI test
- **should import .excalidraw file with embedded image** - File import test
- **should handle multiple images of varying sizes** - Multi-image test

### Security Tests

Tests for malicious content blocking:

- **should block javascript: URLs in image data** - XSS prevention
- **should block script tags in image data** - Script injection prevention

## Configuration

Environment variables:

| Variable | Default | Description |
|----------|---------|-------------|
| `BASE_URL` | `http://localhost:5173` | Frontend URL |
| `API_URL` | `http://localhost:8000` | Backend API URL |
| `HEADED` | `false` | Run with visible browser |
| `NO_SERVER` | `false` | Skip starting servers |
| `CI` | `false` | CI mode (headless, retries) |

## Retries

Retries are `0` (NIL-491). Measured over four red rounds of E2E runs on
2026-08-23 (PR #54): zero retries recovered a test, twenty retried tests
failed again, every one deterministically -- five real gaps in the test
surface and one real regression, not infrastructure flake. A green run costs
about 5.5 minutes; a red one used to cost about 20, almost all of it retrying
failures that were never going to pass.

`maxFailures: 5` also comes from NIL-491: a genuinely broken run (a bad
deploy, a hung server) stops after five failures instead of grinding through
all thirty specs at one worker each, while still showing enough of a pattern
to diagnose from. A green run is unaffected either way.

Because retries never fire anymore, `playwright-retry-summary-reporter.cjs`
and `failOnFlakyTests` (the option NIL-422 was set up to evaluate) lost their
reason to exist at the same time: the whole point of either was giving a
*silent* retry a consequence, and with `retries: 0` there is no silent retry
left to have a consequence -- a test either passes on its only attempt or the
run is red, full stop. The reporter was removed rather than kept for a
hypothetical future use (NIL-422's own acceptance criterion for not setting
`failOnFlakyTests`: name the consequence that applies instead, and who owns
it -- this paragraph is that).

If real, non-deterministic infrastructure flake shows up in practice, the
next step is **one** retry with a visible report, not back to two, and not
`failOnFlakyTests` layered on top of retries -- that would only reintroduce
the 2-3x runtime cost this change removed while producing the same red
outcome `retries: 0` already gives it. Whoever notices repeat infra flake
owns raising that as its own measured ticket, the way NIL-491 did.

`trace` and `video` moved from `on-first-retry` to `retain-on-failure` in the
same change (NIL-488): `on-first-retry` only ever produces anything on a
*second* attempt, which no longer happens with `retries: 0` -- so unchanged,
it would have silently stopped capturing anything for every red test.
**Do not pass `--reporter` on the command line.** The CLI flag *replaces* the
reporter list from the config rather than extending it, which would silently
drop the html report and the diagnostics NIL-488 depends on. That is why
`Dockerfile.playwright` runs a bare `npx playwright test`.

`retain-on-failure` keeps the trace/video for a test that fails on its one
attempt and discards it for one that passes.

`frontend/playwright.config.ts` (NIL-418) is gone rather than decorated: its
`testDir` (`frontend/e2e`) never existed in this fork's history, and nothing
called it -- see `git log` on this repository before this change for the
prior note that left it untouched pending this decision.

## File Structure

```
e2e/
├── tests/                    # Test files
│   └── image-persistence.spec.ts
├── fixtures/                 # Test data files
│   └── small-image.excalidraw
├── playwright.config.ts      # Playwright configuration
├── docker-compose.e2e.yml    # Docker setup
├── Dockerfile.playwright     # Playwright container
├── run-e2e.sh               # Convenience script
└── README.md                # This file
```

## Writing Tests

```typescript
import { test, expect } from "@playwright/test";

test("my test", async ({ page, request }) => {
  await page.goto("/");
  await expect(page.locator("h1")).toBeVisible();
  
  const response = await request.get("http://localhost:8000/drawings");
  expect(response.ok()).toBe(true);
});
```

## Debugging

```bash
# Run with Playwright UI
npm run test:ui

# Run specific test
npx playwright test -g "should preserve large image"

# Show last test report
npm run report
```

## CI Integration

The tests are integrated into GitHub Actions. See `.github/workflows/test.yml`.

For CI environments, tests run in headless mode with:
- Automatic retries on failure
- Screenshot/video on failure
- HTML report generation
