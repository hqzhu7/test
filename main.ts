import { serve } from "https://deno.land/std@0.200.0/http/server.ts";
import { serveDir } from "https://deno.land/std@0.200.0/http/file_server.ts";
import { Buffer } from "https://deno.land/std@0.177.0/node/buffer.ts";

// --- 主服务逻辑 ---
serve(async (req) => {
    const pathname = new URL(req.url).pathname;
    
    // CORS 预检
    if (req.method === 'OPTIONS') {
        return new Response(null, {
            status: 204,
            headers: {
                "Access-Control-Allow-Origin": "*",
                "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Authorization, x-goog-api-key, x-goog-api-client", // 显式允许所有可能的头
            },
        });
    }

    // --- 调试 Gemini 请求头 ---
    if (pathname.includes(":streamGenerateContent")) {
        try {
            // ========================= 【终极调试】 =========================
            // 我们只做一件事：打印所有请求头，然后返回一个友好的错误。

            const headersObject = Object.fromEntries(req.headers.entries());
            
            console.log("==========================================================");
            console.log("=========== RECEIVED GEMINI REQUEST HEADERS ===========");
            console.log(JSON.stringify(headersObject, null, 2));
            console.log("==========================================================");

            // 消耗掉请求体，防止连接挂起
            await req.text();

            // 返回一个明确的、自定义的错误，告诉我们在前端检查日志
            const debugMessage = "DEBUG: Intercepted Gemini request. Please check your Deno Deploy logs to see the full request headers and find the API key.";
            
            // 模仿 Gemini 的错误格式返回
            const errorPayload = { error: { message: debugMessage, code: 400, status: "INVALID_ARGUMENT" } };
            return new Response(JSON.stringify(errorPayload), {
                status: 400, 
                headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
            });
            // ===============================================================

        } catch (error) {
            console.error("Error in DEBUG handler:", error);
            const errorPayload = { error: { message: error.message || "An unknown error occurred during debug.", code: 500, status: "INTERNAL" } };
            return new Response(JSON.stringify(errorPayload), { status: 500, headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" } });
        }
    }
    
    // 其他路由保持不变，但暂时不会被调用
    if (pathname === "/v1/chat/completions") { /* ... */ }
    if (pathname === "/generate") { /* ... */ }
    return serveDir(req, { fsRoot: "static", urlRoot: "", showDirListing: true, enableCors: true });
});
