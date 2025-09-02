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
            
            const fullBase64Url = await callOpenRouter(prompt, images, openrouterApiKey);

            const stream = new ReadableStream({
                start(controller) {
                    const sendChunk = (data: object) => {
                        const chunkString = `data: ${JSON.stringify(data)}\n\n`;
                        controller.enqueue(new TextEncoder().encode(chunkString));
                    };

                    // ========================= 【Redux 逻辑级修复】 =========================
                    // 这个响应流精确地模拟了能被 newMessage.ts 和 messageBlock.ts 正确处理的事件顺序

                    // --- 1. 发送 TEXT_START ---
                    // 这个事件会触发 Thunk 创建一个新的、空的助手消息（如果还没有的话），
                    // 并在这条消息里创建一个空的文本块。这是后续所有内容的“容器”。
                    sendChunk({ type: 'TEXT_START' });
                    console.log("🚀 Sent: TEXT_START (to create message container)");

                    // --- 2. 发送 IMAGE_COMPLETE ---
                    // 现在已经有了一个消息容器，这个事件会触发 Thunk 创建一个图片块，
                    // 并将这个图片块的 ID 添加到当前消息的 blocks 数组中。
                    // `OpenAIApiClient.ts` 会将非标准的 `images` 字段转换成这个标准的 `IMAGE_COMPLETE` chunk。
                    // 因此，我们直接发送它在转换后会产生的 chunk。
                    sendChunk({
                        type: 'IMAGE_COMPLETE',
                        image: {
                            type: 'base64',
                            images: [fullBase64Url] // 发送完整的 Base64 URL
                        }
                    });
                    console.log("🖼️ Sent: IMAGE_COMPLETE");

                    // --- 3. 发送 LLM_RESPONSE_COMPLETE ---
                    // 这个事件告诉 Thunk，这次 LLM 的回复已经完全结束。
                    // Thunk 会做一些清理工作，比如把消息状态从“处理中”更新为“成功”。
                    sendChunk({
                        type: 'LLM_RESPONSE_COMPLETE',
                        response: {
                            usage: {
                                prompt_tokens: 50,
                                completion_tokens: 700,
                                total_tokens: 750
                            }
                        }
                    });
                    console.log("✅ Sent: LLM_RESPONSE_COMPLETE");

                    // --- 4. 发送流结束标志 ---
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
    // --- 原来的 Web UI 后端逻辑 ---
    if (pathname === "/generate") {
        try {
            const { prompt, images, apikey } = await req.json();
            const openrouterApiKey = apikey || Deno.env.get("OPENROUTER_API_KEY");
            if (!openrouterApiKey) { return new Response(JSON.stringify({ error: "OpenRouter API key is not set." }), { status: 500 }); }
            if (!prompt || !images || !images.length) { return new Response(JSON.stringify({ error: "Prompt and images are required." }), { status: 400 }); }
            const generatedImageUrl = await callOpenRouter(prompt, images, openrouterApiKey);
            return new Response(JSON.stringify({ imageUrl: generatedImageUrl }), { headers: { "Content-Type": "application/json" } });
        } catch (error) {
            console.error("Error handling /generate request:", error);
            return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        }
    }

    // --- 静态文件服务 (服务于你的 Web UI) ---
    return serveDir(req, { fsRoot: "static", urlRoot: "", showDirListing: true, enableCors: true });
});
