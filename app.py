"""
Fast Embedding Service using ONNX Runtime
~3-5x faster than PyTorch on CPU
"""
from flask import Flask, request, jsonify
import numpy as np
from optimum.onnxruntime import ORTModelForFeatureExtraction
from transformers import AutoTokenizer
import os

app = Flask(__name__)

# Model configuration
DEFAULT_MODEL = "intfloat/e5-small-v2"
model_name = os.environ.get("EMBEDDING_MODEL", DEFAULT_MODEL)
USE_E5_PREFIX = "e5" in model_name.lower()

print(f"Loading ONNX model: {model_name}")
print(f"Using E5 prefix mode: {USE_E5_PREFIX}")

# Load tokenizer and ONNX model (use cached if available)
tokenizer = AutoTokenizer.from_pretrained(model_name)

# Check for local ONNX model first, otherwise convert
import os.path
onnx_path = f"/app/cache/onnx/{model_name.replace('/', '_')}"
if os.path.exists(onnx_path):
    print(f"Loading cached ONNX model from {onnx_path}")
    model = ORTModelForFeatureExtraction.from_pretrained(onnx_path)
else:
    print(f"Converting {model_name} to ONNX (first run only)...")
    model = ORTModelForFeatureExtraction.from_pretrained(model_name, export=True)
    os.makedirs(onnx_path, exist_ok=True)
    model.save_pretrained(onnx_path)
    print(f"ONNX model cached at {onnx_path}")

print(f"ONNX model loaded successfully!")


def mean_pooling(token_embeddings, attention_mask):
    """Mean pooling to get sentence embeddings"""
    input_mask_expanded = np.expand_dims(attention_mask, -1).astype(np.float32)
    input_mask_expanded = np.broadcast_to(input_mask_expanded, token_embeddings.shape)
    sum_embeddings = np.sum(token_embeddings * input_mask_expanded, axis=1)
    sum_mask = np.clip(np.sum(input_mask_expanded, axis=1), a_min=1e-9, a_max=None)
    return sum_embeddings / sum_mask


def normalize(embeddings):
    """L2 normalize embeddings"""
    norms = np.linalg.norm(embeddings, axis=1, keepdims=True)
    return embeddings / np.clip(norms, a_min=1e-9, a_max=None)


def get_embeddings(sentences, prefix="passage"):
    """Generate embeddings using ONNX Runtime"""
    # Add E5 prefix only for E5 models
    if USE_E5_PREFIX:
        prefixed = [f"{prefix}: {s}" for s in sentences]
    else:
        prefixed = sentences
    
    # Tokenize
    encoded = tokenizer(
        prefixed, 
        padding=True, 
        truncation=True, 
        max_length=512, 
        return_tensors='np'
    )
    
    # Run inference
    outputs = model(
        input_ids=encoded['input_ids'],
        attention_mask=encoded['attention_mask']
    )
    
    # Pool and normalize
    embeddings = mean_pooling(outputs.last_hidden_state, encoded['attention_mask'])
    embeddings = normalize(embeddings)
    
    return embeddings


@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        "status": "healthy", 
        "model": model_name,
        "runtime": "onnx",
        "e5_prefix_mode": USE_E5_PREFIX
    })


@app.route('/embed', methods=['POST'])
def embed():
    """Generate embeddings for text"""
    data = request.get_json()
    
    if 'text' in data:
        texts = [data['text']]
    elif 'texts' in data:
        texts = data['texts']
    else:
        return jsonify({"error": "Missing 'text' or 'texts' in request body"}), 400
    
    prefix = data.get('prefix', 'passage')
    
    try:
        embeddings = get_embeddings(texts, prefix=prefix)
        return jsonify({
            "embeddings": embeddings.tolist(),
            "dimension": embeddings.shape[1],
            "count": len(texts)
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


@app.route('/similarity', methods=['POST'])
def similarity():
    """Calculate similarity between two texts"""
    data = request.get_json()
    
    if 'text1' not in data or 'text2' not in data:
        return jsonify({"error": "Missing 'text1' or 'text2' in request body"}), 400
    
    try:
        emb1 = get_embeddings([data['text1']], prefix="query")
        emb2 = get_embeddings([data['text2']], prefix="passage")
        similarity = float(np.dot(emb1[0], emb2[0]))
        
        return jsonify({
            "similarity": similarity,
            "text1": data['text1'],
            "text2": data['text2']
        })
    except Exception as e:
        return jsonify({"error": str(e)}), 500


if __name__ == '__main__':
    app.run(host='0.0.0.0', port=5000, threaded=True)
