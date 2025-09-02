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

// --- 核心业务逻辑：调用 OpenRouter (健壮版) ---
// 返回一个包含类型和内容的对象，可能是图片，也可能是文本
async function callOpenRouter(messages: any[], apiKey: string): Promise<{ type: 'image' | 'text'; content: string }> {
    if (!apiKey) { throw new Error("callOpenRouter received an empty apiKey."); }
    
    const openrouterPayload = {
        model: "google/gemini-2.5-flash-image-preview:free",
        messages: messages,
    };
    console.log("Sending final payload with FULL HISTORY to OpenRouter...");

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

    // --- 健壮性修复：检查多种可能的返回格式 ---
    // 1. 优先检查非标准的 `images` 字段
    if (message?.images?.[0]?.image_url?.url) {
        return { type: 'image', content: message.images[0].image_url.url };
    }
    // 2. 其次检查 `content` 字段是否是 Base64 图片
    if (typeof message?.content === 'string' && message.content.startsWith('data:image/')) {
        return { type: 'image', content: message.content };
    }
    // 3. 如果以上都不是，就认为它返回的是纯文本
    if (typeof message?.content === 'string') {
        return { type: 'text', content: message.content };
    }

    // 4. 如果连 content 都没有，就报错
    throw new Error("Could not extract a valid image OR text content from the OpenRouter API response.");
}

// --- 主服务逻辑 ---
serve(async (req) => {
    const pathname = new URL(req.url).pathname;
    
    if (req.method === 'OPTIONS') { /* ... */ }

    const geminiHandler = async (isStreaming: boolean) => {
        try {
            const geminiRequest = await req.json();
            let apiKey = req.headers.get("Authorization")?.replace("Bearer ", "") || req.headers.get("x-goog-api-key") || "";
            if (!apiKey) { return createJsonErrorResponse("API key is missing.", 401); }

            if (!geminiRequest.contents || geminiRequest.contents.length === 0) { return createJsonErrorResponse("Invalid Gemini request: 'contents' array is missing or empty", 400); }

            const openrouterMessages = geminiRequest.contents.map((geminiMsg: any) => {
                const contentParts = [];
                for (const part of geminiMsg.parts) {
                    if (part.text) { contentParts.push({ type: "text", text: part.text }); }
                    if (part.inlineData?.data) { contentParts.push({ type: "image_url", image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` } }); }
                }
                return { role: geminiMsg.role === 'model' ? 'assistant' : 'user', content: contentParts };
            });
            
            const openRouterResult = await callOpenRouter(openrouterMessages, apiKey);
            
            // --- 根据返回类型，构造不同的响应 ---
            const finalParts = [];
            if (openRouterResult.type === 'image') {
                const newImageBase64 = openRouterResult.content;
                const matches = newImageBase64.match(/^data:(.+);base64,(.*)$/);
                if (!matches || matches.length !== 3) { throw new Error("Generated content is not a valid Base64 URL"); }
                const mimeType = matches[1];
                const base64Data = matches[2];
                
                finalParts.push({ text: "好的，这是根据您的描述生成的图片：" });
                finalParts.push({ inlineData: { mimeType: mimeType, data: base64Data } });

            } else { // type === 'text'
                finalParts.push({ text: openRouterResult.content });
            }

            if (isStreaming) {
                const stream = new ReadableStream({
                    async start(controller) {
                        const sendChunk = (data: object) => {
                            const chunkString = `data: ${JSON.stringify(data)}\n\n`;
                            controller.enqueue(new TextEncoder().encode(chunkString));
                        };
                        
                        if(openRouterResult.type === 'image'){
                             // 图片的流式输出
                            const introText = "好的，这是根据您的描述生成的图片：";
                            for (const char of introText.split('')) {
                                sendChunk({ candidates: [{ content: { role: "model", parts: [{ text: char }] } }] });
                                await new Promise(resolve => setTimeout(resolve, 10));
                            }
                            const matches = openRouterResult.content.match(/^data:(.+);base64,(.*)$/);
                            const mimeType = matches[1]; const base64Data = matches[2];
                            sendChunk({ candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: mimeType, data: base64Data } }] } }] });
                        } else {
                            // 文本的流式输出
                            for (const char of openRouterResult.content.split('')) {
                                sendChunk({ candidates: [{ content: { role: "model", parts: [{ text: char }] } }] });
                                await new Promise(resolve => setTimeout(resolve, 10));
                            }
                        }

                        sendChunk({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [] } }], usageMetadata: { promptTokenCount: 264, candidatesTokenCount: 1314, totalTokenCount: 1578 } });
                        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                        controller.close();
                    }
                });
                return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" } });

            } else { // 非流式
                const responsePayload = {
                    candidates: [{
                        content: { role: "model", parts: finalParts },
                        finishReason: "STOP", index: 0
                    }],
                    usageMetadata: { promptTokenCount: 264, candidatesTokenCount: 1314, totalTokenCount: 1578 }
                };
                return new Response(JSON.stringify(responsePayload), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
            }

        } catch (error) {
            console.error(`Error in Gemini handler:`, error);
            return createJsonErrorResponse(error.message || "An unknown error occurred", 500);
        }
    };
    
    // --- 路由 ---
    if (pathname.includes(":streamGenerateContent")) { return await geminiHandler(true); }
    if (pathname.includes(":generateContent")) { return await geminiHandler(false); }
    if (pathname === "/generate") { /* ... */ }
    return serveDir({ fsRoot: "static", urlRoot: "" });
});
