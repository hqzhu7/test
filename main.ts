import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.200.0/http/file_server.ts";
import { Buffer } from "https://deno.land/std@0.177.0/node/buffer.ts";

// --- 辅助函数：从 URL (可能是 http:// 或 file://) 获取 Base64 ---
// 注意：Deno Deploy 的沙箱环境可能无法直接访问 file:// 协议。
// 这个函数在本地 Deno 环境中可以工作，但在部署时需要注意权限问题。
// 对于 Cherry Studio 自己的 file-protocol URL，可能需要寻找其他转换方式，
// 但对于标准的 http URL 是有效的。
async function imageUrlToBase64(url: string): Promise<string> {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`Failed to fetch image from url: ${url}. Status: ${response.statusText}`);
        }
        const contentType = response.headers.get("content-type") || "image/png";
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);
        return `data:${contentType};base64,${buffer.toString("base64")}`;
    } catch (error) {
        console.error(`Error converting URL "${url}" to Base64:`, error);
        // 返回一个占位符或者直接抛出错误，让调用者处理
        throw new Error(`Could not process image URL: ${url}`);
    }
}

// --- 辅助函数：生成错误 JSON 响应 ---
function createJsonErrorResponse(message: string, statusCode = 500) {
    const errorPayload = {
        error: { message, type: "server_error", code: null }
    };
    console.error("Replying with error:", JSON.stringify(errorPayload, null, 2));
    return new Response(JSON.stringify(errorPayload), {
        status: statusCode, headers: { 
            "Content-Type": "application/json", "Access-Control-Allow-Origin": "*",
        }
    });
}


// --- 核心业务逻辑：调用 OpenRouter ---
async function callOpenRouter(prompt: string, imagesAsBase64: string[], apiKey: string): Promise<string> {
    const contentPayload: any[] = [{ type: "text", text: prompt }];
    for (const base64Url of imagesAsBase64) {
        contentPayload.push({ type: "image_url", image_url: { url: base64Url } });
    }
    
    const openrouterPayload = {
        model: "google/gemini-2.5-flash-image-preview:free",
        messages: [{ role: "user", content: contentPayload }],
    };

    console.log("Sending final payload to OpenRouter...");
    const apiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify(openrouterPayload)
    });

    if (!apiResponse.ok) {
        const errorBody = await apiResponse.text();
        throw new Error(`OpenRouter API error: ${apiResponse.statusText} - ${errorBody}`);
    }

    const responseData = await apiResponse.json();
    console.log("OpenRouter Response:", JSON.stringify(responseData, null, 2));

    const message = responseData.choices?.[0]?.message;
    let imageUrl = '';

    if (message?.content?.startsWith('data:image/')) { imageUrl = message.content; }
    else if (message?.images?.[0]?.image_url?.url) { imageUrl = message.images[0].image_url.url; }

    if (!imageUrl) { 
        console.error("Could not extract image URL from OpenRouter response:", JSON.stringify(responseData, null, 2));
        throw new Error("Could not extract a valid image URL from the OpenRouter API response."); 
    }
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

    // --- Cherry Studio 将调用这里 ---
    if (pathname === "/v1/chat/completions") {
        try {
            const openaiRequest = await req.json();
            const authHeader = req.headers.get("Authorization");
            const openrouterApiKey = authHeader?.substring(7) || "";
            const requestedModel = openaiRequest.model || 'gpt-4o';
            
            const userMessage = openaiRequest.messages?.find((m: any) => m.role === 'user');
            if (!userMessage?.content) { 
                return createJsonErrorResponse("Invalid request: No user message content found", 400);
            }

            let prompt = ""; 
            const imageUrls: string[] = [];
            if (Array.isArray(userMessage.content)) {
                for (const part of userMessage.content) {
                    if (part.type === 'text') { 
                        prompt = part.text; 
                    } else if (part.type === 'image_url' && part.image_url?.url) { 
                        imageUrls.push(part.image_url.url);
                    }
                }
            }
            
            // 异步地将所有收到的 URL 转换为 Base64
            const imagesAsBase64 = await Promise.all(
                imageUrls.map(url => imageUrlToBase64(url))
            );

            // 用转换后的 Base64 调用 OpenRouter 生成新图片
            const newImageBase64 = await callOpenRouter(prompt, imagesAsBase64, openrouterApiKey);

            // --- 终极修复：返回一个包含 Markdown 图片的简单文本响应 ---
            const markdownContent = `这是为您生成的图片：\n\n![Generated Image](${newImageBase64})`;

            const responsePayload = {
                id: `chatcmpl-${crypto.randomUUID()}`,
                object: "chat.completion",
                created: Math.floor(Date.now() / 1000),
                model: requestedModel,
                choices: [{
                    index: 0,
                    message: {
                        role: "assistant",
                        content: markdownContent, // <-- 核心在这里
                    },
                    finish_reason: "stop"
                }],
                usage: { prompt_tokens: 50, completion_tokens: 100, total_tokens: 150 }
            };

            console.log("✅ Sending final SIMPLE Markdown payload to Cherry Studio.");
            return new Response(JSON.stringify(responsePayload), {
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });

        } catch (error) {
            console.error("Error in final handler:", error);
            return createJsonErrorResponse(error.message || "An unknown error occurred", 500);
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
    return serveDir(req, {
        fsRoot: "static", 
        urlRoot: "",
        showDirListing: true,
        enableCors: true,
    });
});
