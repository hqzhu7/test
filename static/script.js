document.addEventListener('DOMContentLoaded', () => {
    const uploadArea = document.querySelector('.upload-area');
    const fileInput = document.getElementById('image-upload');
    const thumbnailsContainer = document.getElementById('thumbnails-container');
    const promptInput = document.getElementById('prompt-input');
    const apiKeyInput = document.getElementById('api-key-input');
    const generateBtn = document.getElementById('generate-btn');
    const btnText = generateBtn.querySelector('.btn-text');
    const spinner = generateBtn.querySelector('.spinner');
    const resultContainer = document.getElementById('result-image-container');

    let selectedFiles = [];

    // 拖放功能
    ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, preventDefaults, false);
    });

    function preventDefaults(e) {
        e.preventDefault();
        e.stopPropagation();
    }

    ['dragenter', 'dragover'].forEach(eventName => {
        uploadArea.addEventListener(eventName, () => {
            uploadArea.classList.add('drag-over');
        });
    });

    ['dragleave', 'drop'].forEach(eventName => {
        uploadArea.addEventListener(eventName, () => {
            uploadArea.classList.remove('drag-over');
        });
    });

    uploadArea.addEventListener('drop', (e) => {
        const files = Array.from(e.dataTransfer.files).filter(file => file.type.startsWith('image/'));
        handleFiles(files);
    });

    fileInput.addEventListener('change', (e) => {
        const files = Array.from(e.target.files).filter(file => file.type.startsWith('image/'));
        handleFiles(files);
    });

    function handleFiles(files) {
        files.forEach(file => {
            if (!selectedFiles.some(f => f.name === file.name)) {
                selectedFiles.push(file);
                createThumbnail(file);
            }
        });
    }

    function createThumbnail(file) {
        const reader = new FileReader();
        reader.onload = (e) => {
            const wrapper = document.createElement('div');
            wrapper.className = 'thumbnail-wrapper';
            
            const img = document.createElement('img');
            img.src = e.target.result;
            img.alt = file.name;
            
            const removeBtn = document.createElement('button');
            removeBtn.className = 'remove-btn';
            removeBtn.innerHTML = '×';
            removeBtn.onclick = () => {
                selectedFiles = selectedFiles.filter(f => f.name !== file.name);
                wrapper.remove();
            };
            
            wrapper.appendChild(img);
            wrapper.appendChild(removeBtn);
            thumbnailsContainer.appendChild(wrapper);
        };
        reader.readAsDataURL(file);
    }

    generateBtn.addEventListener('click', async () => {
        if (!apiKeyInput.value.trim()) {
            alert('请输入 OpenRouter API 密钥');
            return;
        }

        if (selectedFiles.length === 0) {
            alert('请选择至少一张图片');
            return;
        }

        if (!promptInput.value.trim()) {
            alert('请输入提示词');
            return;
        }

        setLoading(true);

        try {
            // 处理第一张图片
            const file = selectedFiles[0];
            const base64Image = await fileToBase64(file);
            
            const response = await fetch('/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    model: "gpt-4o", // 可以根据需要调整模型
                    messages: [
                        {
                            role: "user",
                            content: [
                                { type: "text", text: promptInput.value },
                                { type: "image_url", image_url: { url: base64Image } }
                            ]
                        }
                    ],
                    max_tokens: 4000,
                    // 可以在这里添加其他 OpenAI API 参数，例如 temperature, top_p 等
                })
            });

            const data = await response.json();

            // 检查响应是否包含预期的 OpenAI 格式
            if (data.choices && data.choices.length > 0 && data.choices[0].message && data.choices[0].message.content) {
                const content = data.choices[0].message.content;
                // 尝试从 content 中提取图片 URL
                const imageUrlMatch = content.match(/\((https?:\/\/[^)]+\.(?:png|jpg|jpeg|gif|webp))\)/);
                if (imageUrlMatch && imageUrlMatch[1]) {
                    displayResult(imageUrlMatch[1]);
                } else if (content.startsWith('data:image')) {
                    // 如果 content 是 Base64 编码的图片数据 URL
                    displayResult(content);
                } else {
                    // 如果 content 是纯文本，显示为错误或提示
                    throw new Error('API 返回的不是图片 URL，而是文本内容：' + content);
                }
            } else if (data.error) {
                throw new Error(data.error.message || data.error);
            } else {
                throw new Error('API 返回的响应格式不符合预期。');
            }
        } catch (error) {
            alert('Error: ' + error.message);
            resultContainer.innerHTML = `<p>Error: ${error.message}</p>`;
        } finally {
            setLoading(false);
        }
    });

    function setLoading(isLoading) {
        generateBtn.disabled = isLoading;
        btnText.textContent = isLoading ? 'Generating...' : 'Generate';
        spinner.classList.toggle('hidden', !isLoading);
    }

    function fileToBase64(file) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
    }

    function displayResult(imageUrl) {
        resultContainer.innerHTML = '';
        const img = document.createElement('img');
        img.src = imageUrl;
        img.alt = 'Generated image';
        resultContainer.appendChild(img);
    }
});