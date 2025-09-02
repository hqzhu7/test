import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.200.0/http/file_server.ts";
import { Buffer } from "https://deno.land/std@0.177.0/node/buffer.ts";

// --- 辅助函数：生成错误 JSON 响应 ---
function createJsonErrorResponse(message: string, statusCode = 500) {
    const errorPayload = { error: { message, code: statusCode, status: "UNAVAILABLE" } };
    console.error("Replying with error:", JSON.stringify(errorPayload, null, 2));
    return new Response(JSON.stringify(errorPayload), {
        status: statusCode, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
    });
}

// --- 核心业务逻辑：调用 OpenRouter ---
async function callOpenRouter(prompt: string, imagesAsBase64: string[], apiKey: string): Promise<string> {
    if (!apiKey) {
        throw new Error("callOpenRouter received an empty apiKey.");
    }
    const contentPayload: any[] = [{ type: "text", text: prompt }];
    for (const base64Url of imagesAsBase64) {
        contentPayload.push({ type: "image_url", image_url: { url: base64Url } });
    }
    const openrouterPayload = {
        model: "google/gemini-2.5-flash-image-preview:free",
        messages: [{ role: "user", content: contentPayload }],
    };
    console.log("Sending payload to OpenRouter...");
    const apiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST", 
        headers: { 
            "Authorization": `Bearer ${apiKey}`, // <--- OpenRouter 需要 'Bearer' 前缀
            "Content-Type": "application/json" 
        },
        body: JSON.stringify(openrouterPayload)
    });
    if (!apiResponse.ok) {
        const errorBody = await apiResponse.text();
        throw new Error(`OpenRouter API error: Unauthorized - ${errorBody}`);
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
    if (pathname.includes(":streamGenerateContent")) {
        try {
            const geminiRequest = await req.json();
            
            // ========================= 【认证修复】 =========================
            const authHeader = req.headers.get("Authorization");
            let apiKey = "";

            if (authHeader) {
                // 同时处理 "Bearer sk-..." 和 "sk-..." 两种情况
                apiKey = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader;
            } else {
                // 如果没有 Authorization 头，再检查 x-goog-api-key
                apiKey = req.headers.get("x-goog-api-key") || "";
            }

            if (!apiKey) {
                return createJsonErrorResponse("API key is missing. Checked Authorization and x-goog-api-key headers.", 401);
            }
            console.log("🔑 Successfully extracted API key.");
            // ===============================================================

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

            const matches = newImageBase64.match(/^data:(.+);base64,(.*)$/);
            if (!matches || matches.length !== 3) { throw new Error("Generated content is not a valid Base64 URL"); }
            const mimeType = matches[1];
            const base64Data = matches[2];

            const stream = new ReadableStream({
                start(controller) {
                    const sendChunk = (data: object) => {
                        const chunkString = `${JSON.stringify(data)}\n`;
                        controller.enqueue(new TextEncoder().encode(chunkString));
                    };
                    
                    const geminiResponseChunk = {
                        candidates: [{
                            content: {
                                role: "model",
                                parts: [{
                                    inlineData: { mimeType: mimeType, data: base64Data }
                                }]
                            }
                        }]
                    };
                    sendChunk(geminiResponseChunk);
                    console.log("🚀 Sent: Gemini-compatible image chunk");
                    
                    const finishChunk = {
                        candidates: [{
                            finishReason: "STOP",
                            content: { role: "model", parts: [] }
                        }],
                        usageMetadata: { promptTokenCount: 50, totalTokenCount: 800 }
                    };
                    sendChunk(finishChunk);
                    console.log("✅ Sent: Gemini-compatible finish chunk");
                    
                    controller.close();
                }
            });

            return new Response(stream, {
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
            });

        } catch (error) {
            console.error("Error in Gemini handler:", error);
            return createJsonErrorResponse(error.message || "An unknown error occurred", 500);
        }
    }
    
    // ... [你的 Web UI 和其他 OpenAI 路由保持不变] ...
    if (pathname === "/v1/chat/completions") { /* ... */ }
    if (pathname === "/generate") { /* ... */ }
    return serveDir(req, { fsRoot: "static", urlRoot: "", showDirListing: true, enableCors: true });
});
