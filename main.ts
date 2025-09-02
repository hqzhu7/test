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

// --- 核心业务逻辑：调用 OpenRouter (重构后) ---
// 它现在直接接收一个完整的、符合 OpenAI/OpenRouter 格式的消息数组
async function callOpenRouter(messages: any[], apiKey: string): Promise<string> {
    if (!apiKey) { throw new Error("callOpenRouter received an empty apiKey."); }
    
    const openrouterPayload = {
        model: "google/gemini-2.5-flash-image-preview:free",
        messages: messages, // 直接使用转换后的完整消息历史
    };
    console.log("Sending final payload with FULL HISTORY to OpenRouter...");
    // console.log(JSON.stringify(openrouterPayload, null, 2)); // 如果需要调试，可以取消这行注释

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
    
    if (req.method === 'OPTIONS') { /* ... CORS ... */ }

    const geminiHandler = async (isStreaming: boolean) => {
        try {
            const geminiRequest = await req.json();
            const authHeader = req.headers.get("Authorization");
            let apiKey = "";
            if (authHeader) { apiKey = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader; } 
            else { apiKey = req.headers.get("x-goog-api-key") || ""; }
            if (!apiKey) { return createJsonErrorResponse("API key is missing.", 401); }

            // ========================= 【历史记录修复】 =========================
            if (!geminiRequest.contents || geminiRequest.contents.length === 0) {
                return createJsonErrorResponse("Invalid Gemini request: 'contents' array is missing or empty", 400);
            }

            // 转换整个聊天记录
            const openrouterMessages = geminiRequest.contents.map((geminiMsg: any) => {
                const newContent = [];
                for (const part of geminiMsg.parts) {
                    if (part.text) {
                        newContent.push({ type: "text", text: part.text });
                    }
                    if (part.inlineData?.data) {
                        newContent.push({
                            type: "image_url",
                            image_url: {
                                url: `data:${part.inlineData.mimeType};base64,${part.inlineData.data}`
                            }
                        });
                    }
                }
                return {
                    // 转换 'model' 角色为 'assistant'
                    role: geminiMsg.role === 'model' ? 'assistant' : 'user',
                    content: newContent
                };
            });
            // ====================================================================
            
            const newImageBase64 = await callOpenRouter(openrouterMessages, apiKey);
            const matches = newImageBase64.match(/^data:(.+);base64,(.*)$/);
            if (!matches || matches.length !== 3) { throw new Error("Generated content is not a valid Base64 URL"); }
            const mimeType = matches[1];
            const base64Data = matches[2];

            if (isStreaming) {
                const stream = new ReadableStream({ /* ... 流式响应代码 ... */ });
                return new Response(stream, { headers: { "Content-Type": "text/event-stream", /*...*/ } });
            } else {
                const responsePayload = { /* ... 非流式响应代码 ... */ };
                return new Response(JSON.stringify(responsePayload), { headers: { "Content-Type": "application/json", /*...*/ } });
            }

        } catch (error) {
            console.error(`Error in Gemini ${isStreaming ? 'STREAMING' : 'NON-STREAM'} handler:`, error);
            return createJsonErrorResponse(error.message || "An unknown error occurred", 500);
        }
    };

    // --- 路由 1: Cherry Studio (Gemini, 流式) ---
    if (pathname.includes(":streamGenerateContent")) {
        // ... (这里的代码和下面非流式的几乎一样，只是返回方式不同)
        // 为了保持完整性，我们把完整的流式处理逻辑也放进来
        try {
            const geminiRequest = await req.json();
            const authHeader = req.headers.get("Authorization");
            let apiKey = "";
            if (authHeader) { apiKey = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader; } 
            else { apiKey = req.headers.get("x-goog-api-key") || ""; }
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
            
            const newImageBase64 = await callOpenRouter(openrouterMessages, apiKey);
            const matches = newImageBase64.match(/^data:(.+);base64,(.*)$/);
            if (!matches || matches.length !== 3) { throw new Error("Generated content is not a valid Base64 URL"); }
            const mimeType = matches[1];
            const base64Data = matches[2];

            const stream = new ReadableStream({
                async start(controller) {
                    const sendChunk = (data: object) => {
                        const chunkString = `data: ${JSON.stringify(data)}\n\n`;
                        controller.enqueue(new TextEncoder().encode(chunkString));
                    };
                    const introText = "好的，这是根据您的描述生成的图片：";
                    const textParts = introText.split('');
                    for (const char of textParts) {
                        sendChunk({ candidates: [{ content: { role: "model", parts: [{ text: char }] } }] });
                        await new Promise(resolve => setTimeout(resolve, 10));
                    }
                    sendChunk({ candidates: [{ content: { role: "model", parts: [{ inlineData: { mimeType: mimeType, data: base64Data } }] } }] });
                    sendChunk({ candidates: [{ finishReason: "STOP", content: { role: "model", parts: [] } }], usageMetadata: { promptTokenCount: 264, candidatesTokenCount: 1314, totalTokenCount: 1578 } });
                    controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
                    controller.close();
                }
            });
            return new Response(stream, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", "Connection": "keep-alive", "Access-Control-Allow-Origin": "*" } });
        } catch (error) {
            console.error("Error in Gemini STREAMING handler:", error);
            return createJsonErrorResponse(error.message || "An unknown error occurred", 500);
        }
    }

    // --- 路由 2: Cherry Studio (Gemini, 非流式) ---
    if (pathname.includes(":generateContent")) {
        try {
            const geminiRequest = await req.json();
            const authHeader = req.headers.get("Authorization");
            let apiKey = "";
            if (authHeader) { apiKey = authHeader.startsWith("Bearer ") ? authHeader.substring(7) : authHeader; } 
            else { apiKey = req.headers.get("x-goog-api-key") || ""; }
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
            
            const newImageBase64 = await callOpenRouter(openrouterMessages, apiKey);
            const matches = newImageBase64.match(/^data:(.+);base64,(.*)$/);
            if (!matches || matches.length !== 3) { throw new Error("Generated content is not a valid Base64 URL"); }
            const mimeType = matches[1];
            const base64Data = matches[2];

            const responsePayload = {
                candidates: [{
                    content: { role: "model", parts: [ { text: "好的，这是根据您的描述生成的图片：" }, { inlineData: { mimeType: mimeType, data: base64Data } } ] },
                    finishReason: "STOP", index: 0
                }],
                usageMetadata: { promptTokenCount: 264, candidatesTokenCount: 1314, totalTokenCount: 1578 }
            };
            
            return new Response(JSON.stringify(responsePayload), { headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
        } catch (error) {
            console.error("Error in Gemini NON-STREAM handler:", error);
            return createJsonErrorResponse(error.message || "An unknown error occurred", 500);
        }
    }

    // --- 路由 3: 你的 Web UI (nano banana) ---
    if (pathname === "/generate") {
        try {
            const { prompt, images, apikey } = await req.json();
            const openrouterApiKey = apikey || Deno.env.get("OPENROUTER_API_KEY");
            if (!openrouterApiKey) { return new Response(JSON.stringify({ error: "OpenRouter API key is not set." }), { status: 500 }); }
            if (!prompt || !images || !images.length) { return new Response(JSON.stringify({ error: "Prompt and images are required." }), { status: 400 }); }
            
            // Web UI 发送的是完整的 Base64 URL 数组，我们需要把它转换成 OpenAI 格式
            const webUiMessages = [ { role: "user", content: [ {type: "text", text: prompt}, ...images.map(img => ({type: "image_url", image_url: {url: img}})) ] } ];
            const generatedImageUrl = await callOpenRouter(webUiMessages, openrouterApiKey);
            
            return new Response(JSON.stringify({ imageUrl: generatedImageUrl }), { headers: { "Content-Type": "application/json" } });
        } catch (error) {
            console.error("Error handling /generate request:", error);
            return new Response(JSON.stringify({ error: error.message }), { status: 500 });
        }
    }

    // --- 路由 4: 静态文件服务 ---
    return serveDir(req, { fsRoot: "static", urlRoot: "", showDirListing: true, enableCors: true });
});
