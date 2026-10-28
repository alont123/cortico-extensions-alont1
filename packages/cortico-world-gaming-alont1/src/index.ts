/** 扩展入口：默认导出 WorldDefinition。 */
export { GAMING as default, createGamingWorld } from './definition.ts'
export { GAMING_DEFAULTS, GAMING_CONFIG_GROUP, GAMING_SECRETS, GAMING_WATCH_DEFAULTS } from './config.ts'
export { GamingWorld } from './world.ts'
export { ScreenWatcher, parseReading, type ScreenPhase, type ScreenReading } from './screen.ts'
export { ForegroundWatcher, type ForegroundSample } from './tracker-window.ts'
export { GameTracker, matchGame, looksLikeGame, DEFAULT_NON_GAME, type GameEvent, type GameSession, type GamingState } from './tracker-logic.ts'
export type { GamingConfigSection, GameConfig, GamingWatchConfig } from './config.ts'
