import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.200.0/http/file_server.ts";

// --- 辅助函数：用于生成 OpenAI 格式的错误响应 ---
function createOpenAIErrorResponse(message: string, statusCode = 500) {
    const errorPayload = {
        error: { message: message, type: "server_error" }
    };
    console.error("Replying with error:", JSON.stringify(errorPayload, null, 2));
    return new Response(JSON.stringify(errorPayload), {
        status: statusCode, headers: { "Content-Type": "application/json" }
    });
}

// --- 核心业务逻辑：调用 OpenRouter (保持不变) ---
async function callOpenRouter(prompt: string, images: string[], apiKey: string) {
    // ... 这部分代码无需改动
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

    // --- 兼容 OpenAI API 的端点 ---
    if (pathname === "/v1/chat/completions") {
        try {
            // --- 增强日志 ---
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

            // ========================= 【最终修复】 =========================
            const responsePayload = {
                id: `chatcmpl-${crypto.randomUUID()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: requestedModel,
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant",
                        // 1. 增加一个空的 text 部分，增强兼容性
                        content: [
                            { type: "text", text: "" },
                            { type: "image_url", image_url: { "url": generatedImageUrl } }
                        ]
                    },
                    finish_reason: "stop"
                }],
                // 2. 伪造一个看起来真实的 usage 对象
                usage: {
                    prompt_tokens: 50,      // 伪造值
                    completion_tokens: 700, // 伪造值
                    total_tokens: 750       // 伪造值
                }
            };
            // ===============================================================

            console.log("✅ Sending final payload to Cherry Studio:", JSON.stringify(responsePayload, null, 2));

            return new Response(JSON.stringify(responsePayload), {
                headers: { "Content-Type": "application/json" },
            });
        } catch (error) {
            console.error("Error handling /v1/chat/completions request:", error);
            return createOpenAIErrorResponse(error.message);
        }
    }
    
    // --- 原来的 Web UI 后端逻辑 (保持不变) ---
    if (pathname === "/generate") { /* ... */ }

    // --- 静态文件服务 (保持不变) ---
    return serveDir(req, { fsRoot: "static", urlRoot: "" });
});
