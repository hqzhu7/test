# AI 图片生成项目

这是一个使用 Deno 和 OpenRouter API 构建的简单 Web 应用，允许用户上传图片、输入提示词，并使用 `google/gemini-2.5-flash-image-preview:free` 模型生成新图片。

## 功能

- 上传本地图片并显示缩略图。
- 输入文本提示词。
- 输入 OpenRouter API Key 进行认证。
- 调用 OpenRouter API 生成图片。
- 在前端直接显示生成的图片。

## 技术栈

- **前端**: HTML, CSS, JavaScript (无框架)
- **后端**: Deno, Deno Standard Library
- **AI 模型**: OpenRouter - `google/gemini-2.5-flash-image-preview:free`

## 如何部署到 Deno Deploy

1.  **Fork 本项目**: 将此项目 Fork 到您自己的 GitHub 仓库。

2.  **登录 Deno Deploy**: 使用您的 GitHub 账号登录 <mcurl name="https://dash.deno.com/account/overview" url="https://dash.deno.com/account/overview"></mcurl> <mcreference link="https://dash.deno.com/account/overview" index="0">0</mcreference>。

3.  **创建新项目**:
    - 点击 "New Project"。
    - 选择您 Fork 的 GitHub 仓库。
    - 选择 `main` 分支和 `main.ts` 作为入口文件。

4.  **配置环境变量 (可选但推荐)**:
    - 在 Deno Deploy 项目的设置中，找到 "Environment Variables"。
    - 添加一个名为 `OPENROUTER_API_KEY` 的新变量，值为您的 OpenRouter API Key。
    - 这样做可以避免每次都在前端输入 API Key。

5.  **部署**: 点击 "Link" 或 "Deploy" 按钮，Deno Deploy 将会自动部署您的应用。

6.  **访问**: 部署成功后，您将获得一个 `*.deno.dev` 的 URL，通过该 URL 即可访问您的应用。

## 如何使用

1.  打开部署后的应用 URL。
2.  (可选) 如果您没有在 Deno Deploy 中设置环境变量，请在 "输入你的 OpenRouter API Key..." 输入框中填入您的 Key。
3.  (可选) 点击 "选择图片" 上传一张图片。
4.  在 "输入提示词..." 文本框中输入您的想法。
5.  点击 "生成" 按钮。
6.  等待片刻，生成的图片将显示在下方。