# Contributing to FalconDeck

Thanks for helping make FalconDeck a better workspace for coding agents. Bug reports, testing, documentation, design, and code contributions are welcome.

## Questions and feedback

Use [Discussions](https://github.com/jamesblackwell/falcondeck/discussions) for setup questions, workflows, and ideas. Use [Issues](https://github.com/jamesblackwell/falcondeck/issues/new/choose) for reproducible bugs and specific feature requests. Include the app and operating-system versions, coding agent, and steps to reproduce. Remove credentials, pairing codes, and private project content from logs or screenshots before sharing them.

## Make a change

1. For a substantial feature or architectural change, discuss the approach in an issue first. Small fixes and documentation improvements can go straight to a pull request.
2. Fork the repository, clone your fork, and create a branch.
3. Follow the [development setup](README.md#run-it-from-source) and the operational rules in [AGENTS.md](AGENTS.md). Read [DESIGN.md](DESIGN.md) for UI changes.
4. Keep the change focused and run the relevant checks. `make test-desktop`, `make test-rust`, and `make typecheck` cover the main development paths; the [mobile guide](docs/14-mobile-app.md) covers mobile checks.
5. Open a pull request explaining the problem, the resulting behaviour, and how you verified it. Include screenshots for visual changes.

If you are finding your way around, start with the [repository layout](docs/10-repo-layout.md). Documentation improvements and reports about the [first-run experience](docs/GETTING-STARTED.md) are useful contributions too.

FalconDeck is MIT licensed. Contributions are made under the same [license](LICENSE).
