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

    if (req.method === 'OPTIONS') { /* ... [CORS 预检代码不变] */ }

    if (pathname === "/v1/chat/completions") {
        try {
            const openaiRequest = await req.json();
            // ... [请求解析和认证代码不变]

            const authHeader = req.headers.get("Authorization");
            if (!authHeader || !authHeader.startsWith("Bearer ")) { return createOpenAIErrorResponse("Auth header missing", 401); }
            const openrouterApiKey = authHeader.substring(7);
            const userMessage = openaiRequest.messages?.find((m: any) => m.role === 'user');
            const requestedModel = openaiRequest.model || 'gpt-4o';
            if (!userMessage || !userMessage.content) { return createOpenAIErrorResponse("No user message", 400); }
            let prompt = ""; const images: string[] = [];
            if (Array.isArray(userMessage.content)) {
                for (const part of userMessage.content) {
                    if (part.type === 'text') { prompt = part.text; } 
                    else if (part.type === 'image_url' && part.image_url?.url) { images.push(part.image_url.url); }
                }
            } else { prompt = userMessage.content as string; }
            if (!prompt) { return createOpenAIErrorResponse("Prompt is missing", 400); }

            const generatedImageUrl = await callOpenRouter(prompt, images, openrouterApiKey);

            const stream = new ReadableStream({
                start(controller) {
                    const-child-processes uuid = crypto.randomUUID();
                    const created = Math.floor(Date.now() / 1000);

                    // ========================= 【代码分析级修复】 =========================
                    // 模拟一个多步流，这与 Cherry Studio 的状态累积逻辑完全匹配

                    // --- 第 1 块：初始化块 ---
                    // 这个块告诉客户端：一个新的助手消息已经开始，角色是 assistant，内容是一个空的数组。
                    // 这会在客户端状态中创建一个新的、等待填充的消息对象。
                    const initialChunkPayload = {
                        id: `chatcmpl-${uuid}`,
                        object: "chat.completion.chunk",
                        created: created,
                        model: requestedModel,
                        choices: [{
                            index: 0,
                            delta: {
                                role: "assistant",
                                content: [], // 发送一个空数组来初始化多模态内容
                            },
                            finish_reason: null
                        }]
                    };
                    const initialChunk = `data: ${JSON.stringify(initialChunkPayload)}\n\n`;
                    controller.enqueue(new TextEncoder().encode(initialChunk));
                    console.log("🚀 Sending Step 1: Initial Chunk");

                    // --- 第 2 块：数据块 ---
                    // 这个块包含了真正的图片数据。客户端的累积逻辑会将这个 content 数组
                    // 与上一步创建的空数组进行合并/追加，从而填充消息。
                    const dataChunkPayload = {
                        id: `chatcmpl-${uuid}`,
                        object: "chat.completion.chunk",
                        created: created,
                        model: requestedModel,
                        choices: [{
                            index: 0,
                            delta: {
                                // 注意：这里不再需要 role，因为第一步已经定义了
                                content: [
                                    { type: "text", text: "" }, // 保持一个空的文本部分
                                    { type: "image_url", image_url: { "url": generatedImageUrl } }
                                ]
                            },
                            finish_reason: "stop" // 在最后一个数据块中标注结束
                        }],
                        usage: { prompt_tokens: 50, completion_tokens: 700, total_tokens: 750 } // usage 也放在最后
                    };
                    const dataChunk = `data: ${JSON.stringify(dataChunkPayload)}\n\n`;
                    // 添加一个微小的延迟，模拟真实的网络延迟，有时可以帮助客户端更好地处理流
                    setTimeout(() => {
                        controller.enqueue(new TextEncoder().encode(dataChunk));
                        console.log("🖼️ Sending Step 2: Data Chunk");
                        
                        // --- 结束标志 ---
                        const doneChunk = `data: [DONE]\n\n`;
                        controller.enqueue(new TextEncoder().encode(doneChunk));
                        console.log("🏁 Sending [DONE]");

                        controller.close();
                    }, 50); // 50毫秒延迟
                    // ===============================================================
                }
            });

            return new Response(stream, {
                headers: {
                    "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive",
                    "Access-Control-Allow-Origin": "*",
                },
            });

        } catch (error) {
            console.error("Error handling /v1/chat/completions request:", error);
            return createOpenAIErrorResponse(error.message);
        }
    }
    
    // ... 其他路由 ...
    return new Response("Not Found", { status: 404 });
});
