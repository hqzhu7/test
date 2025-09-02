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
            contentPayload.push({
                type: "image_url",
                image_url: { url: imageUrl }
            });
        }
        // 如果有图片，可以考虑修改一下提示词
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
        headers: {
            "Authorization": `Bearer ${apiKey}`,
            "Content-Type": "application/json"
        },
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
            // 注意: `requestedModel` 在此模式下不再直接用于响应体的 `model` 字段，因为我们模拟的是 Response API 的 chunk 类型，
            // 它们通常不包含顶层的 model 字段，而是由客户端根据请求来推断。
            // 但保留它以防未来有其他用途或调试需要。
            const requestedModel = openaiRequest.model || 'gpt-4o'; // 客户端请求的模型名


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
            } else if (typeof userMessage.content === 'string') {
                prompt = userMessage.content;
            }

            if (!prompt) { return createOpenAIErrorResponse("Invalid request: Prompt text is missing.", 400); }

            // callOpenRouter 返回的 Base64 字符串是包含 "data:image/png;base64," 前缀的
            const fullBase64Url = await callOpenRouter(prompt, images, openrouterApiKey);
            // 我们需要去掉这个前缀，因为客户端代码里是自己拼接的
            const base64Data = fullBase64Url.split(',')[1];

            const stream = new ReadableStream({
                start(controller) {
                    const uuid = crypto.randomUUID(); // 生成一个唯一的ID
                    const created = Math.floor(Date.now() / 1000); // 当前时间戳

                    // 辅助函数：封装发送 chunk 的逻辑
                    const sendChunk = (data: object, delayMs: number = 0) => {
                        const chunkString = `data: ${JSON.stringify(data)}\n\n`;
                        setTimeout(() => {
                            controller.enqueue(new TextEncoder().encode(chunkString));
                            console.log(`✅ Sent Chunk (after ${delayMs}ms):`, JSON.stringify(data, null, 2));
                        }, delayMs);
                    };

                    // ========================= 【基于 Cherry Studio 代码的精确模仿】 =========================
                    // 模拟 Response API 模式的流式图片响应

                    // 1. 发送 "开始生成" 信号 (type: 'response.image_generation_call.generating')
                    // 这对应 Cherry Studio 中的 `case 'response.image_generation_call.generating'`
                    sendChunk({
                        id: `image-gen-${uuid}`, // 伪造 ID
                        object: "image.generation", // 伪造对象类型
                        type: 'response.image_generation_call.generating',
                        created: created,
                        // 确保有足够的字段让客户端不会报错，即使它们不全被用到
                    });

                    // 2. 发送包含完整图片数据的 "部分图片" 信号 (type: 'response.image_generation_call.partial_image')
                    // 即使图片是完整的，我们也用 partial_image 类型发送，完全匹配其代码的 `case 'response.image_generation_call.partial_image'`
                    // 并且 `images` 数组里面是 Base64 数据，不带 `data:image/png;base64,` 前缀
                    sendChunk({
                        id: `image-gen-${uuid}`,
                        object: "image.generation",
                        type: 'response.image_generation_call.partial_image',
                        created: created,
                        partial_image_b64: base64Data // 发送不带前缀的 Base64 数据
                    }, 50); // 稍微延迟，模拟网络传输

                    // 3. 发送 "图片生成完成" 信号 (type: 'response.image_generation_call.completed')
                    // 这对应 Cherry Studio 中的 `case 'response.image_generation_call.completed'`
                    sendChunk({
                        id: `image-gen-${uuid}`,
                        object: "image.generation",
                        type: 'response.image_generation_call.completed',
                        created: created,
                    }, 100); // 稍微延迟，模拟完成

                    // 4. 发送一个最终的 `response.completed` 块，并包含伪造的 `usage`
                    // 这个块会触发 `ChunkType.LLM_RESPONSE_COMPLETE` 事件，让客户端知道整个交互结束了
                    // 确保 usage 字段有非零值，避免客户端忽略。
                    sendChunk({
                        id: `chatcmpl-${uuid}`, // 这里的 ID 可以不同，模拟 chat completion 的 ID
                        object: "chat.completion", // 这里是 chat completion 的 completed
                        type: 'response.completed', // 匹配 `case 'response.completed'`
                        created: created,
                        response: { // 结构匹配 OpenAI.Responses.Response 的类型
                           usage: {
                                input_tokens: 50,
                                output_tokens: 700,
                                total_tokens: 750
                           },
                           output: [] // 确保 output 存在，即使是空的
                        },
                        model: requestedModel // 可以在这里带上模型名，虽然 Response API 的 chunk 通常不强制
                    }, 150);


                    // 5. 发送流结束标志
                    const doneChunk = `data: [DONE]\n\n`;
                    setTimeout(() => {
                        controller.enqueue(new TextEncoder().encode(doneChunk));
                        console.log("🏁 Sent: [DONE]");
                        controller.close();
                    }, 200); // 确保在所有数据块之后发送
                    // ===============================================================
                }
            });

            return new Response(stream, {
                headers: {
                    "Content-Type": "text/event-stream",
                    "Cache-Control": "no-cache",
                    "Connection": "keep-alive",
                    "Access-Control-Allow-Origin": "*", // 确保 CORS 头部存在
                },
            });

        } catch (error) {
            console.error("Error handling /v1/chat/completions request:", error);
            return createOpenAIErrorResponse(error.message);
        }
    }

    // --- 原来的 Web UI 后端逻辑 (/generate) ---
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

    // --- 静态文件服务 (用于你的前端 UI) ---
    // 将 index.html, style.css, script.js 放在 static 文件夹中
    return serveDir(req, {
        fsRoot: "static",
        urlRoot: "",
        showDirListing: true,
        enableCors: true,
    });
});
