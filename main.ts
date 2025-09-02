import { serve } from "https://deno.land/std@0.208.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.208.0/http/file_server.ts";

// 声明Deno全局变量
declare const Deno: {
    env: {
        get(key: string): string | undefined;
    };
};

serve(async (req) => {
    const pathname = new URL(req.url).pathname;

    if (pathname === "/v1/chat/completions") {
        try {
            const requestBody = await req.json();
            const apikey = req.headers.get("Authorization")?.replace("Bearer ", "");
            const messages = requestBody.messages;

            let prompt = "";
            let image = "";

            for (const message of messages) {
                if (message.role === "user") {
                    if (typeof message.content === "string") {
                        prompt = message.content;
                    } else if (Array.isArray(message.content)) {
                        for (const part of message.content) {
                            if (part.type === "text") {
                                prompt = part.text;
                            } else if (part.type === "image_url") {
                                image = part.image_url.url;
                            }
                        }
                    }
                }
            }
            
            const openrouterApiKey = apikey || Deno.env.get("OPENROUTER_API_KEY");

            if (!openrouterApiKey) {
                return new Response(JSON.stringify({ error: "OpenRouter API key is not set." }), { status: 500, headers: { "Content-Type": "application/json" } });
            }

            let contentPayload: any[] = [];

            if (image) {
                contentPayload.push({ type: "text", text: `根据我上传的图片，${prompt}` });
                contentPayload.push({ type: "image_url", image_url: { url: image } });
            } else {
                contentPayload.push({ type: "text", text: prompt });
            }

            const openrouterPayload = {
                model: requestBody.model || "google/gemini-2.5-flash-image-preview:free",
                messages: [
                    { role: "user", content: contentPayload },
                ],
                modalities: ["image"],
            };

            const apiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${openrouterApiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(openrouterPayload)
            });

            // 先读取响应文本
            const responseText = await apiResponse.text();
            
            if (!apiResponse.ok) {
                console.error("OpenRouter API error:", responseText);
                return new Response(JSON.stringify({ error: `OpenRouter API error: ${apiResponse.statusText}` }), { 
                    status: apiResponse.status, 
                    headers: { "Content-Type": "application/json" } 
                });
            }

            // 解析JSON
            const responseData = JSON.parse(responseText);
            console.log("OpenRouter Response:", JSON.stringify(responseData, null, 2));

            // 将 OpenRouter 响应转换为 OpenAI 格式（多模态格式）
            const openAIResponse = {
                id: responseData.id || '',
                object: "chat.completion",
                created: responseData.created || Math.floor(Date.now() / 1000),
                model: responseData.model || requestBody.model,
                choices: Array.isArray(responseData.choices) ? responseData.choices.map((choice: any) => {
                    let messageContent = choice.message?.content || "";
                    
                    // 检查是否有图片
                    if (choice.message?.images && choice.message.images.length > 0) {
                        const imageUrl = choice.message.images[0].image_url.url;
                        
                        // 构建多模态内容数组
                        const contentArray = [];
                        
                        // 如果有文本，先添加文本
                        if (messageContent) {
                            contentArray.push({
                                type: "text",
                                text: messageContent
                            });
                        }
                        
                        // 添加图片
                        contentArray.push({
                            type: "image_url",
                            image_url: {
                                url: imageUrl
                            }
                        });
                        
                        return {
                            index: choice.index || 0,
                            message: {
                                role: choice.message?.role || 'assistant',
                                content: contentArray,
                            },
                            finish_reason: choice.finish_reason || 'stop',
                        };
                    } else {
                        // 没有图片，返回普通文本
                        return {
                            index: choice.index || 0,
                            message: {
                                role: choice.message?.role || 'assistant',
                                content: messageContent,
                            },
                            finish_reason: choice.finish_reason || 'stop',
                        };
                    }
                }) : [],
                usage: responseData.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
            };

            return new Response(JSON.stringify(openAIResponse), {
                headers: { "Content-Type": "application/json" },
            });

        } catch (error) {
            console.error("Error handling /v1/chat/completions request:", error);
            return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }

    // 保留原有的 /generate 路径
    if (pathname === "/generate") {
        try {
            const { prompt, image, apikey } = await req.json();
            const openrouterApiKey = apikey || Deno.env.get("OPENROUTER_API_KEY");

            if (!openrouterApiKey) {
                return new Response(JSON.stringify({ error: "OpenRouter API key is not set." }), { status: 500, headers: { "Content-Type": "application/json" } });
            }

            let contentPayload: any[] = [];

            if (image) {
                contentPayload.push({ type: "text", text: `根据我上传的图片，${prompt}` });
                contentPayload.push({ type: "image_url", image_url: { url: image } });
            } else {
                contentPayload.push({ type: "text", text: prompt });
            }

            const openrouterPayload = {
                model: "google/gemini-2.5-flash-image-preview:free",
                messages: [
                    { role: "user", content: contentPayload },
                ],
                modalities: ["image"]
            };

            const apiResponse = await fetch("https://openrouter.ai/api/v1/chat/completions", {
                method: "POST",
                headers: {
                    "Authorization": `Bearer ${openrouterApiKey}`,
                    "Content-Type": "application/json"
                },
                body: JSON.stringify(openrouterPayload)
            });

            // 先读取响应文本
            const responseText = await apiResponse.text();
            
            if (!apiResponse.ok) {
                console.error("OpenRouter API error:", responseText);
                return new Response(JSON.stringify({ error: `OpenRouter API error: ${apiResponse.statusText}` }), { 
                    status: apiResponse.status, 
                    headers: { "Content-Type": "application/json" } 
                });
            }

            const responseData = JSON.parse(responseText);
            console.log("OpenRouter Response:", JSON.stringify(responseData, null, 2));

            const message = responseData.choices?.[0]?.message;

            if (!message || !message.content) {
                throw new Error("Invalid response structure from OpenRouter API. No content.");
            }

            const messageContent = responseData.choices[0].message.content;
            console.log("OpenRouter message content:", messageContent);

            let imageUrl = '';

            // 检查 messageContent 是否为 Base64 编码的图片 URL
            if (messageContent && messageContent.startsWith('data:image/')) {
                imageUrl = messageContent;
            } else if (responseData.choices[0].message.images && responseData.choices[0].message.images.length > 0) {
                // 尝试从 images 数组中获取图片 URL
                imageUrl = responseData.choices[0].message.images[0].image_url.url;
            }

            if (!imageUrl) {
                console.error("无法从 OpenRouter 响应中提取有效的图片 URL。返回内容：", messageContent);
                return new Response("无法生成图片，请尝试其他提示词或稍后再试。", { status: 500 });
            }

            console.log("最终解析的图片 URL:", imageUrl);

            return new Response(JSON.stringify({ imageUrl }), {
                headers: { "Content-Type": "application/json" },
            });

        } catch (error) {
            console.error("Error handling /generate request:", error);
            return new Response(JSON.stringify({ error: error.message }), { status: 500, headers: { "Content-Type": "application/json" } });
        }
    }

    return serveDir(req, {
        fsRoot: "static",
        urlRoot: "",
        showDirListing: true,
        enableCors: true,
    });
});