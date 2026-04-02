/**
 * @deprecated 旧版协议已废弃。
 *
 * 请使用 @openaide/protocol 包替代。
 *
 * 迁移方式：
 *   - import { Methods, ... } from '@openaide/protocol';
 *   + 或 import { Methods, ... } from '@openaide/shared'; （过渡兼容）
 *
 * 本文件中的旧版类型（ClientMessage / ServerMessage 等自定义格式）
 * 已被 JSON-RPC 2.0 标准协议取代，不再维护。
 */

// 重新导出新协议，保持向后兼容
export * from '@openaide/protocol';
