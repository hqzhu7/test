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
    if (!apiKey) { throw new Error("callOpenRouter received an empty apiKey."); }
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
        method: "POST", headers: { "Authorization": `Bearer ${apiKey}`, "Content-Type": "application/json" },
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
            const authHeader = req.headers.get("Authorization");
            let apiKey = "";
            if (authHeader) {
                apiKey = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader;
            } else {
                apiKey = req.headers.get("x-goog-api-key") || "";
            }
            if (!apiKey) { return createJsonErrorResponse("API key is missing.", 401); }

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

                    // ========================= 【真实观察级修复】 =========================
                    // 严格模仿你观察到的 "先文后图" 流程
                    
                    // --- 第 1 步：发送一个文本块 (Text Chunk) ---
                    // 这个 chunk 会创建消息容器和第一个文本块，内容就是你看到的那句描述。
                    const textChunk = {
                        candidates: [{
                            content: {
                                role: "model",
                                parts: [{ text: "好的，这是根据您的描述生成的图片：" }] // 模仿真实返回的文本
                            }
                        }]
                    };
                    sendChunk(textChunk);
                    console.log("🚀 Sent: Text Chunk (to create the container)");

                    // --- 第 2 步：发送一个图片块 (Image Chunk) ---
                    // 这个 chunk 会被正确处理，并作为第二个块附加到已存在的消息上。
                    const imageChunk = {
                        candidates: [{
                            content: {
                                role: "model", // role 必须有
                                parts: [{
                                    inlineData: { mimeType: mimeType, data: base64Data }
                                }]
                            }
                        }]
                    };
                    // 添加一个微小的延迟，模拟真实网络情况
                    setTimeout(() => {
                        sendChunk(imageChunk);
                        console.log("🖼️ Sent: Image Chunk");

                        // --- 第 3 步：发送结束块 ---
                        const finishChunk = {
                            candidates: [{
                                finishReason: "STOP",
                                content: { role: "model", parts: [] }
                            }],
                            usageMetadata: { promptTokenCount: 50, totalTokenCount: 800 }
                        };
                        sendChunk(finishChunk);
                        console.log("✅ Sent: Finish Chunk");
                        
                        controller.close();
                    }, 50); // 50毫秒延迟
                    // ===========================================================================
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
    
    // ... [其他路由如 /generate 和静态文件服务保持不变] ...
});
