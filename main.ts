import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.200.0/http/file_server.ts";

// --- 辅助函数：用于生成 OpenAI 格式的错误响应 ---
function createOpenAIErrorResponse(message: string, statusCode = 500) {
    const errorPayload = {
        error: { message: message, type: "server_error" }
    };
    console.error("Replying with error:", JSON.stringify(errorPayload, null, 2));
    // 错误响应不需要流式，保持原样
    return new Response(JSON.stringify(errorPayload), {
        status: statusCode, headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*", // 添加 CORS 头
        }
    });
}

// --- 核心业务逻辑：调用 OpenRouter ---
async function callOpenRouter(prompt: string, images: string[], apiKey: string): Promise<string> {
    const contentPayload: any[] = [{ type: "text", text: prompt }];
    if (images && images.length > 0) {
        for (const imageUrl of images) {
            contentPayload.push({ type: "image_url", image_url: { url: imageUrl } });
        }
        if(contentPayload[0].text){
           contentPayload[0].text = `根据我上传的这 ${images.length} 张图片，${prompt}`;
        }
    }
    const openrouterPayload = {
        model: "google/gemini-2.5-flash-image-preview:free",
        messages: [{ role: "user", content: contentPayload }],
        stream: false
    };
    console.log("Sending payload to OpenRouter:", JSON.stringify(openrouterPayload, null, 2));
    const apiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(openrouterPayload)
    });
    if (!apiResponse.ok) {
        const errorBody = await apiResponse.text();
        console.error("OpenRouter API error:", errorBody);
        throw new Error(`OpenRouter API error: ${apiResponse.statusText} - ${errorBody}`);
    }
    const responseData = await apiResponse.json();
    console.log("OpenRouter Response:", JSON.stringify(responseData, null, 2));
    const message = responseData.choices?.[0]?.message;
    if (!message) {
        throw new Error("Invalid response from OpenRouter: No 'message' object.");
    }
    const messageContent = message.content || "";
    let imageUrl = '';
    // 优先从 message.content 中提取 Base64 图像
    if (messageContent.startsWith('data:image/')) {
        imageUrl = messageContent;
    }
    // 备用方案，如果模型返回了 images 字段
    else if (message.images && message.images.length > 0 && message.images[0].image_url?.url) {
        imageUrl = message.images[0].image_url.url;
    }
    if (!imageUrl) {
        console.error("Could not extract image URL from OpenRouter response:", JSON.stringify(message, null, 2));
        throw new Error("Could not extract a valid image URL from the OpenRouter API response.");
    }
    return imageUrl;
}

