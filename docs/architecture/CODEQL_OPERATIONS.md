# CodeQL observer operations

The `CodeQL Daily Observer` workflow analyzes every pull request targeting `main`, then observes
the integrated `main` branch again every day. A pull-request result attributes a newly introduced
alert to the change before merge; the daily run is a backstop for integrated code. It does not
prevent a vulnerable change from merging and is not a merge gate: the workflow is deliberately
absent from the repository's required status checks.

A green workflow run means that CodeQL completed and introduced no visible alert. It does not
mean that a person reviewed the result, and a red CodeQL result does not block merge. Existing
required security boundaries remain the preventive gates.

## Daily ownership

The **PR Overseer** owns the CodeQL alert inbox every day. On the same day as each scheduled run,
the Overseer checks **Security > Code scanning**, classifies every new alert, and records the
reason for any dismissal. A failed analysis run is also an inbox item: diagnose or rerun it that
day instead of treating the missing result as green.

For a real alert, keep it open and route the finding to the owner of the affected package. For a
non-actionable alert, dismiss that one alert with a location-specific explanation. **Never
exclude an entire query** to silence a finding: doing so would hide a later, genuine data flow of
the same class. Do not enable `security-extended` without a new measured decision; this observer
uses the JavaScript/TypeScript default suite.

## Initial baseline

NIL-618 measured CodeQL CLI 2.26.3 against 830 JavaScript/TypeScript files and 9 Actions files.
The cold run took about 64 seconds and peaked at 5.24 GB RSS. It found no confirmed
vulnerability and the following five non-actionable alerts. Each alert must be dismissed
individually in GitHub so its exact location and explanation remain auditable:

| Alert                                        | Location                                              | Individual dismissal reason                                                                                                                                                                             |
| -------------------------------------------- | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| GitHub #1, `js/incomplete-sanitization`      | `frontend/src/utils/displayFont.ts:5`                 | The value is `import.meta.env.VITE_EXCALIDASH_UI_FONT_FAMILY`, controlled only by the build environment. An actor who controls it already controls the application build; it is not runtime user input. |
| GitHub #2, `js/path-injection` (sink 1 of 4) | `backend/src/routes/importExport/streamingZip.ts:74`  | Multer's `req.file.filename` is accepted only when it matches `^[a-f0-9]{32}$`; the resolved candidate is then checked for containment below the real upload root before this filesystem sink.          |
| GitHub #3, `js/path-injection` (sink 2 of 4) | `backend/src/routes/importExport/streamingZip.ts:81`  | Same validated Multer filename and realpath-containment contract, recorded separately for this sink.                                                                                                    |
| GitHub #4, `js/path-injection` (sink 3 of 4) | `backend/src/routes/importExport/streamingZip.ts:203` | Same validated Multer filename and realpath-containment contract, recorded separately for this sink.                                                                                                    |
| GitHub #5, `js/path-injection` (sink 4 of 4) | `backend/src/routes/importExport/streamingZip.ts:231` | Same validated Multer filename and realpath-containment contract, recorded separately for this sink.                                                                                                    |

After those five individual dismissals, rerun the unchanged `main` SHA. The expected result is
that GitHub preserves the dismissals and does not create five new open alerts. A changed data
flow is a new finding and must be reviewed on its own merits.

## Measured activation evidence

The pull-request trigger is justified only while both of these measured properties hold:

1. A real pull-request analysis reports alerts introduced by that PR, not unchanged alerts that
   are already present on its `main` base.
2. After an individual baseline alert is dismissed with a reason, another analysis of the same
   unchanged `main` SHA keeps it dismissed instead of creating a fresh open alert.

NIL-623 records the concrete analysis IDs, PR/SHA, and before/after alert sets used for activation.
If either property stops holding, remove the `pull_request` trigger and retain the daily `main`
observer while investigating. The workflow contract test protects the remaining static boundary:
exactly these three triggers, pull requests targeting `main`, no query filters, and no CodeQL
context in `ops/repository-rules.sh`.

### Activation measurement, 2026-08-26

- Baseline analysis `1675407378` on `main` SHA `ef95be6bc9afc41dd1091e5278f5f8cc4f983cfd`
  created five open alerts, GitHub #1 through #5.
- With all five still open, the native CodeQL Action analyzed real draft PR #199 at merge SHA
  `fd360190d0a9488e8bcc559da3f1fda2dec5eb06`. Workflow run `32972407958` succeeded and PR
  analysis `1675458755` recorded zero results. The unchanged base alerts were therefore not
  presented as alerts introduced by that PR.
- Alerts #1 through #5 were then dismissed separately as false positives with the five reasons
  in the baseline table. Analysis `1675466163` uploaded the exact same SARIF again for the exact
  same `main` SHA. It still recorded five raw results—proving that neither query was disabled—but
  the open-alert set was empty and the dismissed set retained the same five alert numbers and
  reasons. No replacement alerts were created.

The raw-result count and open-alert count answer different questions. Raw results prove the
queries still ran; the alert state proves that GitHub remembered the individual decisions.
