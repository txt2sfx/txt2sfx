/**
 * `txt2sfx-bridge` — programmatic entry.
 *
 * The published artifact is the CLI bundle; this module exists for the two
 * other consumers: the test suite, which builds hubs and servers without a
 * process or a port, and anyone embedding the bridge in their own tooling.
 * Everything the CLI composes is exported in parts, because the tests must be
 * able to exercise each seam — a fake playground against a real hub, a real
 * WS server against a fake hub-side, an MCP server over a pair of in-memory
 * streams.
 *
 * @packageDocumentation
 */

export { VERSION } from './version.js';

export { log, silentLog } from './log.js';
export type { Log } from './log.js';

export {
  FIT_TIMEOUT_MS,
  NEXT_DEFAULT_TIMEOUT_MS,
  NEXT_MAX_TIMEOUT_MS,
  PROTOCOL_VERSION,
  RELAY_TIMEOUT_MS,
  looksLikeBridge,
  timeoutForMethod,
} from './protocol.js';
export type {
  AgentStatus,
  AuditionParams,
  AuditionResult,
  ChatMessage,
  CompareParams,
  CompareResult,
  CompleteParams,
  CompleteResult,
  FitParams,
  FitResult,
  Frame,
  HealthPayload,
  ModelEvent,
  ModelProvisionParams,
  ModelProvisionResult,
  ModelRenderParams,
  ModelRenderResult,
  ModelStage,
  ModelStatus,
  NextResult,
  OpenParams,
  PairPayload,
  ParkedRequest,
  PlaygroundStateResult,
  Renderer,
  RenderFile,
  RenderParams,
  RenderResult,
} from './protocol.js';

export {
  DEFAULT_REPO,
  LICENCE_URL,
  StableAudio,
  TOKENS_URL,
  dirSize,
  ensureWorkspace,
  findLauncher,
  formatBytes,
  hfCacheDir,
  modelCacheDir,
  parseProvisioned,
  parseResult,
  provisionArgs,
  renderArgs,
  splitLines,
  workspace,
} from './stable-audio.js';
export type { Launcher, RenderResultLine, StableAudioOptions, Workspace } from './stable-audio.js';

export {
  CLAUDE_DEFAULT_BIN,
  CLAUDE_TIMEOUT_MS,
  ClaudeError,
  claudeArgs,
  claudeCompleter,
  conversationText,
  parseClaudeJson,
  runClaudeWorker,
  runCommand,
} from './claude.js';
export type { ClaudeOptions, ClaudeWorkerOptions, CommandResult, CommandRunner } from './claude.js';

export { Hub, NoPlaygroundError, localToolHub } from './hub.js';
export type { HubOptions, ModelPort, PlaygroundPort, SamplingFulfiller, ToolHub } from './hub.js';

export { PLAYGROUND_ORIGIN, createBridgeServer, originAllowed, remoteToolHub } from './http.js';
export type { BridgeServerOptions } from './http.js';

export {
  FrameReader,
  WsConnection,
  WsProtocolError,
  acceptKey,
  acceptUpgrade,
  encodeClientFrame,
  encodeServerFrame,
  unmask,
} from './ws.js';
export type { WsCallbacks, WsFrame } from './ws.js';

export { MCP_PROTOCOL_VERSION, createMcpServer } from './mcp.js';
export type { McpServer, McpServerOptions } from './mcp.js';

export { TOOLS, TOOL_NAMES, runTool } from './tools.js';
export type { ToolContext, ToolDefinition, ToolResult } from './tools.js';

export { createNativeRenderer, resolveRenderer } from './render.js';
export type {
  NativeImporter,
  NativeRenderer,
  NativeRenderResult,
  RendererResolution,
} from './render.js';

export {
  describeMode,
  ensureState,
  loadState,
  newToken,
  saveState,
  stateDir,
  stateFilePath,
} from './state.js';
export type { BridgeState } from './state.js';

export { parseCliOptions } from './cli.js';
export type { CliOptions } from './cli.js';
