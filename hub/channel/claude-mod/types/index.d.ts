// The chatbridge mod's $.state contract. `busy` lives in host state, not a module
// variable, so a mid-turn reload (every app restart restages the mod) keeps it.
export type ChatbridgeBusy = boolean
// Counts module generations: a replaced module takes the next number, and the bridge of an older one ends.
export type ChatbridgeGeneration = number
// The factory version a running reload is loading ("" = none): a replaced module records it as applied at its start.
export type ChatbridgeApplying = string

declare module 'claude-code' {
  interface PluginState {
    chatbridge: { busy: ChatbridgeBusy; generation: ChatbridgeGeneration; applying: ChatbridgeApplying }
  }
}
