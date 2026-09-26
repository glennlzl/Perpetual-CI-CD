# 2. Autopilot merges its own changes only through verified pull requests

A pipeline that repairs and evolves itself needs to write to the repository, and a write that lands on the target branch unverified would defeat the gate that makes the pipeline trustworthy. So every change Autopilot makes is a pull request on a branch of its own, the stage that owns the change verifies the pull request's head (checks, a recorded deployment, later the journey gate), and only then does Autopilot merge it through GitHub's merge API, so branch protection and review rules bind it like any contributor. The agent that writes a change edits a private worktree and runs nothing; installs, builds and tests run in a container through the twin runtime, never on the host.

Status: proposed.

## Consequences

- Autopilot needs a connected GitHub session with write access; its pushes and merges use gh's credential helper and `gh api`, and Perpetual writes no token.
- A change never turns a failed gate into a passed one; the merged commit runs the stage again.
- `Ask first` is a per-stage mode that stops at the open pull request, so a person merges on GitHub; a merge that branch protection refuses ends the same way.
- Verification before merging is only as strong as the stage's checks: a Build fix is verified by CI, a Production fix by the provider's recorded deployment, and a major dependency update waits for a person until a Sandbox stage can run the journey gate at a pull request head.
- The design and its build order are in [Autopilot](../architecture/autopilot.md).
