# AI Translator Chrome Extension

支持网页段落翻译和 YouTube 字幕翻译的 Chrome 插件，支持 OpenAI、Gemini、MiniMax、Kimi，并允许自定义 API Key 与端点。

## 开发命令

- `npm run build`：构建 `dist/`
- `npm run dev`：开发模式监听构建
- `npm run typecheck`：TypeScript 类型检查
- `npm run test`：运行单元测试

## 加载方式

1. 执行 `npm run build`
2. 打开 Chrome `chrome://extensions`
3. 打开“开发者模式”
4. 点击“加载已解压的扩展程序”
5. 选择本项目的 `dist/` 目录

## 已实现能力

- 网页段落翻译：在英文段落下方插入译文（Shadow DOM 隔离）
- YouTube 双语字幕：读取字幕轨道并叠加双语显示
- 多模型服务商：OpenAI / Gemini / MiniMax / Kimi（支持自定义端点与模型）
- 上下文翻译：网页段落与字幕都携带前后文窗口
- 设置页：模型配置、翻译偏好、样式与连接测试

## 示例

<img width="742" height="1193" alt="image" src="https://github.com/user-attachments/assets/221348db-306d-4dab-8a74-c04eaf7b33eb" />
