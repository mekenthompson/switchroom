# Switchroom skill bundle inventory

Source: the repo's `skills/*/SKILL.md` tree at HEAD. Read-only inventory feeding the probabilistic skill-coverage harness.

Skill count: **27** (matches `ls skills/`). Profile-overlay count: **7** (3 `_shared` fragments + 4 profile `CLAUDE.md.hbs`).

> **`buildkite-*` retention:** the eight `buildkite-*` skills below are
> inventoried as-shipped. Whether they stay in the bundle or get
> removed (switchroom's own Buildkite CI is retired) is an unresolved
> maintainer decision tracked in
> [#1384](https://github.com/switchroom/switchroom/issues/1384) — this
> inventory neither prescribes nor pre-empts that call.

## Summary table

| Skill name | Category | Flag count | One-line description |
|---|---|---|---|
| buildkite-agent-infrastructure | buildkite | 1 | Provision and govern Buildkite clusters, queues, hosted agents, secrets, tokens, SSO, audit, cost. |
| buildkite-agent-runtime | buildkite | 1 | `buildkite-agent` subcommands run inside a job step — annotate, artifact, meta-data, pipeline upload, OIDC, lock, env, secret, redactor, tool sign. |
| buildkite-api | buildkite | 1 | REST + GraphQL + webhooks for programmatic Buildkite automation. |
| buildkite-cli | buildkite | 1 | Terminal `bk` CLI — builds, jobs, pipelines, secrets, artifacts, clusters, packages. |
| buildkite-migration | buildkite | 1 | Convert pipelines from GitHub Actions / Jenkins / CircleCI / Bitbucket / GitLab to Buildkite YAML via `bk pipeline convert`. |
| buildkite-pipelines | buildkite | 1 | Author `.buildkite/pipeline.yml` — step types, caching, parallelism, retries, dynamic pipelines, matrix, plugins. |
| buildkite-secure-delivery | buildkite | 1 | OIDC, SLSA provenance, Package Registry publishing, JWKS pipeline signing. |
| buildkite-test-engine | buildkite | 1 | `bktec` test splitting, flaky-test detection, collectors, quarantine. |
| docx | document-format | 1 | Create, read, edit `.docx` Word documents (pandoc + docx-js). |
| file-bug | switchroom-internal | 1 | File a high-quality bug report against switchroom (or configured repo) via `gh issue create`. |
| humanizer | generic-meta | 1 | Remove signs of AI-generated writing from text. |
| humanizer-calibrate | humanizer/calibrate | 1 | Build a personal voice template for `humanizer` from the user's recent Telegram messages. |
| mcp-builder | mcp-builder | 1 | Guide for creating high-quality MCP servers (FastMCP / TS SDK). |
| pdf | document-format | 1 | Read, edit, merge, split, OCR, fill, encrypt `.pdf` files. |
| pptx | document-format | 1 | Create / read / edit `.pptx` slide decks. |
| skill-creator | generic-meta | 1 | Create, edit, optimize, and benchmark skills. |
| switchroom-architecture | switchroom-internal | 2 | Internal architecture of switchroom — cascade, profiles, lifecycle, plugin system. |
| switchroom-cli | switchroom-internal | 2 | `switchroom` CLI operations on existing agents — logs, update, restart, version, config inspection, scheduled tasks, plugin reference. |
| switchroom-health | switchroom-internal | 1 | Health-check / diagnostic sweep ("my agents are broken"). |
| switchroom-install | switchroom-internal | 1 | First-time bootstrap of switchroom + dependencies on a fresh machine. |
| switchroom-manage | switchroom-internal | 1 | Add / remove / reinstall / list agents (fleet-level). |
| switchroom-runtime | switchroom-internal | 2 | Conditional runtime protocols (interrupted-turn resume, wake audit, "why did you restart", `!` interrupt). |
| switchroom-status | switchroom-internal | 1 | `switchroom agent list` — running agents, uptime, model, state. |
| telegram-test-harness | telegram-test | 1 | Deterministic Bot-API mock harness for switchroom Telegram tests. |
| token-helpers | switchroom-internal | 2 | Library skill — refresh Google Calendar / MS Graph OAuth tokens from the vault. |
| webapp-testing | generic-meta | 1 | Playwright-based local webapp testing. |
| xlsx | document-format | 1 | Create / read / edit `.xlsx`, `.csv`, `.tsv` spreadsheets. |

Flag legend (`description_quality_flags`): `short` (<30 chars), `long` (>500 chars), `no-triggers` (no concrete trigger phrasings), `no-negatives` (no "do not use when" clause), `overlap:<other>` (overlapping trigger phrasings with another inventoried skill). The single-flag baseline below is "no-negatives" for skills that lack an explicit anti-trigger section — pervasive across the buildkite + Anthropic-bundled skills.

---

## buildkite-agent-infrastructure

```yaml
name: buildkite-agent-infrastructure
description_raw: |
  This skill should be used when the user asks to "create a cluster",
  "create a queue", "set up hosted agents", "configure agents",
  "right-size instance shapes", "scale queues", "manage cluster secrets",
  "create a pipeline template", "set up audit logging", "configure SSO",
  "set up SAML", "manage agent tokens", "optimize CI costs", or
  "standardize pipelines across teams".
  Also use when the user mentions buildkite-agent.cfg, agent tags, agent tokens,
  cluster queues, hosted agent instance shapes, pipeline templates, audit events,
  SSO/SAML providers, queue wait time, agent lifecycle hooks, or asks about
  Buildkite CI infrastructure provisioning, platform governance, or
  organization-level configuration.
trigger_phrases:
  - "create a cluster"
  - "create a queue"
  - "set up hosted agents"
  - "configure agents"
  - "right-size instance shapes"
  - "scale queues"
  - "manage cluster secrets"
  - "create a pipeline template"
  - "set up audit logging"
  - "configure SSO"
  - "set up SAML"
  - "manage agent tokens"
  - "optimize CI costs"
  - "standardize pipelines across teams"
  - mentions of buildkite-agent.cfg, agent tags, agent tokens, cluster queues,
    instance shapes, pipeline templates, audit events, SSO/SAML providers,
    queue wait time, agent lifecycle hooks
negative_signals: []
body_summary: |
  Walks the agent through provisioning Buildkite clusters via REST + GraphQL,
  creating queues with instance shapes, agent tokens, cluster secrets,
  lifecycle hooks, plugin allowlists, pipeline templates (Enterprise), audit
  logging, SSO/SAML, and queue cost optimization. Heavy cross-references to
  sister buildkite-* skills.
execution_surface:
  - curl against api.buildkite.com/v2 and graphql.buildkite.com/v1
  - clusterCreate / clusterQueueCreate / clusterQueuePauseDispatch GraphQL mutations
  - cluster + agent-token REST endpoints
  - references/{instance-shapes,graphql-mutations,self-hosted-agents,pipeline-templates,audit-logging,sso-saml}.md
category: buildkite
description_quality_flags: [no-negatives]
```

Concrete trigger list and "Also use when..." stem are unambiguous, but the skill has no "do NOT use when" clause — overlapping infra surface with `buildkite-cli` (cluster CLI commands) and `buildkite-pipelines` (pipeline templates) is only flagged via prose "see the X skill" footnotes. Harness should expect bleed between these four buildkite skills on phrasings like "manage agents" or "create a pipeline".

## buildkite-agent-runtime

```yaml
name: buildkite-agent-runtime
description_raw: |
  This skill should be used when the user asks to "add an annotation",
  "upload artifacts from a step", "share data between steps", "upload pipeline
  dynamically", "request an OIDC token inside a step", "acquire a distributed lock",
  "get or update a step attribute", "redact a secret from logs", "retrieve a cluster
  secret at runtime", or "debug environment variables in hooks".
  Also use when the user mentions buildkite-agent annotate, buildkite-agent artifact
  upload/download, buildkite-agent meta-data set/get, buildkite-agent pipeline upload,
  buildkite-agent oidc request-token, buildkite-agent step, buildkite-agent lock,
  buildkite-agent env, buildkite-agent secret get, buildkite-agent redactor add,
  buildkite-agent tool sign/verify, or any buildkite-agent subcommand used inside
  a running job step.
trigger_phrases:
  - "add an annotation"
  - "upload artifacts from a step"
  - "share data between steps"
  - "upload pipeline dynamically"
  - "request an OIDC token inside a step"
  - "acquire a distributed lock"
  - "get or update a step attribute"
  - "redact a secret from logs"
  - "retrieve a cluster secret at runtime"
  - "debug environment variables in hooks"
  - mentions of buildkite-agent annotate/artifact/meta-data/pipeline upload/oidc/step/lock/env/secret/redactor/tool subcommands
negative_signals: []
body_summary: |
  Reference for every `buildkite-agent` in-step subcommand: annotate, artifact,
  meta-data, pipeline upload, oidc request-token, step, lock, env, secret,
  redactor, tool sign/verify. Each section has flag tables, examples, and
  "common mistakes". Points at `buildkite-cli` for terminal-side `bk` and at
  `buildkite-agent-infrastructure` for cluster-side setup.
execution_surface:
  - in-step bash invocations of buildkite-agent <subcommand>
  - references/{flag-reference,patterns-and-recipes}.md
category: buildkite
description_quality_flags: [no-negatives]
```

Clean and concrete. Potential phrasing overlap with `buildkite-agent-infrastructure` on the word "manage agent tokens" / "secrets" — runtime is for *inside a step*, infrastructure is for *cluster-level provisioning*. Harness should keep that split as a labeled axis.

## buildkite-api

```yaml
name: buildkite-api
description_raw: |
  This skill should be used when the user asks to "call the Buildkite API",
  "use the REST API", "write a GraphQL query", "set up webhooks",
  "automate Buildkite", "integrate with Buildkite programmatically",
  "write a script that calls Buildkite", "handle webhook events",
  "paginate API results", or "authenticate with the Buildkite API".
  Also use when the user mentions api.buildkite.com, graphql.buildkite.com,
  Buildkite REST endpoints, GraphQL mutations, webhook payloads,
  API tokens, or asks about programmatic access to Buildkite data.
trigger_phrases:
  - "call the Buildkite API"
  - "use the REST API"
  - "write a GraphQL query"
  - "set up webhooks"
  - "automate Buildkite"
  - "integrate with Buildkite programmatically"
  - "write a script that calls Buildkite"
  - "handle webhook events"
  - "paginate API results"
  - "authenticate with the Buildkite API"
  - mentions of api.buildkite.com / graphql.buildkite.com / webhook payloads / API tokens
negative_signals: []
body_summary: |
  REST + GraphQL + webhooks reference: auth (Bearer + JWT), full endpoint
  table, pagination, build CRUD, error codes, REST-vs-GraphQL decision guide,
  webhook signatures. Cross-refs `buildkite-cli` (`bk api`), MCP-server tools,
  and the secure-delivery skill for token claims.
execution_surface:
  - curl + jq pipelines, Python jwt encoding
  - references/{graphql-reference,webhooks,patterns}.md
category: buildkite
description_quality_flags: [no-negatives]
```

Triggers overlap with `buildkite-cli` (`bk api`) and `buildkite-agent-infrastructure` (GraphQL mutations for clusters). The decision boundary is "writing a script vs. running a one-shot CLI" — make sure the harness corpus probes both phrasings.

## buildkite-cli

```yaml
name: buildkite-cli
description_raw: |
  This skill should be used when the user asks to "trigger a build",
  "check build status", "watch a build", "view build logs", "retry a build",
  "cancel a build", "list builds", "download artifacts", "upload artifacts",
  "manage secrets", "create a pipeline", "list pipelines", or
  "interact with Buildkite from the command line".
  Also use when the user mentions bk commands, bk build, bk job, bk pipeline,
  bk secret, bk artifact, bk cluster, bk package, bk auth, bk configure,
  bk use, bk init, bk api, or asks about Buildkite CLI installation,
  terminal-based Buildkite workflows, or command-line CI/CD operations.
trigger_phrases:
  - "trigger a build"
  - "check build status"
  - "watch a build"
  - "view build logs"
  - "retry a build" / "cancel a build" / "list builds"
  - "download artifacts" / "upload artifacts"
  - "manage secrets"
  - "create a pipeline" / "list pipelines"
  - "interact with Buildkite from the command line"
  - mentions of bk build/job/pipeline/secret/artifact/cluster/package/auth/configure/use/init/api
negative_signals: []
body_summary: |
  Reference for the `bk` CLI: install, `bk configure`/`bk auth login`, build
  create/view/list/watch/cancel/retry, job log/retry/cancel, pipeline
  list/create/update/convert, secret CRUD, artifact upload/download, cluster
  view, package push, `bk api`, and MCP-tool equivalents.
execution_surface:
  - bash bk subcommands, ~/.config/bk.yaml
  - references/command-reference.md
category: buildkite
description_quality_flags: [no-negatives]
```

Phrasing overlap with `buildkite-pipelines` ("create a pipeline" — CLI vs. YAML authoring) and `buildkite-api` (programmatic vs. interactive). Body has a clear "When to use CLI vs MCP" callout that the harness can score against.

## buildkite-migration

```yaml
name: buildkite-migration
description_raw: |
  This skill should be used when the user asks to "migrate to Buildkite",
  "convert pipelines from Jenkins", "convert GitHub Actions workflows",
  "convert CircleCI config", "convert Bitbucket Pipelines", "convert GitLab CI",
  "migrate CI/CD to Buildkite", "switch from Jenkins to Buildkite",
  "move from GitHub Actions", "plan a CI migration", "convert my CI config",
  "bk pipeline convert", or "what's the Buildkite equivalent of".
  Also use when the user mentions migration planning, CI conversion,
  pipeline conversion, converting workflows, or asks about translating
  CI/CD configuration from another provider to Buildkite.
trigger_phrases:
  - "migrate to Buildkite"
  - "convert pipelines from Jenkins / GitHub Actions / CircleCI / Bitbucket / GitLab"
  - "switch from Jenkins to Buildkite"
  - "plan a CI migration"
  - "convert my CI config"
  - "bk pipeline convert"
  - "what's the Buildkite equivalent of"
negative_signals: []
body_summary: |
  `bk pipeline convert` reference + agent workflow for translating CI configs
  from GitHub Actions / Jenkins / CircleCI / Bitbucket / GitLab / Harness /
  Bitrise to Buildkite YAML. No login required.
execution_surface:
  - bk pipeline convert -F / --vendor / --output / stdin
category: buildkite
description_quality_flags: [no-negatives]
```

Triggers are highly distinctive — minimal overlap with the other buildkite-* skills (only `buildkite-cli` mentions `bk pipeline convert` in passing).

## buildkite-pipelines

```yaml
name: buildkite-pipelines
description_raw: |
  This skill should be used when the user asks to "write a pipeline",
  "add caching", "make this build faster", "show test failures in the build page",
  "add annotations", "only run tests when code changes", "set up dynamic pipelines",
  "add retry", "parallel steps", "matrix build", "add plugins", or
  "work with artifacts in pipeline YAML".
  Also use when the user mentions .buildkite/ directory, pipeline.yml,
  buildkite-agent pipeline upload, step types (command, wait, block, trigger,
  group, input), if_changed, notify, concurrency, or asks about Buildkite CI
  configuration.
trigger_phrases:
  - "write a pipeline"
  - "add caching" / "make this build faster"
  - "show test failures in the build page" / "add annotations"
  - "only run tests when code changes"
  - "set up dynamic pipelines"
  - "add retry" / "parallel steps" / "matrix build" / "add plugins"
  - "work with artifacts in pipeline YAML"
  - mentions of .buildkite/, pipeline.yml, step types, if_changed, notify, concurrency
negative_signals: []
body_summary: |
  Pipeline-YAML reference: step types, caching, fast-fail, parallelism /
  dependencies, annotations, retry, dynamic pipelines, conditionals
  (`if_changed`), matrix builds, plugins, notifications, artifacts.
execution_surface:
  - .buildkite/pipeline.yml authoring
  - `buildkite-agent pipeline upload` invocations
category: buildkite
description_quality_flags: [no-negatives]
```

Trigger phrase "add annotations" overlaps `buildkite-agent-runtime` ("add an annotation"). The body cleanly distinguishes "declarative YAML key" vs "in-step subcommand" via cross-refs — flag for harness scoring.

## buildkite-secure-delivery

```yaml
name: buildkite-secure-delivery
description_raw: |
  This skill should be used when the user asks to "publish to package registry",
  "push a Docker image", "set up OIDC authentication", "request an OIDC token",
  "authenticate without static credentials", "set up SLSA provenance",
  "generate attestation", "sign pipelines", "verify pipeline signatures",
  or "secure the supply chain".
  Also use when the user mentions OIDC, SLSA, provenance, attestation, cosign,
  JWKS, pipeline signing, pipeline verification, packages.buildkite.com,
  Package Registry, artifact signing, or asks about credential-free publishing,
  supply chain security, or secure delivery in Buildkite.
trigger_phrases:
  - "publish to package registry" / "push a Docker image"
  - "set up OIDC authentication" / "request an OIDC token"
  - "authenticate without static credentials"
  - "set up SLSA provenance" / "generate attestation"
  - "sign pipelines" / "verify pipeline signatures"
  - "secure the supply chain"
  - mentions of OIDC / SLSA / provenance / attestation / cosign / JWKS / packages.buildkite.com
negative_signals: []
body_summary: |
  OIDC auth (Package Registry + cloud providers), SLSA provenance attestations,
  Package Registry ecosystems + Docker/OCI publishing, JWKS pipeline signing
  setup + rollout, end-to-end secure publish flow.
execution_surface:
  - YAML steps with OIDC plugin
  - cosign attest / verify
  - JWKS keypair generation + verifying-keys config
category: buildkite
description_quality_flags: [no-negatives]
```

"request an OIDC token" overlaps `buildkite-agent-runtime`. Secure-delivery is the strategy/setup skill; runtime is the in-step CLI. Distinct enough for the harness.

## buildkite-test-engine

```yaml
name: buildkite-test-engine
description_raw: |
  This skill should be used when the user asks to "split tests across machines",
  "set up test splitting", "parallelize test suite", "detect flaky tests",
  "quarantine flaky tests", "configure test collectors", "speed up tests",
  "set up bktec", "configure test engine", or "reduce flaky test failures".
  Also use when the user mentions bktec, Test Engine, test suites,
  BUILDKITE_TEST_ENGINE_* environment variables, BUILDKITE_ANALYTICS_TOKEN,
  test-collector plugin, test reliability scores, test timing data,
  or asks about Buildkite test splitting and flaky test management.
trigger_phrases:
  - "split tests across machines" / "set up test splitting" / "parallelize test suite"
  - "detect flaky tests" / "quarantine flaky tests" / "reduce flaky test failures"
  - "configure test collectors" / "speed up tests"
  - "set up bktec" / "configure test engine"
  - mentions of bktec / Test Engine / BUILDKITE_TEST_ENGINE_* / BUILDKITE_ANALYTICS_TOKEN / test-collector
negative_signals: []
body_summary: |
  Test Engine + bktec reference: suite creation, collectors, env vars,
  timing-based test splitting, flaky-test detection / quarantine, MCP tools.
execution_surface:
  - test-collector plugin YAML
  - bktec CLI invocations
  - BUILDKITE_TEST_ENGINE_* / BUILDKITE_ANALYTICS_TOKEN env wiring
category: buildkite
description_quality_flags: [no-negatives]
```

Highly distinctive triggers; minimal overlap.

## docx

```yaml
name: docx
description_raw: |
  Use this skill whenever the user wants to create, read, edit, or manipulate
  Word documents (.docx files). Triggers include: any mention of 'Word doc',
  'word document', '.docx', or requests to produce professional documents with
  formatting like tables of contents, headings, page numbers, or letterheads.
  Also use when extracting or reorganizing content from .docx files, inserting
  or replacing images in documents, performing find-and-replace in Word files,
  working with tracked changes or comments, or converting content into a
  polished Word document. If the user asks for a 'report', 'memo', 'letter',
  'template', or similar deliverable as a Word or .docx file, use this skill.
  Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks
  unrelated to document generation.
trigger_phrases:
  - "Word doc" / "word document" / ".docx"
  - "tables of contents" / "headings" / "page numbers" / "letterheads"
  - "tracked changes" / "comments"
  - "report" / "memo" / "letter" / "template" (as Word file)
negative_signals:
  - "Do NOT use for PDFs, spreadsheets, Google Docs, or general coding tasks unrelated to document generation"
body_summary: |
  Pandoc and docx-js workflows for reading, accepting tracked changes,
  creating new .docx (styles, lists, tables, images, page breaks, footnotes),
  converting to images. Heavy formatting + validation guidance.
execution_surface:
  - pandoc invocations
  - docx-js (Node)
  - python-docx for tracked changes / XML access
  - LibreOffice / unoconv for image conversion
category: document-format
description_quality_flags: []
```

Has explicit `negative_signals` block, which is rare in this inventory. Overlaps the words "report" / "template" with `xlsx` and `pptx` — but the file extension claim is unambiguous.

## file-bug

```yaml
name: file-bug
description_raw: |
  File a high-quality bug report against switchroom (or another configured
  repo). Pulls the right log files automatically, forces a root-cause section
  with citations, flags logging gaps when RCA can't be pinned, and files via
  `gh issue create`. Use when a user asks "file a bug", "open an issue", or
  describes a symptom that needs a real ticket.
trigger_phrases:
  - "file a bug"
  - "open an issue"
  - "raise a ticket" / "log this"
  - any symptom that "needs a real ticket"
negative_signals:
  - "Do not auto-file from a thin description"
  - "Do not invent log lines or paste paraphrased excerpts"
  - "Do not file when the user is in the middle of debugging"
body_summary: |
  Six-phase forced workflow: lock the symptom, pull logs, build a timeline,
  RCA, related issues, then `gh issue create`. Anti-stub philosophy — refuses
  thin tickets.
execution_surface:
  - `gh issue create`, `gh search`
  - journalctl / docker logs reads
  - log-file Grep + Read
category: switchroom-internal
description_quality_flags: []
```

Has explicit "Non-goals" / "Anti-patterns" sections — exemplar for the harness scorecard.

## humanizer-calibrate

```yaml
name: humanizer-calibrate
description_raw: |
  Build a personal voice template for the humanizer skill from the user's
  recent Telegram messages. Reads the local message buffer, summarises
  vocabulary / sentence shape / formatting habits, writes a markdown template
  the humanizer will match against.
trigger_phrases:
  - "/humanizer-calibrate" (slash invocation)
  - "make humanizer sound more like me"
  - "fresh voice template"
negative_signals: []
body_summary: |
  Pulls recent Telegram messages via MCP, distils sentence shape / register /
  habits / signature phrases / counter-patterns into a markdown voice template
  written to skills/humanizer/voice-template.md.
execution_surface:
  - mcp__switchroom-telegram__get_recent_messages
  - mcp__hindsight__recall
  - Read / Write / Edit
category: humanizer/calibrate
description_quality_flags: [no-triggers]
```

The description hints at the slash-command but doesn't enumerate plain-English phrasings — flag for harness scoring (likely under-triggers on natural utterances).

## humanizer

```yaml
name: humanizer
description_raw: |
  Remove signs of AI-generated writing from text. Use when editing or
  reviewing text to make it sound more natural and human-written. Based on
  Wikipedia's comprehensive "Signs of AI writing" guide. Detects and fixes
  patterns including: inflated symbolism, promotional language, superficial
  -ing analyses, vague attributions, em dash overuse, rule of three, AI
  vocabulary words, passive voice, negative parallelisms, and filler phrases.
trigger_phrases:
  - "remove signs of AI writing"
  - "make this sound more human"
  - "edit / review text"
  - mentions of em-dash overuse / passive voice / AI vocabulary
negative_signals: []
body_summary: |
  Long anti-pattern catalog from Wikipedia's "Signs of AI writing". Workflow:
  identify patterns, rewrite, preserve meaning, match tone. Optional voice-
  calibration step.
execution_surface:
  - Read / Edit / Write / Grep / Glob
  - AskUserQuestion for voice sample
category: generic-meta
description_quality_flags: [no-negatives]
```

Triggers are intent-shaped ("make this sound human"), reliable. Calibration handoff is implicit.

## mcp-builder

```yaml
name: mcp-builder
description_raw: |
  Guide for creating high-quality MCP (Model Context Protocol) servers that
  enable LLMs to interact with external services through well-designed tools.
  Use when building MCP servers to integrate external APIs or services,
  whether in Python (FastMCP) or Node/TypeScript (MCP SDK).
trigger_phrases:
  - "build an MCP server"
  - "integrate external API as MCP"
  - "FastMCP" / "MCP SDK"
negative_signals: []
body_summary: |
  Four-phase workflow (research → implementation → review → evaluations).
  Heavy reliance on bundled reference docs loaded per phase.
execution_surface:
  - Python (FastMCP) or Node/TS (MCP SDK) scaffolding
  - bundled SDK + evaluation reference files
category: mcp-builder
description_quality_flags: [no-negatives]
```

Description is concrete enough but body-heavy; would benefit from explicit "do NOT use for client-side MCP wiring or skill authoring (see skill-creator)".

## pdf

```yaml
name: pdf
description_raw: |
  Use this skill whenever the user wants to do anything with PDF files. This
  includes reading or extracting text/tables from PDFs, combining or merging
  multiple PDFs into one, splitting PDFs apart, rotating pages, adding
  watermarks, creating new PDFs, filling PDF forms, encrypting/decrypting
  PDFs, extracting images, and OCR on scanned PDFs to make them searchable.
  If the user mentions a .pdf file or asks to produce one, use this skill.
trigger_phrases:
  - any operation on .pdf
  - "extract text from PDF" / "extract tables from PDF"
  - "merge PDFs" / "split PDF" / "rotate pages"
  - "watermark" / "fill PDF form" / "encrypt PDF" / "OCR a scanned PDF"
negative_signals: []
body_summary: |
  Python (pypdf, pdfplumber, reportlab) and CLI (pdftotext) workflows for
  reading, splitting, merging, generating PDFs, with form-fill instructions
  in FORMS.md.
execution_surface:
  - python: pypdf / pdfplumber / reportlab
  - poppler-utils (pdftotext)
  - REFERENCE.md / FORMS.md
category: document-format
description_quality_flags: [no-negatives]
```

Extension-keyed and high-precision.

## pptx

```yaml
name: pptx
description_raw: |
  Use this skill any time a .pptx file is involved in any way — as input,
  output, or both. This includes: creating slide decks, pitch decks, or
  presentations; reading, parsing, or extracting text from any .pptx file
  (even if the extracted content will be used elsewhere, like in an email or
  summary); editing, modifying, or updating existing presentations; combining
  or splitting slide files; working with templates, layouts, speaker notes,
  or comments. Trigger whenever the user mentions "deck," "slides,"
  "presentation," or references a .pptx filename, regardless of what they
  plan to do with the content afterward. If a .pptx file needs to be opened,
  created, or touched, use this skill.
trigger_phrases:
  - "deck" / "slides" / "presentation" / ".pptx"
  - "pitch deck"
  - "speaker notes" / "comments" / "templates" / "layouts"
  - "combine / split slide files"
negative_signals: []
body_summary: |
  markitdown for reading, editing.md + pptxgenjs.md for editing/creating,
  design guidance (palette, typography, spacing), required QA loop.
execution_surface:
  - python-pptx / markitdown
  - pptxgenjs (Node)
  - LibreOffice for image conversion
category: document-format
description_quality_flags: [no-negatives]
```

## skill-creator

```yaml
name: skill-creator
description_raw: |
  Create new skills, modify and improve existing skills, and measure skill
  performance. Use when users want to create a skill from scratch, edit, or
  optimize an existing skill, run evals to test a skill, benchmark skill
  performance with variance analysis, or optimize a skill's description for
  better triggering accuracy.
trigger_phrases:
  - "create a skill"
  - "edit / optimize a skill"
  - "run evals to test a skill"
  - "benchmark skill performance"
  - "optimize a skill's description"
negative_signals: []
body_summary: |
  Capture intent → interview → write SKILL.md → test cases → spawn
  with-skill + baseline runs → grade + aggregate. Skill-writing-guide
  callouts.
execution_surface:
  - file scaffolding under skills/<name>/
  - parallel claude-cli runs for eval
  - viewer launch
category: generic-meta
description_quality_flags: [no-negatives]
```

Highly relevant to this very coverage-harness task — the harness scorer should treat skill-creator as the meta-tool, not a candidate to fire on user prompts.

## switchroom-architecture

```yaml
name: switchroom-architecture
description_raw: |
  Explains how switchroom works internally — config cascade, profiles,
  settings resolution, agent lifecycle, plugin system. Use when the user
  asks 'how does switchroom work internally', 'how does the cascade decide',
  'which settings apply', architecture, design, or internals. Do NOT use for
  onboarding or getting-started questions ('how do I get started', 'I'm new
  to switchroom', 'bootstrap from scratch', 'set up for the first time') —
  those belong to switchroom-install.
trigger_phrases:
  - "how does switchroom work internally"
  - "how does the cascade decide" / "which settings apply"
  - "architecture" / "design" / "internals"
negative_signals:
  - Do NOT use for onboarding / getting-started — defer to switchroom-install
body_summary: |
  Conceptual overview: cascade, profile system, Docker-per-agent, Telegram
  MCP plugin, Hindsight, skills, scaffolds. Heavy cross-link to deep dives.
execution_surface:
  - read-only / explainer (no Bash)
category: switchroom-internal
description_quality_flags: [no-triggers, overlap:switchroom-install]
```

`user-invocable: false` in frontmatter — not directly trigger-fireable. Marked with two flags because: (a) most trigger phrasings are conceptual single words ("architecture") rather than NL utterances, (b) explicit overlap-disambiguation against `switchroom-install`.

## switchroom-cli

```yaml
name: switchroom-cli
description_raw: |
  Run switchroom CLI operations on existing agents: logs, update, restart,
  version, config inspection, scheduled tasks, and Telegram plugin reference.
  Use when the user wants to: show logs ("logs", "what happened", "check the
  journal", "why did it crash"); update agents ("update", "pull latest",
  "get new code", "upgrade"); restart agents ("restart", "reboot", "bounce",
  "kick", "it's stuck"); check what's running ("version", "what sha", "are
  agents up", "health summary"); apply config changes ("apply", "sync my
  config", "I just edited switchroom.yaml"); inspect an agent's effective
  config ("what model is X using", "how is <agent> configured", "show the
  cascade"); list scheduled tasks ("cron", "timers", "what runs automatically",
  "scheduled tasks"); or ask about Telegram-plugin features ("what MCP tools
  does the bot have", "how does reply work"). Do NOT use for adding/removing
  agents (switchroom-manage), bootstrapping switchroom from scratch
  (switchroom-install), or "something is broken" diagnostics (switchroom-health).
trigger_phrases:
  - "logs" / "what happened" / "check the journal" / "why did it crash"
  - "update" / "pull latest" / "get new code" / "upgrade"
  - "restart" / "reboot" / "bounce" / "kick" / "it's stuck"
  - "version" / "what sha" / "are agents up" / "health summary"
  - "apply" / "sync my config" / "I just edited switchroom.yaml"
  - "what model is X using" / "how is <agent> configured" / "show the cascade"
  - "cron" / "timers" / "what runs automatically" / "scheduled tasks"
  - "what MCP tools does the bot have" / "how does reply work"
negative_signals:
  - Do NOT use for add/remove agents → switchroom-manage
  - Do NOT use for bootstrapping → switchroom-install
  - Do NOT use for "something is broken" → switchroom-health
body_summary: |
  Reference for runtime CLI verbs against existing agents — `switchroom update`,
  `apply`, `restart`, `version`, `agent config`, `agent schedule list`, plus
  Telegram-plugin MCP-tool reference table.
execution_surface:
  - Bash(switchroom *) / Bash(docker *) / Bash(docker compose *)
category: switchroom-internal
description_quality_flags: [long, overlap:switchroom-health,switchroom-manage,switchroom-install]
```

Description is >500 chars — flagged `long`. But it earns its length with explicit negative-signal disambiguation against the three sibling skills. Highest disambiguation hygiene in the inventory.

## switchroom-health

```yaml
name: switchroom-health
description_raw: |
  Runs a health check and diagnostics on the switchroom setup. Use when the
  user says 'my agent keeps failing', 'my agents are broken', "what's wrong
  with my agents", 'agent keeps crashing', 'health check', 'diagnose',
  'troubleshoot', "something's wrong", 'can you check my setup', or wants
  to verify everything is working correctly. Prefer this over logs when the
  user is reporting a generic failure and wants to know *what* is wrong, not
  *why* a specific crash happened.
trigger_phrases:
  - "my agent keeps failing" / "my agents are broken"
  - "what's wrong with my agents" / "agent keeps crashing"
  - "health check" / "diagnose" / "troubleshoot"
  - "something's wrong" / "can you check my setup"
negative_signals:
  - "Prefer this over logs ... but defer to switchroom-cli (logs) when the user wants a specific crash"
body_summary: |
  Four-step diagnostic: `switchroom doctor --json`, fallback manual checks
  (CLI version, auth, compose health, MCP config, bot tokens, Hindsight
  reachability), interpret, suggest fixes.
execution_surface:
  - Bash: switchroom doctor / docker compose ps / Hindsight probe
category: switchroom-internal
description_quality_flags: [overlap:switchroom-cli]
```

## switchroom-install

```yaml
name: switchroom-install
description_raw: |
  Install switchroom and its dependencies (docker, claude CLI, switchroom
  binary) on a fresh machine. Use for onboarding and first-time setup — when
  the user says 'install switchroom on this machine', 'set up switchroom for
  the first time', 'bootstrap switchroom from scratch', 'get switchroom
  running', 'how do I get started with switchroom', "I'm new to switchroom,
  where do I begin", or asks about switchroom dependencies or prerequisites.
  This is the onboarding entry point, not for managing existing agents.
trigger_phrases:
  - "install switchroom on this machine"
  - "set up switchroom for the first time"
  - "bootstrap switchroom from scratch"
  - "get switchroom running"
  - "how do I get started with switchroom"
  - "I'm new to switchroom, where do I begin"
negative_signals:
  - "not for managing existing agents" (defer to switchroom-manage)
body_summary: |
  Six-step bootstrap: detect existing install, verify prereqs, install host
  deps (docker + claude CLI), install switchroom binary, run setup wizard,
  apply + bring up fleet, verify.
execution_surface:
  - Bash: apt / brew, docker install, claude install, switchroom setup,
    switchroom apply
category: switchroom-internal
description_quality_flags: [overlap:switchroom-manage]
```

## switchroom-manage

```yaml
name: switchroom-manage
description_raw: |
  Manage the fleet of switchroom agents from a Claude Code session — add,
  create, remove, reinstall, reprovision, or lifecycle-control agents. Use
  when the user says 'add a new agent', 'add an agent to my setup', 'create
  a new agent', 'remove an agent', 'reinstall my agents', 'reprovision my
  agents', 'list my agents', 'manage my agents', or invokes `/switchroom`.
  This is the right skill for fleet-level changes (adding/removing agents)
  even when the phrasing includes 'install' or 'reinstall' — use
  switchroom-install only for bootstrapping switchroom itself on a fresh
  machine.
trigger_phrases:
  - "add a new agent" / "create a new agent"
  - "remove an agent"
  - "reinstall my agents" / "reprovision my agents"
  - "list my agents" / "manage my agents"
  - "/switchroom" slash invocation
negative_signals:
  - "use switchroom-install only for bootstrapping switchroom itself"
body_summary: |
  Table of slash-style verbs mapped to `switchroom agent <verb>` Bash
  invocations: list, create, remove, reinstall, plus Anthropic-account
  helpers.
execution_surface:
  - Bash: switchroom agent list / create / remove / reinstall
category: switchroom-internal
description_quality_flags: [overlap:switchroom-install]
```

## switchroom-runtime

```yaml
name: switchroom-runtime
description_raw: |
  Runtime operational protocols for switchroom Telegram agents — the
  conditional procedures that only fire on specific boot signals or user
  phrases. Invoke when: (1) the env var SWITCHROOM_PENDING_TURN=true is set
  on boot (interrupted-turn resume protocol); (2) the sentinel file
  $TELEGRAM_STATE_DIR/.wake-audit-pending exists (wake audit: check for owed
  replies, orphan sub-agents, stale todos before answering); (3) the user
  asks why you restarted or what happened ("why did you restart?", "did you
  crash?", "you went away") — surface the audit trail from
  clean-shutdown.json + container/journal logs; (4) the user asks how to
  stop you mid-turn ("how do I interrupt", "can I stop you", "how do I
  cancel") and you need the implementation detail beyond the one-line
  answer; (5) the user sends a short status check ("status?", "still
  there?", "any update?") — treat as UX-failure signal, offer to file RCA
  via /file-bug. Do NOT invoke for normal Telegram conversation, formatting
  questions, voice/sticker/Telegraph behavior, MCP tool questions, or
  persona / voice / Execution-Bias rules — those live in your always-loaded
  CLAUDE.md.
trigger_phrases:
  - boot signal: SWITCHROOM_PENDING_TURN=true
  - sentinel file: .wake-audit-pending exists
  - "why did you restart?" / "did you crash?" / "you went away"
  - "how do I interrupt" / "can I stop you" / "how do I cancel"
  - "status?" / "still there?" / "any update?"
negative_signals:
  - Do NOT invoke for normal Telegram conversation, formatting, voice/sticker,
    MCP tool questions, persona / Execution-Bias rules
body_summary: |
  Five gated protocols: interrupted-turn resume, wake audit, "why did you
  restart" audit trail, `!` interrupt implementation, "status?" UX-failure
  handler. Plus bash-shell-wedge escape hatch.
execution_surface:
  - Bash / Read / Grep
  - reads of clean-shutdown.json, .wake-audit-pending, journal/container logs
category: switchroom-internal
description_quality_flags: [long, overlap:file-bug]
```

>500 chars (`long`). Cleanly gates by side-channel signals (env var, sentinel file) rather than just NL phrasings — distinctive for harness scoring (some triggers can't be evaluated from NL alone).

## switchroom-status

```yaml
name: switchroom-status
description_raw: |
  List running switchroom agents with their uptime, model, and per-agent
  state. Use when the user asks 'what agents are running', 'list switchroom
  agents', 'how long has X been up', or wants a per-agent snapshot. Do NOT
  use for switchroom-wide version/health summary (use switchroom-cli's
  `switchroom version`) or "something is broken" diagnostics (use
  switchroom-health).
trigger_phrases:
  - "what agents are running"
  - "list switchroom agents"
  - "how long has X been up"
  - "per-agent snapshot"
negative_signals:
  - Do NOT use for version/health summary → switchroom-cli
  - Do NOT use for "something is broken" → switchroom-health
body_summary: |
  Mandates literal `switchroom agent list` in the response and (when Bash
  available) runs it; reports per-agent state + uptime + suspicious markers.
execution_surface:
  - Bash: switchroom agent list
category: switchroom-internal
description_quality_flags: [overlap:switchroom-cli,switchroom-manage]
```

## telegram-test-harness

```yaml
name: telegram-test-harness
description_raw: |
  This skill should be used when the user asks to "test telegram", "test bot
  interactions", "mock the bot api", "write a telegram test", "test what
  users see in chat", "test progress card", "test the slot banner", "test
  soft-confirm", "test auto-fallback notification", "test pin behavior", or
  any variation on validating switchroom's Telegram-side output
  deterministically.
  Also use when the user mentions fake-bot-api, update-factory,
  bot-api.harness, GrammyError, e2e telegram, telegram regression test, or
  asks how to add a test for code that calls bot.api.* or handles incoming
  Telegram updates.
trigger_phrases:
  - "test telegram" / "test bot interactions" / "mock the bot api"
  - "write a telegram test" / "test what users see in chat"
  - "test progress card" / "test the slot banner" / "test soft-confirm"
  - "test auto-fallback notification" / "test pin behavior"
  - "telegram regression test"
  - mentions of fake-bot-api / update-factory / bot-api.harness / GrammyError
negative_signals: []
body_summary: |
  Quick-reference for `telegram-plugin/tests/` harness — fake-bot-api +
  update-factory + error factories + time control. Defers to HARNESS.md for
  full guide.
execution_surface:
  - Bun tests under telegram-plugin/tests/
  - createFakeBotApi / update-factory / errors
category: telegram-test
description_quality_flags: [no-negatives]
```

## token-helpers

```yaml
name: token-helpers
description_raw: |
  Refresh OAuth access tokens for Google Calendar and Microsoft Graph from
  refresh tokens stored in the switchroom vault. Library skill — invoked by
  other skills that need a short-lived access token to call calendar or
  Graph APIs, not directly by the user.
trigger_phrases: []
negative_signals:
  - "not directly by the user" (library skill — invoked by other skills)
body_summary: |
  Two shell scripts (`scripts/google-cal-token.sh`,
  `scripts/ms-graph-token.sh`) that exchange a vault-stored refresh token
  for a short-lived access token and persist it back.
execution_surface:
  - Bash(switchroom vault *)
  - Bash(./scripts/google-cal-token.sh / ms-graph-token.sh)
category: switchroom-internal
description_quality_flags: [no-triggers, library-skill]
```

Library skill — explicitly never user-fired. Harness must label this as a non-target so NL prompts don't get scored against it.

## webapp-testing

```yaml
name: webapp-testing
description_raw: |
  Toolkit for interacting with and testing local web applications using
  Playwright. Supports verifying frontend functionality, debugging UI
  behavior, capturing browser screenshots, and viewing browser logs.
trigger_phrases:
  - "test local web app" / "test web app"
  - "frontend testing" / "debug UI behavior"
  - "capture browser screenshot" / "view browser logs"
  - "Playwright"
negative_signals: []
body_summary: |
  Decision-tree for static-vs-dynamic, with_server.py harness,
  recon-then-action pattern, native Python Playwright scripts.
execution_surface:
  - scripts/with_server.py
  - native Python Playwright
category: generic-meta
description_quality_flags: [short, no-triggers, no-negatives]
```

Description is only ~250 chars but trigger phrasings are loose; flagged for likely under-triggering.

## xlsx

```yaml
name: xlsx
description_raw: |
  Use this skill any time a spreadsheet file is the primary input or output.
  This means any task where the user wants to: open, read, edit, or fix an
  existing .xlsx, .xlsm, .csv, or .tsv file (e.g., adding columns, computing
  formulas, formatting, charting, cleaning messy data); create a new
  spreadsheet from scratch or from other data sources; or convert between
  tabular file formats. Trigger especially when the user references a
  spreadsheet file by name or path — even casually (like "the xlsx in my
  downloads") — and wants something done to it or produced from it. Also
  trigger for cleaning or restructuring messy tabular data files (malformed
  rows, misplaced headers, junk data) into proper spreadsheets. The
  deliverable must be a spreadsheet file. Do NOT trigger when the primary
  deliverable is a Word document, HTML report, standalone Python script,
  database pipeline, or Google Sheets API integration, even if tabular data
  is involved.
trigger_phrases:
  - any operation on .xlsx / .xlsm / .csv / .tsv
  - "spreadsheet" / "the xlsx in my downloads"
  - "add columns" / "compute formulas" / "formatting" / "charting"
  - "clean messy data" / "malformed rows" / "misplaced headers"
negative_signals:
  - "Do NOT trigger when the primary deliverable is a Word document, HTML
    report, standalone Python script, database pipeline, or Google Sheets
    API integration"
body_summary: |
  Output requirements (zero formula errors, professional font, template
  preservation), financial-model color/format/formula standards, pandas +
  openpyxl workflows, formula-not-hardcoded discipline.
execution_surface:
  - pandas / openpyxl / xlsxwriter
  - Excel + CSV / TSV I/O
category: document-format
description_quality_flags: []
```

Exemplar disambiguation — explicit ban on Word / HTML / Python-script deliverables. Bundled Anthropic skills (docx/xlsx) consistently have stronger negative signals than the buildkite or switchroom-internal sets.

---

## Profile context overlays

Not skills — these are Handlebars system-prompt fragments rendered into every agent's `CLAUDE.md` at scaffold time. They define *always-loaded* behavior, so the harness should treat them as the agent's baseline persona / protocol context, not as fire-able skills.

| File | Purpose |
|---|---|
| `~/code/switchroom-skill-coverage/profiles/_shared/agent-self-service.md.hbs` | Tells the agent it has an `agent-config` MCP and should proactively use it for cron/config edits instead of asking the user to hand-edit `switchroom.yaml`. |
| `~/code/switchroom-skill-coverage/profiles/_shared/telegram-style.md.hbs` | Telegram interaction style — soft-commit pacing, `reply` / `stream_reply` discipline, "every turn must end with a reply" contract. |
| `~/code/switchroom-skill-coverage/profiles/_shared/vault-protocol.md.hbs` | Vault interaction protocol — managed section autoreconciled by `switchroom apply`; hand-edits warned-against. |
| `~/code/switchroom-skill-coverage/profiles/coding/CLAUDE.md.hbs` | Profile context for a coding-agent persona — header + channel/topic block + SOUL.md cross-reference. |
| `~/code/switchroom-skill-coverage/profiles/default/CLAUDE.md.hbs` | Profile context for the generic default persona — same shape as coding/EA/health-coach, just no role suffix. |
| `~/code/switchroom-skill-coverage/profiles/executive-assistant/CLAUDE.md.hbs` | Profile context for the executive-assistant persona — header + channel block + SOUL.md cross-reference. |
| `~/code/switchroom-skill-coverage/profiles/health-coach/CLAUDE.md.hbs` | Profile context for the health-and-fitness-coach persona — header + channel block + SOUL.md cross-reference. |
