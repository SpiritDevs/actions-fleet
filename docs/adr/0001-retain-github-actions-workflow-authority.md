# Retain GitHub Actions as the workflow authority

The fleet supplies execution capacity and a shared operational dashboard while GitHub Actions retains workflow orchestration and its existing checks, logs, and artifact capabilities. The user requires the existing GitHub Actions workflow to survive the move away from paid compute, so this service integrates with that workflow rather than becoming an independent CI engine. Fleet capacity management and dashboard state must preserve GitHub's authoritative execution state.
