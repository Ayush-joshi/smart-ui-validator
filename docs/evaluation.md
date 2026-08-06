# Evaluation and release gates

The versioned v1 corpus contains repository-owned synthetic React and Angular fixtures. No external
design asset or private code is included. Observations follow a strict schema covering fidelity,
correctness/reuse, viewports/states, accessibility, repair convergence/rollback, context/tokens,
latency/browser/artifacts, memory precision, and security block rates.

`pnpm evaluate` requires exactly one observation for every corpus scenario and fails when any gate in
`release-thresholds.v1.json` regresses. The generated scorecard is ignored by Git and uploaded as CI
evidence. Checked-in observations are reviewed reference inputs, not a claim that live Figma, hosts,
Slack, remote MCP, or enterprise authentication were exercised.

For a pilot release, replace reference observations with measured run output, retain provenance and
raw run/artifact hashes, review all thresholds rather than only the aggregate, and compare against the
previous accepted scorecard. Changing a threshold requires explicit review and a changelog entry.
