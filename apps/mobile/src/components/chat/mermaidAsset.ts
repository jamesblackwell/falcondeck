/**
 * The mermaid browser bundle, vendored in by metro.config.js and shipped as an
 * asset rather than JS. Bundling 3.4 MB of engine into the JS bundle would be
 * parsed on every cold start; as an asset it is read from disk only when a
 * transcript actually contains a diagram.
 */
// eslint-disable-next-line @typescript-eslint/no-require-imports
export default require('../../vendor/mermaid.min.txt') as number
