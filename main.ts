import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.200.0/http/file_server.ts";

// --- 辅助函数：用于生成 OpenAI 格式的错误响应 ---
function createOpenAIErrorResponse(message: string, statusCode = 500) {
    const errorPayload = {
        error: { message: message, type: "server_error" }
    };
    console.error("Replying with error:", JSON.stringify(errorPayload, null, 2));
    // 错误响应不需要流式，保持为普通 JSON
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
                "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Api-Key, X-Stainless-Retry-Count, X-Stainless-Timeout, Traceparent, Http-Referer, Sec-Ch-Ua, Sec-Ch-Ua-Mobile, Sec-Ch-Ua-Platform, Sec-Fetch-Dest, Sec-Fetch-Mode, Sec-Fetch-Site, X-Title, User-Agent, Priority, Accept, Accept-Encoding, Accept-Language, Host, Content-Length",
            },
        });
    }

    // --- 兼容 OpenAI API 的端点 (Cherry Studio 将调用这里) ---
    if (pathname === "/v1/chat/completions") {
        try {
            const openaiRequest = await req.json();
            
            const authHeader = req.headers.get("Authorization");
            if (!authHeader || !authHeader.startsWith("Bearer ")) { 
                return createOpenAIErrorResponse("Authorization header is missing or invalid.", 401); 
            }
            const openrouterApiKey = authHeader.substring(7);

            const userMessage = openaiRequest.messages?.find((m: any) => m.role === 'user');
            if (!userMessage || !userMessage.content) { 
                return createOpenAIErrorResponse("Invalid request: No user message found.", 400); 
            }

            let prompt = ""; 
            const images: string[] = [];
            if (Array.isArray(userMessage.content)) {
                for (const part of userMessage.content) {
                    if (part.type === 'text') { 
                        prompt = part.text; 
                    } else if (part.type === 'image_url' && part.image_url?.url) { 
                        images.push(part.image_url.url); 
                    }
                }
            } else { 
                prompt = userMessage.content as string; 
            }

            if (!prompt) { 
                return createOpenAIErrorResponse("Invalid request: Prompt text is missing.", 400); 
            }
            
            // 注意: callOpenRouter 返回的 Base64 字符串是包含 "data:image/png;base64," 前缀的
            const fullBase64Url = await callOpenRouter(prompt, images, openrouterApiKey);
            // 我们需要去掉这个前缀，因为客户端代码里是自己拼接的
            const base64Data = fullBase64Url.split(',')[1];

            const stream = new ReadableStream({
                start(controller) {
                    // 封装一个发送 chunk 的辅助函数
                    const sendChunk = (data: object) => {
                        const chunkString = `data: ${JSON.stringify(data)}\n\n`;
                        controller.enqueue(new TextEncoder().encode(chunkString));
                    };

                    // ========================= 【真实代码级修复】 =========================
                    // 根据 OpenAIResponseAPIClient.ts 的代码，我们必须发送这种特定类型的 chunk

                    // 1. 发送 "开始生成" 信号
                    sendChunk({
                        type: 'response.image_generation_call.generating'
                    });
                    console.log("🚀 Sent: image_generation_call.generating");

                    // 2. 发送包含图片数据的 "部分图片" 信号
                    // 即使图片是完整的，我们也用 partial_image 类型发送，完全匹配它的 case
                    sendChunk({
                        type: 'response.image_generation_call.partial_image',
                        partial_image_b64: base64Data // 发送不带前缀的 Base64 数据
                    });
                    console.log("🖼️ Sent: image_generation_call.partial_image with data");

                    // 3. 发送 "完成" 信号
                    sendChunk({
                        type: 'response.image_generation_call.completed'
                    });
                    console.log("✅ Sent: image_generation_call.completed");
                    
                    // 4. (重要) 发送一个最终的 `response.completed` 块，并包含伪造的 usage
                    // 这个块会触发 LLM_RESPONSE_COMPLETE 事件，让客户端知道整个交互结束了
                    sendChunk({
                        type: 'response.completed',
                        response: {
                           usage: {
                                input_tokens: 50,
                                output_tokens: 700,
                                total_tokens: 750
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

            if (!openrouterApiKey) {
                return new Response(JSON.stringify({ error: "OpenRouter API key is not set." }), { status: 500 });
            }
            if (!prompt || !images || images.length === 0) {
                 return new Response(JSON.stringify({ error: "Prompt and images are required." }), { status: 400 });
            }
            
            const generatedImageUrl = await callOpenRouter(prompt, images, openrouterApiKey);

            return new Response(JSON.stringify({ imageUrl: generatedImageUrl }), {
                headers: { "Content-Type": "application/json" },
            });

        } catch (error) {
            console.error("Error handling /generate request:", error);
            return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        }
    }

    // --- 静态文件服务 (服务于你的 Web UI) ---
    // 确保你的 index.html, style.css, script.js 在 "static" 文件夹中
    return serveDir(req, {
        fsRoot: "static", 
        urlRoot: "",
        showDirListing: true,
        enableCors: true,
    });
});
