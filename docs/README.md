# Documentation

## Guides

- [Pipeline interface](pipeline-ui.md): the canvas, stage cards, Build & Deploy, the branch selector and the Git graph.
- [Business journeys](journeys.md): reviewed browser journeys, discovery, runs, the Playwright engine, live view and recordings.
- [Twins](twins.md): Compose application environments and their services, with provenance.
- [Journey gate](gate.md): rebuilding a twin for each pushed commit, running its journeys and reporting a GitHub commit status.
- [Provider connections](providers.md): GitHub, Vercel and Railway.
- [CLI](cli.md): commands, scripts and tests.
- [Desktop sandbox](desktop-sandbox.md): the optional, experimental Cua desktop for desktop applications.
- [Asset provenance](ASSETS.md): logos, fonts, registry components and their licenses.

## Architecture

- [Browser-first business testing](architecture/browser-first.md): why journeys run in a local browser against a URL.
- [Journey contract](architecture/journey-contract.md): the case, milestone, progress and verdict contract between runner and controller.
- [Twins and the journey gate](architecture/twins-and-gate.md): the design of Compose twins, twin services and the CI/CD gate.
- [Playwright journeys](architecture/playwright-journeys.md): running approved, generated Playwright specs instead of an agent.

## Project

- [Domain vocabulary](../CONTEXT.md): the terms used across the code and these documents.
- [Roadmap](../ROADMAP.md) and [changelog](../CHANGELOG.md).
- [Issue tracker](agents/issue-tracker.md), [triage labels](agents/triage-labels.md) and [domain docs](agents/domain.md) for contributors and coding agents.
