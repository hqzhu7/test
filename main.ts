import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.200.0/http/file_server.ts";

// ... [createOpenAIErrorResponse 和 callOpenRouter 函数保持不变] ...
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
    if (messageContent.startsWith('data:image/')) {
        imageUrl = messageContent;
    }
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
            } else if (typeof userMessage.content === 'string') { prompt = userMessage.content; }

            if (!prompt) { return createOpenAIErrorResponse("Invalid request: Prompt text is missing.", 400); }

            const generatedImageUrl = await callOpenRouter(prompt, images, openrouterApiKey);

            const responsePayload = {
                id: `chatcmpl-${crypto.randomUUID()}`,
                object: "chat.completion.chunk", // <-- 注意：在流式响应中，对象类型通常是 .chunk
                created: Math.floor(Date.now() / 1000),
                model: requestedModel,
                choices: [{
                    index: 0,
                    delta: { // <-- 注意：在流式响应中，字段是 delta
                        role: "assistant",
                        content: [
                            { type: "text", text: "" },
                            { type: "image_url", image_url: { "url": generatedImageUrl } }
                        ]
                    },
                    finish_reason: "stop" // 可以在最后一个 chunk 中发送
                }],
                usage: { prompt_tokens: 50, completion_tokens: 700, total_tokens: 750 }
            };

            console.log("✅ Constructing stream payload for Cherry Studio:", JSON.stringify(responsePayload, null, 2));

            // ========================= 【协议级修复】 =========================
            // 1. 创建一个可读流 (ReadableStream)
            const stream = new ReadableStream({
                start(controller) {
                    // 2. 将完整的 JSON 对象编码后放入一个 "data: " 块中
                    const chunk = `data: ${JSON.stringify(responsePayload)}\n\n`;
                    controller.enqueue(new TextEncoder().encode(chunk));
                    
                    // 3. 发送流结束标志
                    const doneChunk = `data: [DONE]\n\n`;
                    controller.enqueue(new TextEncoder().encode(doneChunk));
                    
                    // 4. 关闭流
                    controller.close();
                }
            });

            // 5. 返回流式响应，并设置正确的头部信息
            return new Response(stream, {
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "Access-Control-Allow-Origin": "*", // 确保 CORS 头部存在
                },
            });
            // ===============================================================

        } catch (error) {
            console.error("Error handling /v1/chat/completions request:", error);
            return createOpenAIErrorResponse(error.message);
        }
    }
    
    // --- 静态文件服务 (根据需要保留) ---
    if (pathname === "/" || pathname.startsWith("/index.html") || pathname.startsWith("/style.css") || pathname.startsWith("/script.js")) {
        return serveDir(req, { fsRoot: "static" });
    }

    // --- Web UI 后端逻辑 (根据需要保留) ---
    if (pathname === "/generate") { /* ... */ }

    // 默认返回 404
    return new Response("Not Found", { status: 404 });
});
