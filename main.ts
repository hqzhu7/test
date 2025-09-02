import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.200.0/http/file_server.ts";

// --- 辅助函数：用于生成 OpenAI 格式的错误响应 ---
function createOpenAIErrorResponse(message: string, statusCode = 500) {
    const errorPayload = {
        error: { message: message, type: "server_error" }
    };
    console.error("Replying with error:", JSON.stringify(errorPayload, null, 2));
    return new Response(JSON.stringify(errorPayload), {
        status: statusCode, headers: { 
            "Content-Type": "application/json",
            "Access-Control-Allow-Origin": "*",
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
        method: "POST", 
        headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Stainless-Retry-Count, X-Stainless-Timeout, Traceparent, Http-Referer, Sec-Ch-Ua, Sec-Ch-Ua-Mobile, Sec-Ch-Ua-Platform, Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site, X-Title, User-Agent, Priority, Accept, Accept-Encoding, Accept-Language, Host, Content-Length",
            },
        });
    }

    // --- 兼容 OpenAI API 的端点 (OpenAIApiClient.ts 将调用这里) ---
    if (pathname === "/v1/chat/completions") {
        try {
            const openaiRequest = await req.json();
            const authHeader = req.headers.get("Authorization");
            if (!authHeader || !authHeader.startsWith("Bearer ")) { return createOpenAIErrorResponse("Authorization header is missing or invalid.", 401); }
            const openrouterApiKey = authHeader.substring(7);
            const userMessage = openaiRequest.messages?.find((m: any) => m.role === 'user');
            const requestedModel = openaiRequest.model || 'gpt-4o'; // 保持伪装
            if (!userMessage || !userMessage.content) { return createOpenAIErrorResponse("Invalid request: No user message found.", 400); }
            let prompt = ""; const images: string[] = [];
            if (Array.isArray(userMessage.content)) {
                for (const part of userMessage.content) {
                    if (part.type === 'text') { prompt = part.text; } 
                    else if (part.type === 'image_url' && part.image_url?.url) { images.push(part.image_url.url); }
                }
            } else { prompt = userMessage.content as string; }
            if (!prompt) { return createOpenAIErrorResponse("Invalid request: Prompt text is missing.", 400); }
            
            const fullBase64Url = await callOpenRouter(prompt, images, openrouterApiKey);

            const stream = new ReadableStream({
                start(controller) {
                    const uuid = crypto.randomUUID();
                    const created = Math.floor(Date.now() / 1000);
                    const sendChunk = (data: object) => {
                        const chunkString = `data: ${JSON.stringify(data)}\n\n`;
                        controller.enqueue(new TextEncoder().encode(chunkString));
                    };

                    // ========================= 【最终代码级修复】 =========================
                    // 根据 OpenAIApiClient.ts 的代码，构建一个包含非标准 `images` 字段的流

                    // --- 第 1 块：角色初始化块 ---
                    // 这个块是标准的，用于告诉客户端一个新助手的消息开始了。
                    sendChunk({
                        id: `chatcmpl-${uuid}`, object: "chat.completion.chunk", created: created, model: requestedModel,
                        choices: [{ index: 0, delta: { role: "assistant" }, finish_reason: null }]
                    });
                    console.log("🚀 Sent: Role Initial Chunk");

                    // --- 第 2 块：图片数据块 (核心) ---
                    // 这个块包含了 OpenAIApiClient.ts 正在寻找的 `images` 字段。
                    sendChunk({
                        id: `chatcmpl-${uuid}`, object: "chat.completion.chunk", created: created, model: requestedModel,
                        choices: [{
                            index: 0,
                            delta: {
                                images: [{ image_url: { url: fullBase64Url } }] // 使用完整的 Base64 URL
                            },
                            finish_reason: null
                        }]
                    });
                    console.log("🖼️ Sent: Image Data Chunk");

                    // --- 第 3 块：结束块 ---
                    // 发送一个带有 `finish_reason` 的标准结束块。
                    sendChunk({
                        id: `chatcmpl-${uuid}`, object: "chat.completion.chunk", created: created, model: requestedModel,
                        choices: [{ index: 0, delta: {}, finish_reason: "stop" }]
                    });
                    console.log("✅ Sent: Finish Chunk");
                    
                    // --- 第 4 块：Usage 块 (可选但推荐) ---
                    // 某些客户端需要这个块来最终确认。
                     sendChunk({
                        id: `chatcmpl-${uuid}`, object: "chat.completion.chunk", created: created, model: requestedModel,
                        usage: { prompt_tokens: 50, completion_tokens: 700, total_tokens: 750 },
                        choices: []
                    });
                    console.log("🏁 Sent: Usage Chunk");

                    // --- 结束标志 ---
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
