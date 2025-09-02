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
async function callOpenRouter(messages: any[], apiKey: string): Promise<{ type: 'image' | 'text'; content: string }> {
    if (!apiKey) { throw new Error("callOpenRouter received an empty apiKey."); }
    
    const openrouterPayload = {
        model: "google/gemini-2.5-flash-image-preview:free",
        messages: messages,
    };
    console.log("Sending SMARTLY EXTRACTED payload to OpenRouter:", JSON.stringify(openrouterPayload, null, 2));

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

    if (message?.images?.[0]?.image_url?.url) {
        return { type: 'image', content: message.images[0].image_url.url };
    }
    if (typeof message?.content === 'string' && message.content.startsWith('data:image/')) {
        return { type: 'image', content: message.content };
    }
    if (typeof message?.content === 'string' && message.content.trim() !== '') {
        return { type: 'text', content: message.content };
    }
    return { type: 'text', content: "[模型没有返回有效内容，可能是由于上下文过长或内容限制。请尝试简化问题或开启新的会话。]" };
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

            // ========================= 【智能提取最终轮对话】 =========================
            const fullHistory = geminiRequest.contents;
            const lastUserMessageIndex = fullHistory.findLastIndex((msg: any) => msg.role === 'user');
            
            let relevantHistory = [];
            if (lastUserMessageIndex !== -1) {
                // 如果找到了最后一条用户消息
                const lastUserMessage = fullHistory[lastUserMessageIndex];
                
                // 寻找它之前的最后一条模型消息
                let lastModelMessageIndex = -1;
                for(let i = lastUserMessageIndex - 1; i >= 0; i--) {
                    if (fullHistory[i].role === 'model') {
                        lastModelMessageIndex = i;
                        break;
                    }
                }

                if (lastModelMessageIndex !== -1) {
                     // 如果找到了模型消息，就提取模型和用户消息
                    relevantHistory = fullHistory.slice(lastModelMessageIndex, lastUserMessageIndex + 1);
                } else {
                    // 如果没找到模型消息（比如是第一轮对话），就只提取用户消息
                    relevantHistory = [lastUserMessage];
                }

            } else {
                // 极端情况：如果一条用户消息都找不到，就返回错误
                return createJsonErrorResponse("No user message found in the conversation history.", 400);
            }
            
            const openrouterMessages = relevantHistory.map((geminiMsg: any) => {
                const contentParts = [];
                for (const part of geminiMsg.parts) {
                    if (part.text) { contentParts.push({ type: "text", text: part.text }); }
                    if (part.inlineData?.data) { contentParts.push({ type: "image_url", image_url: { url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}` } }); }
                }
                return { role: geminiMsg.role === 'model' ? 'assistant' : 'user', content: contentParts };
            });
            // ====================================================================
            
            const openRouterResult = await callOpenRouter(openrouterMessages, apiKey);
            
            // ... [后续的流式/非流式响应逻辑和上一版完全一样，无需修改] ...
            if (isStreaming) {
                const stream = new ReadableStream({
                    async start(controller) {
                        const sendChunk = (data: object) => { /* ... */ };
                        let textToStream = (openRouterResult.type === 'image') ? "好的，这是生成的图片：" : openRouterResult.content;
                        for (const char of textToStream.split('')) { /* ... */ }
                        if(openRouterResult.type === 'image'){ /* ... */ }
                        /* ... [发送结束块] ... */
                    }
                });
                return new Response(stream, { headers: { "Content-Type": "text/event-stream", /*...*/ } });
            } else { // 非流式
                const finalParts = [];
                if (openRouterResult.type === 'image') { /* ... */ }
                 else { finalParts.push({ text: openRouterResult.content }); }
                const responsePayload = { /* ... */ };
                return new Response(JSON.stringify(responsePayload), { headers: { "Content-Type": "application/json", /*...*/ } });
            }

        } catch (error) {
            console.error(`Error in Gemini handler:`, error);
            return createJsonErrorResponse(error.message || "An unknown error occurred", 500);
        }
    };
    
    if (pathname.includes(":streamGenerateContent")) { return await geminiHandler(true); }
    if (pathname.includes(":generateContent")) { return await geminiHandler(false); }
    if (pathname === "/generate") { /* ... */ }
    return serveDir(req, { fsRoot: "static", urlRoot: "" });
});
