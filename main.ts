import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.200.0/http/file_server.ts";

// --- 辅助函数：用于生成 OpenAI 格式的错误响应 ---
function createOpenAIErrorResponse(message: string, statusCode = 500) {
    const errorPayload = { error: { message, type: "server_error" } };
    console.error("Replying with error:", JSON.stringify(errorPayload, null, 2));
    return new Response(JSON.stringify(errorPayload), {
        status: statusCode, headers: { 
            "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
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
    if (!message) { throw new Error("Invalid response from OpenRouter: No 'message' object."); }
    const messageContent = message.content || "";
    let imageUrl = '';
    if (messageContent.startsWith('data:image/')) { imageUrl = messageContent; }
    else if (message.images && message.images.length > 0 && message.images[0].image_url?.url) { imageUrl = message.images[0].image_url.url; }
    if (!imageUrl) { throw new Error("Could not extract a valid image URL from the OpenRouter API response."); }
    return imageUrl;
}

// --- 主服务逻辑 ---
serve(async (req) => {
    const pathname = new URL(req.url).pathname;

    // CORS 预检请求处理
    if (req.method === 'OPTIONS') { /* ... [代码不变] */ }

    if (pathname === "/v1/chat/completions") {
        try {
            const openaiRequest = await req.json();
            const authHeader = req.headers.get("Authorization");
            if (!authHeader || !authHeader.startsWith("Bearer ")) { return createOpenAIErrorResponse("Authorization header missing", 401); }
            const openrouterApiKey = authHeader.substring(7);
            const userMessage = openaiRequest.messages?.find((m: any) => m.role === 'user');
            if (!userMessage || !userMessage.content) { return createOpenAIErrorResponse("No user message", 400); }
            let prompt = ""; const images: string[] = [];
            if (Array.isArray(userMessage.content)) {
                for (const part of userMessage.content) {
                    if (part.type === 'text') { prompt = part.text; } 
                    else if (part.type === 'image_url' && part.image_url?.url) { images.push(part.image_url.url); }
                }
            } else { prompt = userMessage.content as string; }
            if (!prompt) { return createOpenAIErrorResponse("Prompt is missing", 400); }
            
            const fullBase64Url = await callOpenRouter(prompt, images, openrouterApiKey);

            const stream = new ReadableStream({
                start(controller) {
                    const sendChunk = (data: object) => {
                        const chunkString = `data: ${JSON.stringify(data)}\n\n`;
                        controller.enqueue(new TextEncoder().encode(chunkString));
                    };

                    // ========================= 【imageCallbacks.ts 逻辑级修复】 =========================
                    // 这个事件流精确地满足了 imageCallbacks.ts 的两步处理逻辑

                    // --- 第 1 步：发送 IMAGE_CREATED ---
                    // 触发 onImageCreated 回调。
                    // 这会在前端创建一个状态为 PENDING 的图片块占位符，并显示出来。
                    sendChunk({ type: 'IMAGE_CREATED' });
                    console.log("🚀 Sent: IMAGE_CREATED (This will create the placeholder)");

                    // --- 第 2 步：发送 IMAGE_COMPLETE ---
                    // 触发 onImageGenerated 回调。
                    // 这会找到第一步创建的那个占位符，把图片 URL 填进去，并把状态更新为 SUCCESS。
                    // 我们直接模仿 OpenAIApiClient.ts 中 contentSource.images 的结构来构造 image 字段
                    const imageDataPayload = {
                        images: [fullBase64Url] 
                    };
                    sendChunk({
                        type: 'IMAGE_COMPLETE',
                        image: imageDataPayload
                    });
                    console.log("🖼️ Sent: IMAGE_COMPLETE (This will fill the placeholder)");

                    // --- 第 3 步：发送 LLM_RESPONSE_COMPLETE ---
                    // 结束整个响应流，让 Thunk 可以做最后的清理工作。
                    sendChunk({
                        type: 'LLM_RESPONSE_COMPLETE',
                        response: {
                            usage: { prompt_tokens: 50, completion_tokens: 700, total_tokens: 750 }
                        }
                    });
                    console.log("✅ Sent: LLM_RESPONSE_COMPLETE");

                    // --- 第 4 步：发送流结束标志 ---
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
                    "Access-Control-Allow-Origin": "*",
                },
            });
        } catch (error) {
            console.error("Error handling /v1/chat/completions request:", error);
            return createOpenAIErrorResponse(error.message);
        }
    }
    
    // ... [其他路由如 /generate 和静态文件服务保持不变] ...
    if (pathname === "/generate") { /* ... */ }
    return serveDir(req, { fsRoot: "static", urlRoot: "", showDirListing: true, enableCors: true });
});