// --- 主服务逻辑 ---
serve(async (req) => {
    const pathname = new URL(req.url).pathname;

    // 添加 OPTIONS 方法处理，用于 CORS 预检请求
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Stainless-Retry-Count, X-Stainless-Timeout, Traceparent",
            },
        });
    }
    
    // --- 兼容 OpenAI API 的端点 ---
    if (pathname === "/v1/chat/completions") {
        try {
            console.log("🎁 Received Headers from Cherry Studio:", JSON.stringify(Object.fromEntries(req.headers.entries()), null, 2));
            const openaiRequest = await req.json();
            console.log("📦 Received Body from Cherry Studio:", JSON.stringify(openaiRequest, null, 2));

            const authHeader = req.headers.get("Authorization");
            if (!authHeader || !authHeader.startsWith("Bearer ")) {
                return createOpenAIErrorResponse("Authorization header is missing or invalid.", 401);
            }
            const openrouterApiKey = authHeader.substring(7);
            const userMessage = openaiRequest.messages?.find((m: any) => m.role === 'user');
            // 注意：requestedModel 在 Cherry Studio 的 Response API 模式下可能不是直接使用，但保留以防万一
            const requestedModel = openaiRequest.model || 'gpt-4o'; 

            if (!userMessage || !userMessage.content) {
                return createOpenAIErrorResponse("Invalid request: No user message found.", 400);
            }

            let prompt = "";
            const images: string[] = [];
            if (Array.isArray(userMessage.content)) {
                for (const part of userMessage.content) {
                    if (part.type === 'text') { prompt = part.text; } 
                    else if (part.type === 'image_url' && part.image_url?.url) { images.push(part.image_url.url); }
                }
            } else if (typeof userMessage.content === 'string') { // 如果 content 是纯字符串
                prompt = userMessage.content;
            }

            if (!prompt) { return createOpenAIErrorResponse("Invalid request: Prompt text is missing.", 400); }
            
            // callOpenRouter 返回的 Base64 字符串是包含 "data:image/png;base64," 前缀的
            const fullBase64Url = await callOpenRouter(prompt, images, openrouterApiKey);
            // 我们需要去掉这个前缀，因为 Cherry Studio 的 `partial_image_b64` 期望的是纯 Base64 数据
            const base64Data = fullBase64Url.split(',')[1];

            const stream = new ReadableStream({
                start(controller) {
                    // 封装一个发送 chunk 的辅助函数
                    const sendChunk = (data: object) => {
                        const chunkString = `data: ${JSON.stringify(data)}\n\n`;
                        controller.enqueue(new TextEncoder().encode(chunkString));
                    };

                    // ========================= 【基于代码分析的最终修复】 =========================
                    // 根据 Cherry Studio 的 OpenAIResponseAPIClient.ts，我们必须发送这种特定类型的 chunk

                    // 1. 发送 "开始生成" 信号 (对应 case 'response.image_generation_call.generating')
                    sendChunk({
                        type: 'response.image_generation_call.generating'
                    });
                    console.log("🚀 Sent: image_generation_call.generating");

                    // 2. 发送包含图片数据的 "部分图片" 信号 (对应 case 'response.image_generation_call.partial_image')
                    // 即使图片是完整的，我们也用 partial_image 类型发送，完全匹配它的处理逻辑
                    sendChunk({
                        type: 'response.image_generation_call.partial_image',
                        partial_image_b64: base64Data // 发送不带前缀的 Base64 数据
                    });
                    console.log("🖼️ Sent: image_generation_call.partial_image with data");

                    // 3. 发送 "完成" 信号 (对应 case 'response.image_generation_call.completed')
                    sendChunk({
                        type: 'response.image_generation_call.completed'
                    });
                    console.log("✅ Sent: image_generation_call.completed");
                    
                    // 4. (重要) 发送一个最终的 `response.completed` 块，并包含伪造的 usage
                    // 这个块会触发 LLM_RESPONSE_COMPLETE 事件，让客户端知道整个交互结束了
                    // 并且会更新 token 使用量信息
                    sendChunk({
                        type: 'response.completed',
                        response: {
                           usage: {
                                input_tokens: 50,      // 伪造值
                                output_tokens: 700,    // 伪造值
                                total_tokens: 750      // 伪造值
                           }
                        }
                    });
                    console.log("🏁 Sent: response.completed with usage");

                    // 5. 发送流结束标志
                    const doneChunk = `data: [DONE]\n\n`;
                    controller.enqueue(new TextEncoder().encode(doneChunk));
                    console.log("🏁 Sent: [DONE]");
                    
                    controller.close();
                    // ===============================================================
                }
            });

            return new Response(stream, {
                headers: {
                    "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive",
                    "Access-Control-Allow-Origin": "*", // 确保 CORS 头部存在
                },
            });

        } catch (error) {
            console.error("Error handling /v1/chat/completions request:", error);
            // 错误响应不应该走流式，直接返回 JSON 错误
            return createOpenAIErrorResponse(error.message);
        }
    }
    
    // --- 原来的 Web UI 后端逻辑 ---
    if (pathname === "/generate") {
        try {
            const { prompt, images, apikey } = await req.json();
            const openrouterApiKey = apikey || Deno.env.get("OPENROUTER_API_KEY");

            if (!openrouterApiKey) {
                return new Response(JSON.stringify({ error: "OpenRouter API key is not set." }), { status: 500, headers: { "Content-Type": "application/json" } });
            }
            if (!prompt || !images || images.length === 0) {
                 return new Response(JSON.stringify({ error: "Prompt and images are required." }), { status: 400, headers: { "Content-Type": "application/json" } });
            }
            
            const generatedImageUrl = await callOpenRouter(prompt, images, openrouterApiKey);

            return new Response(JSON.stringify({ imageUrl: generatedImageUrl }), {
                headers: { "Content-Type": "application/json" },
            });

        } catch (error) {
            console.error("Error handling /generate request:", error);
            return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }

    // --- 静态文件服务 ---
    // 为了让 Web UI 能正常访问，这里需要更灵活。
    // 如果你只用 Deno Deploy 做 Cherry Studio 代理，可以删除这部分或更严格。
    // 如果 Web UI 和代理在同一个 Deno Deploy 实例，确保 'static' 文件夹存在并包含前端文件。
    return serveDir(req, {
        fsRoot: "static", // 确保你的 index.html, style.css, script.js 在 'static' 文件夹内
        urlRoot: "",      // 从根路径开始提供服务
        showDirListing: false, // 部署时通常设置为 false
        enableCors: true,    // 允许跨域
    });
});
