import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.200.0/http/file_server.ts";
import { Buffer } from "https://deno.land/std@0.177.0/node/buffer.ts";

// --- 辅助函数：用于生成错误 JSON 响应 ---
function createJsonErrorResponse(message: string, statusCode = 500) {
    // Gemini 的错误格式可能不同，但为了简单起见，我们先用一个通用格式
    const errorPayload = { error: { message, code: statusCode, status: "UNAVAILABLE" } };
    console.error("Replying with error:", JSON.stringify(errorPayload, null, 2));
    return new Response(JSON.stringify(errorPayload), {
        status: statusCode, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
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
    console.log("Sending payload to OpenRouter:", JSON.stringify(openrouterPayload, null, 2));
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
    if (!imageUrl) { throw new Error("Could not extract a valid image URL from the OpenRouter API response."); }
    return imageUrl;
}

// --- 主服务逻辑 ---
serve(async (req) => {
    const pathname = new URL(req.url).pathname;
    
    // CORS 预检
    if (req.method === 'OPTIONS') { /* ... [代码不变] */ }

    // --- Cherry Studio (配置为 Gemini) 将调用这里 ---
    // Gemini API 的路径通常包含模型名称和 ":streamGenerateContent"
    if (pathname.includes(":streamGenerateContent")) {
        try {
            const geminiRequest = await req.json();
            const authHeader = req.headers.get("Authorization"); // Gemini SDK 可能使用 x-goog-api-key
            const apiKey = authHeader?.substring(7) || req.headers.get("x-goog-api-key") || "";

            const userMessage = geminiRequest.contents?.find((c: any) => c.role === 'user');
            if (!userMessage?.parts) { return createJsonErrorResponse("Invalid Gemini request: No user parts found", 400); }

            let prompt = ""; const imagesAsBase64: string[] = [];
            for (const part of userMessage.parts) {
                if (part.text) { prompt = part.text; }
                if (part.inlineData?.data) {
                    imagesAsBase64.push(`data:${part.inlineData.mimeType};base64,${part.inlineData.data}`);
                }
            }
            
            const newImageBase64 = await callOpenRouter(prompt, imagesAsBase64, apiKey);

            // 从完整的 Base64 URL 中分离出 mimeType 和 data
            const matches = newImageBase64.match(/^data:(.+);base64,(.*)$/);
            if (!matches || matches.length !== 3) { throw new Error("Generated content is not a valid Base64 URL"); }
            const mimeType = matches[1];
            const base64Data = matches[2];

            const stream = new ReadableStream({
                start(controller) {
                    const sendChunk = (data: object) => {
                        // Gemini 的流是一个 JSON 数组，每个元素是一个响应对象
                        // 但为了简单起见，我们模拟 Cherry Studio 解析器能处理的单个对象流
                        const chunkString = `${JSON.stringify(data)}\n`;
                        controller.enqueue(new TextEncoder().encode(chunkString));
                    };

                    // ========================= 【GeminiAPIClient.ts 逻辑级修复】 =========================
                    // 构建一个能被 GeminiAPIClient.ts 的 `transform` 函数正确解析的 chunk
                    const geminiResponseChunk = {
                        candidates: [
                            {
                                content: {
                                    role: "model",
                                    parts: [
                                        // 核心：发送一个带有 inlineData 的 part
                                        {
                                            inlineData: {
                                                mimeType: mimeType,
                                                data: base64Data
                                            }
                                        }
                                    ]
                                }
                            }
                        ]
                    };
                    sendChunk(geminiResponseChunk);
                    console.log("🚀 Sent: Gemini-compatible image chunk");
                    
                    // --- 发送一个带有 finishReason 的结束块 ---
                    const finishChunk = {
                        candidates: [
                            {
                                finishReason: "STOP",
                                content: { role: "model", parts: [] } // content 和 parts 可以是空的
                            }
                        ],
                        usageMetadata: { promptTokenCount: 50, totalTokenCount: 800 }
                    };
                    sendChunk(finishChunk);
                    console.log("✅ Sent: Gemini-compatible finish chunk");
                    
                    controller.close();
                    // ===========================================================================
                }
            });

            // Gemini 流的 content-type 可能是 application/json
            return new Response(stream, {
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });

        } catch (error) {
            console.error("Error in Gemini handler:", error);
            return createJsonErrorResponse(error.message || "An unknown error occurred", 500);
        }
    }
    
    // ... [你的 Web UI 和其他 OpenAI 路由保持不变，以防万一] ...
    if (pathname === "/v1/chat/completions") { /* ... */ }
    if (pathname === "/generate") { /* ... */ }
    return serveDir(req, { fsRoot: "static", urlRoot: "", showDirListing: true, enableCors: true });
});
