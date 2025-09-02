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

    // --- 核心修改区域开始 ---
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
            // 1. 创建一个 Promise 数组，用于将所有选中的文件转换为 Base64
            const conversionPromises = selectedFiles.map(file => fileToBase64(file));
            
            // 2. 等待所有文件转换完成
            const base64Images = await Promise.all(conversionPromises);
            
            // 3. 发送包含 images 数组的请求
            const response = await fetch('/generate', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({
                    prompt: promptInput.value,
                    images: base64Images, // 注意：这里从 'image' 改为了 'images'，并且值是一个数组
                    apikey: apiKeyInput.value
                })
            });

            const data = await response.json();

            if (data.error) {
                throw new Error(data.error);
            }

            displayResult(data.imageUrl);
        } catch (error) {
            alert('Error: ' + error.message);
            resultContainer.innerHTML = `<p>Error: ${error.message}</p>`;
        } finally {
            setLoading(false);
        }
    });
    // --- 核心修改区域结束 ---

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
