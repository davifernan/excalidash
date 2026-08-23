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

`CI=true` enables two retries. A green check therefore means "passed at least
once out of up to three attempts", which is a different state from "passed on
the first attempt" — and without help the two are indistinguishable.

Retries are kept, but never silent. `playwright-retry-summary-reporter.cjs` runs
as an extra reporter and, whenever a test needed a retry, writes:

- a line per retried test on stdout,
- a `::warning` annotation when running under GitHub Actions,
- a table in the job summary when `GITHUB_STEP_SUMMARY` is set.

A run in which nothing was retried produces none of the three.

Why not the alternatives: dropping retries to `0` makes every infrastructure
hiccup red, and this job starts two real servers and shares one SQLite database,
so the queue would block on flake that is not a product defect. Exempting only
"guardian" tests needs an explicit list of which tests those are — a second
source of truth that drifts silently, and in this suite every test is a guardian.
Reporting keeps the check honest without either cost.

**Do not pass `--reporter` on the command line.** The CLI flag *replaces* the
reporter list from the config rather than extending it, which drops this reporter
without any visible sign. That is why `Dockerfile.playwright` runs a bare
`npx playwright test`.

`frontend/playwright.config.ts` also carries `retries: process.env.CI ? 2 : 0`,
but its `testDir` (`frontend/e2e`) does not exist, no workflow invokes it, and it
has never held a test in this fork's history. It produces no runs, so there is
nothing there to report; it is deliberately left untouched rather than decorated.

## File Structure

```
e2e/
├── tests/                    # Test files
│   └── image-persistence.spec.ts
├── fixtures/                 # Test data files
│   └── small-image.excalidraw
├── playwright.config.ts      # Playwright configuration
├── playwright-retry-summary-reporter.cjs  # Surfaces retries (see "Retries")
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
