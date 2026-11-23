# 参与贡献

[English](CONTRIBUTING.md) | 简体中文

欢迎提交 Bug、兼容性报告、文档改进、测试和代码。

## 提交 Issue 或 Pull Request 前

- 先搜索已有 Issue。
- 对较大的协议或安全边界改动，先讨论再开始实现。
- 使用合成数据或脱敏数据复现问题。不要附带真实 task 记录、rollout 文件、凭据、私有路径、密钥或公网地址。
- 兼容性报告请注明操作系统、Codex Desktop 版本、内置 CLI 版本、浏览器和连接模式。

## 开发流程

1. 使用 Node.js 22 或更高版本，并运行 `npm install` 安装依赖。
2. 在主题分支上完成一项范围明确的修改。
3. 为协议变化和浏览器可见行为添加或更新覆盖。
4. 修改界面时，在较窄的手机宽度下检查显示效果。
5. 保持英文和简体中文 README 内容一致。
6. 提交 Pull Request 前运行所需检查。

## 开发规则

- 不要提交 Codex 二进制文件、凭据、rollout 文件、task 记录、私有路径、公网 IP、SSH 密钥或代理密钥。
- Bridge 默认只监听 loopback。
- Desktop 控制模式下，Codex Desktop 必须是唯一的 task 写入者。
- 将 App Server payload 视为不可信数据，只暴露经过脱敏的字段。
- 不要静默启用旧版 RPC multiplexer 作为回退。
- 保持对 Node.js 22 或更高版本的兼容性。

## 必须运行的检查

    npm run check
    npm test
    npm run release:check

协议修改应记录已测试的 Codex 版本，并使用脱敏 fixture，不要使用真实 task 记录。
