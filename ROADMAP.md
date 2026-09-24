# Roadmap

Near-term work, roughly in order. Nothing here is implemented yet; see the [changelog](CHANGELOG.md) for what is.

## Journeys and the gate

- **Playwright specs in the gate.** Run approved, generated Playwright specs as the journey gate's engine, so a gate run needs no model and gives the same verdict for the same commit. Browser Use stays for discovery. See [Playwright journeys](docs/architecture/playwright-journeys.md).
- **Spec repair.** When a spec's action fails, let Playwright's healer propose a patch that stays `needs_review`, with its diff and recording, until a person accepts it.
- **Stronger checks.** Add API and database observations as supporting evidence for a journey's outcome, beside today's page text and URL checks.

## Twins

- **Provenance with results.** Record each twin service's provenance (actual, official sandbox or emulate) with every run's results, not only on the environment.
- **More services.** Add service files for vendors with official test modes as repositories need them, such as Twilio, Clerk, Okta, Auth0, Resend and Slack.
- **Reproducible images.** Pin twin service and app images by digest rather than by tag.

## Providers

- Validate the Vercel and Railway adapters against live accounts, and verify provider previews for the commit a gate tested.

## Project

- A small public sample application under `examples/` to try discovery, a twin, journeys and the gate end to end.
