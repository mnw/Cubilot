// The chatbridge mod's $.state contract. `busy` lives in host state, not a module
// variable, so a mid-turn reload (every app restart restages the mod) keeps it.
export type ChatbridgeBusy = boolean

declare module 'claude-code' {
  interface PluginState {
    chatbridge: { busy: ChatbridgeBusy }
  }
}
