# Contributing

## A feature brings its e2e:simulate checks

A pull request that adds or changes a feature also adds that feature's flow
and checks to `npm run e2e:simulate`, in the same pull request.

- **Deterministic checks** are what the feature must always do. A failing one
  fails the run.
- **Scores** are what moves with the AI's answer. They measure co-maintainer,
  not the model's writing, and are only reported.

The simulation lives in `src/testing/sim/`, the entry point is
`scripts/e2e_simulate.ts`. CI runs it with the fake AI. With a real AI it costs
money:

```sh
npm run e2e:simulate
npm run e2e:simulate -- --ai=openrouter --ai-key=... --low-model=... --high-model=... --output=<dir>
```
