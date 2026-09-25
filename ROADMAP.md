# Roadmap

Near-term work, roughly in order. Nothing here is implemented yet; see the [changelog](CHANGELOG.md) for what is.

## Journeys and the gate

- **Code repair.** When an action of a journey's approved code fails, let Playwright's healer propose a patch that stays `needs_review`, with its diff and recording, until a person verifies and approves it. See [Playwright journeys](docs/architecture/playwright-journeys.md).
- **Stronger checks.** Add API and database observations as supporting evidence for a journey's outcome, beside today's page text and URL checks.

## Twins

- **Provenance with results.** Record each twin service's provenance (actual, official sandbox or emulate) with every run's results, not only on the environment.
- **More services.** Add service files for vendors with official test modes as repositories need them, such as Twilio, Clerk, Okta, Auth0, Resend and Slack.
- **Reproducible images.** Pin twin service and app images by digest rather than by tag.

## Providers

- Validate the Vercel and Railway adapters against live accounts, and verify provider previews for the commit a gate tested.

## Project

- A small public sample application under `examples/` to try discovery, a twin, journeys and the gate end to end.
