# open-emarsys

## Before handing a task back

Run `make verify`. It runs what CI runs: frozen install, `turbo lint typecheck test`,
`go vet` + `go test` per module in `go.work`, contract validation, and codegen with no
diffs. A task is not finished until it passes.

## Dependencies

If you add an import, declare the dependency and refresh the lockfile in the same commit
(`pnpm --filter <pkg> add ...`, `go get ...`). CI installs with `--frozen-lockfile`, so an
undeclared import fails the build for every other task too. This is by far the most common
reason a task here gets blocked — do not work around it by relaxing the CI flags.
