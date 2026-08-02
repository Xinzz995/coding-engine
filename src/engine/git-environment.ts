/**
 * Git 官方定义用 `/dev/null` 跳过全局配置。不要改用 `node:os` 的 devNull：
 * Windows 上它是 `\\.\nul`，Git for Windows 会把该值当成非法配置路径。
 */
export const GIT_NULL_CONFIG_PATH = '/dev/null';
