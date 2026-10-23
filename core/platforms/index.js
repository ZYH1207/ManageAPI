/**
 * 免费池 · 平台侧的入口。
 *
 * daemon 只 import 这一个文件就能拿到存储、连接器、账本三层；
 * 顺带把内置连接器注册上——manual.js 是导入即注册的，所以这里必须 re-export 它。
 */
export * from './store.js'
export * from './connector.js'
export * from './ledger.js'
export { manualConnector } from './manual.js'
// 导入即注册（connector.js 的约定）；放在 index 里是为了让服务端只 import 一个入口
export { workbuddyConnector, workbuddyCnConnector, codebuddyConnector } from './workbuddy.js'
